import { pathToFileURL } from "node:url";

type SharedSession = { kind: "native" } | { kind: "unavailable" } | { kind: "shared"; launchArgs: string };

export async function originalAppSharedSession(input: {
  binaryPath: string; homePath?: string; cwd: string; threadId: string; resumeCursor?: unknown;
}): Promise<SharedSession> {
  const suffix = "/artifacts/runtime/engine-bindings/codex";
  if (!input.binaryPath.endsWith(suffix) || !input.threadId.startsWith("import:codex:")) return { kind: "native" };
  try {
    const root = input.binaryPath.slice(0, -suffix.length);
    const moduleUrl = pathToFileURL(root + "/code/workbench/integration/codex-shared-connection.mjs").href;
    const integration = await import(/* @vite-ignore */ moduleUrl);
    return await integration.originalAppSharedSession(input);
  } catch { return { kind: "unavailable" }; }
}
