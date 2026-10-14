import { pathToFileURL } from "node:url";

type SharedSession = { kind: "native" } | { kind: "unavailable" } | { kind: "shared"; launchArgs: string };

export async function originalAppSharedSession(input: {
  binaryPath: string; homePath?: string; cwd: string; threadId: string; resumeCursor?: unknown;
}): Promise<SharedSession> {
  const suffix = "/artifacts/runtime/engine-bindings/codex";
  const normalizedBinary = input.binaryPath.replaceAll("\\", "/").replace(/\.cmd$/i, "");
  if (!normalizedBinary.endsWith(suffix) || !input.threadId.startsWith("import:codex:")) return { kind: "native" };
  // The desktop shared Unix transport has no verified Windows equivalent. Do not
  // create an independent writer for a session owned by the native App.
  if (process.platform === "win32") return { kind: "unavailable" };
  try {
    const root = input.binaryPath.slice(0, -suffix.length);
    const moduleUrl = pathToFileURL(root + "/code/workbench/integration/codex-shared-connection.mjs").href;
    const integration = await import(/* @vite-ignore */ moduleUrl);
    return await integration.originalAppSharedSession(input);
  } catch { return { kind: "unavailable" }; }
}
