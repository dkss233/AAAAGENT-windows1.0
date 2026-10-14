interface RequestActivity {
  readonly kind: string;
  readonly payload: unknown;
  readonly turnId?: string | null;
}

/** Read the original persisted submission marker; only native resolved closes a request. */
export function submittedNativeRequests(activities: ReadonlyArray<RequestActivity>) {
  const approvals = new Set<string>();
  const userInputs = new Set<string>();
  for (const activity of activities) {
    if (!activity.payload || typeof activity.payload !== "object") continue;
    const payload = activity.payload as Record<string, unknown>;
    if (typeof payload.requestId !== "string" || !payload.requestId.startsWith("dsh:")) continue;
    const requests = activity.kind.startsWith("approval.") ? approvals : userInputs;
    if (activity.kind === "approval.resolved" || activity.kind === "user-input.resolved") {
      requests.delete(payload.requestId);
    } else if (activity.kind === "approval.requested" || activity.kind === "user-input.requested") {
      if (payload.responseSubmitted && typeof payload.responseSubmitted === "object") {
        requests.add(payload.requestId);
      } else {
        requests.delete(payload.requestId);
      }
    }
  }
  return { approvals, userInputs };
}
