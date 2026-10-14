// @effect-diagnostics nodeBuiltinImport:off -- A bounded native read of the private Host launch log.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

import { DshTransportError } from "./DshHostProtocol.ts";
import { isPrivateFileSync } from "./NativePrivateFile.ts";

/** Keep the existing Host launch URL inside the server process. */
export async function resolveDshGatewayUrl(logPath: string | undefined): Promise<string> {
  if (!logPath || !isAbsolute(logPath) || logPath.includes("\0")) {
    throw new DshTransportError("unavailable");
  }
  try {
    const handle = await open(logPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile() || !isPrivateFileSync(logPath, info)) {
        throw new DshTransportError("unavailable");
      }
      const bytes = Buffer.alloc(8192);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const match = bytes.subarray(0, bytesRead).toString("utf8")
        .match(/dsh web:\s+(http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/);
      if (!match?.[1]) throw new DshTransportError("unavailable");
      return match[1];
    } finally { await handle.close(); }
  } catch {
    // Native filesystem errors may include the private path; never return it.
    throw new DshTransportError("unavailable");
  }
}
