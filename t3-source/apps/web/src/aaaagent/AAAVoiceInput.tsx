import { useEffect, useRef, useState } from "react";
import { useComposerDraftStore, type ComposerThreadTarget } from "../composerDraftStore";
import { randomUUID } from "~/lib/utils";
import { EngineeringVoiceInput, recordVoice, voiceCapability, type EngineeringVoiceTarget, type VoiceCapability, type VoiceCapture } from "./engineering-voice-client";

type Phase = "idle" | "preparing" | "recording" | "transcribing" | "review" | "unknown";
export function AAAVoiceInput({ environmentId, projectId, threadId, draftId, draftTarget }: {
  environmentId: string; projectId: string; threadId: string; draftId: string | null; draftTarget: ComposerThreadTarget;
}) {
  const epoch = useRef(0);
  const live = useRef({ environmentId, projectId, threadId, draftId, draftTarget });
  live.current = { environmentId, projectId, threadId, draftId, draftTarget };
  const active = useRef<{ input: EngineeringVoiceInput; capture: VoiceCapture | null; controller: AbortController; composer: ComposerThreadTarget } | null>(null);
  const [capability, setCapability] = useState<VoiceCapability | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [rawText, setRawText] = useState("");
  const [message, setMessage] = useState("正在检查语音输入是否可用。");
  const release = () => {
    const previous = active.current; active.current = null; epoch.current++;
    previous?.controller.abort(); previous?.capture?.cancel(); previous?.input.cancel();
  };
  useEffect(() => {
    const controller = new AbortController();
    setCapability(null);
    void voiceCapability(controller.signal).then(value => {
      if (!controller.signal.aborted) { setCapability(value); setMessage(value ? "停止录音后可检查原话，再放入草稿。" : "当前连接的语音输入不可用，请从控制台重新进入。"); }
    }).catch(() => { if (!controller.signal.aborted) setMessage("无法检查语音输入，请从控制台重新进入。"); });
    return () => { controller.abort(); release(); };
  }, [environmentId, projectId, threadId, draftId]);
  const isCurrent = (session: NonNullable<typeof active.current>) => active.current === session && !session.controller.signal.aborted &&
    session.input.target.captureEpoch === epoch.current &&
    session.input.target.environmentId === live.current.environmentId && session.input.target.projectId === live.current.projectId &&
    session.input.target.threadId === live.current.threadId && session.input.target.draftId === live.current.draftId;
  const show = (session: NonNullable<typeof active.current>, result: Awaited<ReturnType<EngineeringVoiceInput["read"]>>) => {
    if (!isCurrent(session)) return;
    if (result.status === "completed") { setRawText(result.transcript ?? ""); setPhase("review"); setMessage("识别原话已显示，可编辑后放入草稿。"); }
    else if (result.status === "discarded") { release(); setPhase("idle"); setMessage("录音目标已变化，这次原话未回填。"); }
    else { setPhase("unknown"); setMessage("转写结果尚未确认。请查询这次输入，录音不会自动重送。"); }
  };
  const stop = async () => {
    const session = active.current;
    if (!session?.capture || !isCurrent(session)) return;
    const capture = session.capture; session.capture = null; setPhase("transcribing"); setMessage("正在转写这次录音。");
    try { const wav = await capture.stop(); try { show(session, await session.input.submit(wav)); } finally { wav.fill(0); } }
    catch { if (isCurrent(session)) { release(); setPhase("idle"); setMessage("没有获得可用录音，请重新开始。"); } }
  };
  const begin = async () => {
    if (!capability || active.current) return;
    const target: EngineeringVoiceTarget = { environmentId, projectId, threadId, draftId, captureEpoch: ++epoch.current };
    const session = { input: new EngineeringVoiceInput(randomUUID(), target), capture: null as VoiceCapture | null, controller: new AbortController(), composer: draftTarget };
    active.current = session; setRawText(""); setPhase("preparing"); setMessage("正在准备麦克风。");
    try {
      const capture = await recordVoice(session.controller.signal, capability.maxAudioSeconds, () => { void stop(); });
      if (!isCurrent(session)) { capture.cancel(); return; }
      session.capture = capture; setPhase("recording"); setMessage(`正在录音，最长 ${capability.maxAudioSeconds} 秒。`);
    } catch { if (isCurrent(session)) { release(); setPhase("idle"); setMessage("麦克风无法使用或未获得权限，请检查浏览器设置。"); } }
  };
  const cancel = () => { release(); setPhase("idle"); setRawText(""); setMessage("这次输入已取消，草稿保持原样。"); };
  return <div className="aaa-voice-entry">
    <div className="aaa-voice-row"><button type="button" data-aaa-local-draft-action="true" aria-expanded={phase !== "idle"} disabled={!capability || phase !== "idle"} onClick={() => void begin()}>◉ 语音输入</button></div>
    {phase !== "idle" && <div className="aaa-voice-simulation" role="group" aria-label="工程语音输入">
      {phase === "recording" && <button type="button" data-aaa-local-draft-action="true" onClick={() => void stop()}>停止录音</button>}
      {phase === "review" && <>
        <label>识别原话<textarea aria-label="识别原话" value={rawText} onChange={event => setRawText(event.target.value)} /></label>
        <button type="button" data-aaa-local-draft-action="true" disabled={!rawText.trim()} onClick={() => {
          const session = active.current;
          if (!session || !isCurrent(session)) return;
          const target: EngineeringVoiceTarget = { ...live.current, captureEpoch: epoch.current };
          const store = useComposerDraftStore.getState();
          // A removed/promoted draft must never be recreated by a late backfill.
          if (draftId && (!store.getDraftSession(draftId as Parameters<typeof store.getDraftSession>[0]) || typeof session.composer !== "string" || session.composer !== draftId)) { cancel(); return; }
          if (session.input.append(target, rawText, text => {
            const previous = store.getComposerDraft(session.composer)?.prompt ?? "";
            store.setPrompt(session.composer, previous ? `${previous}\n${text}` : text);
          })) { release(); setRawText(""); setPhase("idle"); setMessage("原话已放入当前草稿，可继续编辑并点击原发送按钮。"); }
        }}>放入当前草稿</button>
      </>}
      {phase === "unknown" && <button type="button" data-aaa-local-draft-action="true" onClick={async () => {
        const session = active.current; if (!session || !isCurrent(session)) return;
        setPhase("transcribing"); show(session, await session.input.read());
      }}>查询这次输入</button>}
      <button type="button" data-aaa-local-draft-action="true" onClick={cancel}>取消语音输入</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
