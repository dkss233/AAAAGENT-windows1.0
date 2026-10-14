import type { OrchestrationThreadShell } from "@t3tools/contracts";

type StateInput = Pick<OrchestrationThreadShell,
  "session" | "latestTurn" | "nativeSessionObservation" | "settledAt" |
  "hasPendingApprovals" | "hasPendingUserInput" | "backgroundLiveness">;
type Category = "attention" | "working" | "settled" | "idle";

/** Display only: observing native work never changes the local runtime's ownership. */
export function nativeSessionState(thread: StateInput, nativeRead = false) {
  const observation = thread.nativeSessionObservation;
  const session = thread.session;
  const turn = thread.latestTurn;
  const localWorking = session?.status === "running" || session?.status === "starting" || !!thread.backgroundLiveness;
  const localEnded = !!thread.settledAt || session?.status === "stopped" || session?.status === "interrupted";
  // checkedAt is a synchronization time, never evidence that an old error is superseded.
  const turnAt = turn?.completedAt ?? turn?.startedAt ?? turn?.requestedAt;
  const priorLocalError = observation?.status === "ready" && !!session?.lastError &&
    !!turnAt && Number.isFinite(Date.parse(turnAt)) && Number.isFinite(Date.parse(session.updatedAt)) &&
    Date.parse(session.updatedAt) < Date.parse(turnAt);
  const localError = session?.status === "error" && !priorLocalError;
  const localStatus = thread.hasPendingApprovals ? "本地待审批" : thread.hasPendingUserInput ? "本地待回答" :
    localWorking ? "本地进行中" : localError ? "本地异常" : localEnded ? "本地已结束" : "本地空闲";
  let nativeStatus = "原生未核验";
  let nativeCategory: Category = "idle";
  let note = "";
  switch (observation?.status) {
    case "waiting_approval": nativeStatus = "原生待审批"; nativeCategory = "attention"; break;
    case "waiting_answer": nativeStatus = "原生待回答"; nativeCategory = "attention"; break;
    case "running": nativeStatus = "原生进行中"; nativeCategory = "working"; break;
    case "unknown":
      nativeStatus = "原生待核验"; nativeCategory = "attention"; note = "已同步内容保留。"; break;
    case "ready":
      nativeStatus = turn?.state === "error" ? "原生上轮异常" : turn?.state === "interrupted" ? "原生上轮中断" : "原生空闲";
      nativeCategory = turn?.state === "error" || turn?.state === "interrupted" ? "attention" : "idle";
      note = !turn ? "尚无已同步轮次。" : turn.state === "running" ? "轮次状态待核验。" : "";
      break;
  }
  let status: string;
  let category: Category;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) {
    status = thread.hasPendingApprovals ? "待审批" : "待回答"; category = "attention";
  } else if (localWorking) {
    status = "进行中"; category = "working";
  } else if (observation && ["waiting_approval", "waiting_answer", "running"].includes(observation.status)) {
    status = nativeStatus; category = nativeCategory;
  } else if (localError) {
    status = "本地异常"; category = "attention";
  } else if (observation) {
    status = nativeStatus; category = nativeCategory;
  } else {
    status = localEnded ? "本地已结束 · 原生未核验" : `${nativeRead ? "空闲" : "可继续"} · 原生未核验`;
    category = localEnded ? "settled" : "idle";
  }
  const errorNote = session?.lastError ?
    `${priorLocalError ? "本地上次异常" : "本地错误记录"}（${session.updatedAt}）。` : "";
  const description = `${localStatus}。${note}${errorNote}${observation ? `最近同步更新时间：${observation.checkedAt}` : "尚无原生观察记录。"}`;
  return { status, category, nativeStatus, localStatus, description,
    variant: nativeCategory === "attention" ? "warning" as const : "info" as const };
}
