// @effect-diagnostics globalDate:off -- Pure provider timestamp conversion; no host-clock substitute.
import type { DshSessionRpc } from "./DshHostProtocol.ts";
import { nativeVisibleText, object, type NativeHistory, type NativeTurn } from "../../orchestration/NativeSessionHistory.ts";

/** Forward checkpoint in bounded event batches; each batch is read from the original, stable native head. */
export async function readDshHistoryChunk(rpc: DshSessionRpc, sessionId: string, cwd: string, preset: string, checkpoint?: unknown): Promise<NativeHistory> {
  const saved = object(checkpoint);
  const afterSeq = saved?.version === 2 && Number.isSafeInteger(saved?.afterSeq) && saved!.afterSeq >= -1 ? saved!.afterSeq as number : -1;
  const listed = rpc.nativeSummary ? { items: [await rpc.nativeSummary(sessionId)] } : object(await rpc.call("session/list", { _request: {} }));
  const matches = Array.isArray(listed?.items) ? listed.items.filter(r => r.sessionId === sessionId) : [];
  const row = matches[0], head = row?.projections?.asOfSeq;
  if (matches.length !== 1 || row.cwd !== cwd || row.projections?.values?.agentPreset !== preset || row.parentSessionId || row.origin === "subagent" || !Number.isSafeInteger(head) || head < afterSeq || typeof row.running !== "boolean") throw Error("Original DSH history scope changed");
  const throughSeq = Math.min(head, afterSeq + 256), events: any[] = [];
  let beforeSeq: number | undefined;
  while (throughSeq > afterSeq && (beforeSeq === undefined || beforeSeq > afterSeq + 1)) {
    const page = object(await rpc.call("session/page", { request: { address: { kind: "session", sessionId }, throughSeq, maxMessages: 16, ...(beforeSeq === undefined ? {} : { beforeSeq }) } }));
    const records = Array.isArray(page?.records) ? page.records.map(r => r?.type === "event" ? r.event : null) : [];
    if (!records.length || records.some((e, i) => !object(e) || !Number.isSafeInteger(e.seq) || e.seq < 0 || i > 0 && e.seq !== records[i - 1].seq + 1) || records.at(-1).seq !== (beforeSeq ?? throughSeq + 1) - 1) throw Error("Original DSH history page sequence changed");
    for (const event of records) if (event.seq > afterSeq) events.push(event);
    beforeSeq = records[0].seq;
  }
  events.sort((a, b) => a.seq - b.seq);
  if (events.length !== throughSeq - afterSeq || events.some((e, i) => e.seq !== afterSeq + 1 + i)) throw Error("Original DSH history checkpoint gap");
  const turns: NativeTurn[] = [];
  let active: NativeTurn | null = saved?.version === 2 && saved.activeTurn ? structuredClone(saved.activeTurn) : null;
  if (active) turns.push(active);
  const pending = new Map<string, string>(saved?.version === 2 && Array.isArray(saved.pending) ? saved.pending : []);
  const questionOwners = new Map<string, string>(saved?.version === 2 && Array.isArray(saved.questionOwners) ? saved.questionOwners : []);
  const questionView = object(row.projections?.values?.userQuestions);
  if (!Array.isArray(questionView?.active) || !Array.isArray(questionView?.settled)) throw Error("Original DSH question wire projection unavailable");
  const questions = questionView.active;
  if (!Array.isArray(questions) || questions.some(q => !object(q) || typeof q.callId !== "string" || !q.callId || !["open", "continued"].includes(q.state) || !Array.isArray(q.questions) || !q.questions.length || q.questions.some((item: any) => typeof item?.id !== "string" || !item.id || typeof item.question !== "string" || !item.question)) || new Set(questions.map(q => q.callId)).size !== questions.length) throw Error("Original DSH question projection unavailable");
  const stamp = (e: any) => {
    if (!Number.isSafeInteger(e.time) || e.time < 0) throw Error("Original DSH timestamp unavailable");
    return new Date(e.time).toISOString();
  };
  for (const e of events) {
    const d = e.data;
    if (e.type === "turn/start") {
      if (active || !Number.isSafeInteger(d?.turn) || d.turn < 1) throw Error("Original DSH turn identity conflict");
      active = { id: `turn:${d.turn}`, state: "running", startedAt: stamp(e), completedAt: null, messages: [] }; turns.push(active);
    } else if (e.type === "turn/end") {
      if (!active || active.id !== `turn:${d?.turn}`) throw Error("Original DSH terminal identity conflict");
      active.state = d.reason?.kind === "completed" ? "completed" : ["aborted", "interrupted"].includes(d.reason?.kind) ? "interrupted" : "error";
      active.completedAt = stamp(e); active = null; pending.clear();
    } else if (e.type === "tool/call" && d?.name === "ask_user_question") {
      if (!active || typeof d.callId !== "string" || !d.callId || questionOwners.has(d.callId)) throw Error("Original DSH question call identity conflict");
      questionOwners.set(d.callId, active.id);
    } else if (e.type === "user/message" && ["user", "user-question-reply"].includes(d?.source?.kind)) {
      if (!active || d.role !== "user" || typeof d.id !== "string") throw Error("Original DSH human message identity conflict");
      if (d.source.kind === "user") {
        if (typeof d.source.rpcId !== "string") throw Error("Original DSH prompt source identity conflict");
      } else {
        if (d.source.outcome !== "answered" || !questionOwners.has(d.source.callId)) throw Error("Original DSH question reply identity conflict");
        active.sourceTurnId = `dsh:${sessionId}:question:${d.source.callId}:${active.id.slice(5)}`;
      }
      active.messages.push({ id: `dsh:${sessionId}:${e.seq}`, role: "user", text: nativeVisibleText(d.content), createdAt: stamp(e), ...(d.source.kind === "user" ? { sourceCommandId: d.source.rpcId } : {}) });
    } else if (e.type === "assistant/message") {
      if (!active || active.id !== `turn:${d?.turn}` || d.message?.role !== "assistant" || typeof d.message.id !== "string") throw Error("Original DSH assistant identity conflict");
      const text = nativeVisibleText(d.message.content);
      if (text) active.messages.push({ id: `dsh:${sessionId}:${e.seq}`, role: "assistant", text, createdAt: stamp(e) });
    } else if (e.type === "approval/asked" && typeof d?.id === "string") {
      pending.set(d.id, "approval");
    } else if (e.type === "approval/decided" && typeof d?.id === "string") pending.delete(d.id);
  }
  const complete = throughSeq === head;
  if (complete && !!active !== row.running) throw Error("Original DSH lifecycle not yet consistent");
  if (complete) {
    for (const [id, kind] of pending) if (kind === "question") pending.delete(id);
    for (const question of questions) {
      if (!questionOwners.has(question.callId)) throw Error("Original DSH question owner identity conflict");
      pending.set(question.callId, "question");
    }
    // Only still-active question owners need to survive the bounded checkpoint.
    const activeIds = new Set(questions.map(q => q.callId));
    for (const id of questionOwners.keys()) if (!activeIds.has(id)) questionOwners.delete(id);
  }
  const observation = !complete ? "unknown" : pending.size ? [...pending.values()].some(k => k.includes("question")) ? "waiting_answer" : "waiting_approval" : active ? "running" : "ready";
  // The active turn is small and carried across batches; completed older turns are never copied into this checkpoint.
  return { nativeId: sessionId, cwd, turns, complete, observation, checkpoint: { version: 2, afterSeq: throughSeq, activeTurn: active, pending: [...pending], questionOwners: [...questionOwners] } };
}
