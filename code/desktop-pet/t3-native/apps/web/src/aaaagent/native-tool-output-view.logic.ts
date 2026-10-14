import {
  nativeToolOutputKey,
  readNativeToolOutput,
  type NativeToolOutput,
  type NativeToolOutputTarget,
} from "./native-tool-output";

type Ref = { environmentId: string; threadId: string };
type Thread = { environmentId: string; id: string; projectId: string; modelSelection: { instanceId: string } };
type Project = { environmentId: string; id: string; workspaceRoot: string };
type Entry = { itemType?: string; toolLifecycleStatus?: string; turnId?: string | null; toolCallId?: string };

export function terminalNativeCommand(entry: Entry) {
  return entry.itemType === "command_execution" && entry.toolLifecycleStatus === "completed";
}
export function nativeToolOutputTarget(
  ref: Ref | null, thread: Thread | null, project: Project | null,
  entry: Entry, visibleWorkspaceRoot: string | undefined,
): NativeToolOutputTarget | null {
  if (!terminalNativeCommand(entry) || !ref || !thread || !project || !entry.turnId || !entry.toolCallId ||
      thread.environmentId !== ref.environmentId || thread.id !== ref.threadId ||
      project.environmentId !== ref.environmentId || project.id !== thread.projectId ||
      thread.modelSelection.instanceId !== "codex" || !project.workspaceRoot ||
      visibleWorkspaceRoot !== project.workspaceRoot) return null;
  return { environmentId: ref.environmentId, projectId: project.id, workspaceRoot: project.workspaceRoot,
    providerInstanceId: thread.modelSelection.instanceId, threadId: ref.threadId,
    turnId: entry.turnId, toolCallId: entry.toolCallId };
}

export type NativeToolOutputView = { key: string; phase: "loading" | "unavailable" } |
  { key: string; phase: "ready"; value: NativeToolOutput };

// Cancels both transport and acceptance of a late reply, even if a transport ignores abort.
export class NativeToolOutputReadState {
  private generation = 0;
  private controller: AbortController | null = null;
  constructor(private publish: (state: NativeToolOutputView) => void,
    private read = readNativeToolOutput) {}
  open(target: NativeToolOutputTarget) {
    this.cancel();
    const key = nativeToolOutputKey(target), generation = this.generation;
    const controller = new AbortController();this.controller = controller;
    this.publish({ key, phase: "loading" });
    const current = () => generation === this.generation && !controller.signal.aborted;
    void this.read(target, { signal: controller.signal }).then(value => {
      if (current()) this.publish({ key, phase: "ready", value });
    }, () => { if (current()) this.publish({ key, phase: "unavailable" }); });
  }
  cancel() { this.generation++;this.controller?.abort();this.controller = null; }
}
