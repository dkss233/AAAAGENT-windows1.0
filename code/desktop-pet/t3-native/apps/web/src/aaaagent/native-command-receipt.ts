export interface ThreadCommandIdentity {
  readonly commandId: string;
  readonly threadId: string;
}

export type ThreadCommandReceipt =
  | { readonly status: "accepted" | "rejected"; readonly sequence: number }
  | { readonly status: "unknown" }
  | { readonly status: "unavailable"; readonly authenticationExpired: boolean };

/** A missing receipt is still uncertain. Reading it never submits a command. */
export function decodeThreadCommandReceipt(
  value: unknown,
  identity: ThreadCommandIdentity,
): ThreadCommandReceipt {
  if (!value || typeof value !== "object") return { status: "unknown" };
  const receipt = value as Record<string, unknown>;
  if (
    receipt.commandId !== identity.commandId ||
    receipt.aggregateKind !== "thread" ||
    receipt.aggregateId !== identity.threadId ||
    (receipt.status !== "accepted" && receipt.status !== "rejected") ||
    typeof receipt.acceptedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.acceptedAt)) ||
    typeof receipt.resultSequence !== "number" ||
    !Number.isSafeInteger(receipt.resultSequence) ||
    receipt.resultSequence < 0
  ) return { status: "unknown" };
  return { status: receipt.status, sequence: receipt.resultSequence };
}

export async function readThreadCommandReceipt(
  identity: ThreadCommandIdentity,
  request: typeof fetch = fetch,
): Promise<ThreadCommandReceipt> {
  if (!identity.commandId.trim() || !identity.threadId.trim()) return { status: "unknown" };
  try {
    const response = await request(
      `/api/orchestration/commands/${encodeURIComponent(identity.commandId)}/receipt`,
      { method: "GET", credentials: "same-origin", cache: "no-store" },
    );
    if (!response.ok) {
      return { status: "unavailable", authenticationExpired: response.status === 401 || response.status === 403 };
    }
    return decodeThreadCommandReceipt(await response.json(), identity);
  } catch {
    return { status: "unavailable", authenticationExpired: false };
  }
}
