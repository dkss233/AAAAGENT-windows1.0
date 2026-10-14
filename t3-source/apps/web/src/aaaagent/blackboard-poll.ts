import type { BlackboardScope, IndependentBlackboardSnapshot } from "@t3tools/contracts";
import { validateBoard } from "./independent-blackboard";

export interface BlackboardReader {
  snapshot(scope: BlackboardScope, options: { signal: AbortSignal }): Promise<IndependentBlackboardSnapshot>;
  watchConnection(scope: BlackboardScope, change: (ready: boolean) => void): () => void;
}
export type BoardReadState = {
  snapshot: IndependentBlackboardSnapshot | null; fresh: boolean; loading: boolean;
  phase: "waiting" | "loading" | "current" | "unregistered" | "unavailable" | "paused";
};
export class BoardReadError extends Error {
  constructor(readonly status: number) { super("独立协作黑板暂不可读取。"); }
}
export const emptyBoardState = (): BoardReadState => ({ snapshot: null, fresh: false, loading: false, phase: "waiting" });

/** One visible project owns one bounded GET at a time and a 2-second settled timer. */
export function observeBoard(scope: BlackboardScope, reader: BlackboardReader,
  publish: (state: BoardReadState) => void, timers = {
    set: (action: () => void, ms: number) => setTimeout(action, ms),
    clear: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
  }) {
  let active = true, visible = false, ready = false, generation = 0;
  let timer: ReturnType<typeof setTimeout> | null = null, controller: AbortController | null = null;
  let state = emptyBoardState();
  const emit = (patch: Partial<BoardReadState>) => { state = { ...state, ...patch }; publish(state); };
  const cancel = () => {
    generation++; controller?.abort(); controller = null;
    if (timer !== null) timers.clear(timer); timer = null;
  };
  const read = () => {
    if (!active || !visible || !ready || controller !== null) return;
    if (timer !== null) timers.clear(timer); timer = null;
    const token = generation, current = new AbortController(); controller = current;
    emit({ loading: true, phase: state.fresh ? "current" : "loading" });
    void reader.snapshot(scope, { signal: current.signal }).then(snapshot => {
      if (!active || current.signal.aborted || token !== generation) return;
      validateBoard(snapshot, scope);
      if (state.snapshot && (snapshot.boardId !== state.snapshot.boardId || snapshot.revision < state.snapshot.revision))
        throw Error("独立协作来源或版本回退。");
      emit({ snapshot, fresh: true, loading: false, phase: "current" });
    }).catch(error => {
      if (!active || current.signal.aborted || token !== generation) return;
      const unregistered = error instanceof BoardReadError && error.status === 404;
      emit({ fresh: false, loading: false, phase: unregistered ? "unregistered" : "unavailable",
        ...(unregistered ? { snapshot: null } : {}) });
    }).finally(() => {
      if (!active || current.signal.aborted || token !== generation) return;
      controller = null;
      if (visible && ready) timer = timers.set(read, 2000);
    });
  };
  const unsubscribe = reader.watchConnection(scope, connected => {
    if (!active) return;
    cancel(); ready = connected;
    emit({ fresh: false, loading: false, phase: visible ? "waiting" : "paused" });
    read();
  });
  return {
    visible: (value: boolean) => {
      if (!active || visible === value) return;
      cancel(); visible = value;
      emit({ fresh: false, loading: false, phase: value ? "waiting" : "paused" }); read();
    },
    refresh: () => { if (active) { cancel(); read(); } },
    dispose: () => { active = false; cancel(); unsubscribe(); },
  };
}
