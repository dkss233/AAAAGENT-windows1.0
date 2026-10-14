// @effect-diagnostics nodeBuiltinImport:off -- Temporary fixture files exercise native ownership checks.
import * as Assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "@effect/vitest";

import { resolveDshGatewayUrl } from "./DshGatewayResolver.ts";
import { DshTransportError } from "./DshHostProtocol.ts";
import { restrictPrivatePathSync } from "./NativePrivateFile.ts";

it("reads only a private, owned launcher file without returning the token in errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "t3-dsh-resolver-"));
  try {
    const log = join(dir, "web.log");
    const token = "fixture-secret";
    const url = `http://127.0.0.1:12345/?token=${token}`;
    await writeFile(log, `dsh web: ${url}\n`, { mode: 0o600 });
    restrictPrivatePathSync(log);
    Assert.equal(await resolveDshGatewayUrl(log), url);
    await Assert.rejects(resolveDshGatewayUrl("relative/web.log"), (error: unknown) =>
      error instanceof DshTransportError && error.code === "unavailable" && !error.message.includes(token));
    const link = join(dir, "link.log");
    await symlink(process.platform === "win32" ? dir : log, link, process.platform === "win32" ? "junction" : "file");
    await Assert.rejects(resolveDshGatewayUrl(link), (error: unknown) =>
      error instanceof DshTransportError && error.code === "unavailable" && !error.message.includes(token));
    const publicLog = join(dir, "public.log");
    await writeFile(publicLog, `dsh web: ${url}\n`, { mode: 0o644 });
    await Assert.rejects(resolveDshGatewayUrl(publicLog), (error: unknown) =>
      error instanceof DshTransportError && error.code === "unavailable" && !error.message.includes(token));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
