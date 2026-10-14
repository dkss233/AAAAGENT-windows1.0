// @effect-diagnostics nodeBuiltinImport:off -- Freeze immutable original upload bytes before the durable claim.
import { createHash } from "node:crypto";
import { constants, openSync, fstatSync, readFileSync, closeSync, realpathSync } from "node:fs";
import { type ChatAttachment } from "@t3tools/contracts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";

/** Read the original immutable upload IDs before any Host operation. Native
 * receipts are ephemeral; the durable T3 cursor instead freezes content hashes.
 */
export function readDshAttachments(attachmentsDir: string | undefined, attachments: readonly ChatAttachment[]) {
  return attachments.map(attachment => {
    if (!attachmentsDir || !["file", "image"].includes(attachment.type) || !attachment.sizeBytes ||
        attachment.sizeBytes > (attachment.type === "image" ? 10 : 50) * 1024 * 1024)
      throw Error("dsh_attachment_unavailable");
    const file = resolveAttachmentPath({ attachmentsDir, attachment });
    if (!file || realpathSync(file) !== file) throw Error("dsh_attachment_unavailable");
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.size !== attachment.sizeBytes) throw Error("dsh_attachment_unavailable");
      const bytes = readFileSync(fd), after = fstatSync(fd);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || bytes.length !== before.size)
        throw Error("dsh_attachment_changed");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      return { attachment, bytes, sha256 };
    } finally { closeSync(fd); }
  });
}

export function dshInputDigest(sessionId: string, requestId: string, text: string,
  files: ReturnType<typeof readDshAttachments>) {
  // Preserve original text-only cursor compatibility.
  const input = files.length ? [sessionId, requestId, text, files.map(({ attachment, sha256 }) =>
    ({ id: attachment.id, type: attachment.type, name: attachment.name, mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes, sha256 }))] : [sessionId, requestId, text];
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}
