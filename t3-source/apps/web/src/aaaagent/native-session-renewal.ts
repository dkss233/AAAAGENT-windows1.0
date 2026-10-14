const KEY = 'pet-management-session-v1';
export const NATIVE_SESSION_RENEW_LEAD_MS = 60_000;

/** Reuse this tab's existing local management authority. This never sends a task. */
export async function renewNativeMountSession(environmentId: string, signal: AbortSignal): Promise<boolean> {
  let token: string | null;
  try { token = sessionStorage.getItem(KEY); } catch { return false; }
  if (!token || !/^[a-f0-9]{64}$/.test(token) || location.protocol !== 'http:' || location.hostname !== '127.0.0.1') return false;
  const response = await fetch('/api/native-mount/session', {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal,
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}',
  });
  if (!response.ok) return false;
  const value = await response.json();
  return value?.apiVersion === 1 && value.environmentId === environmentId &&
    value.mountPath === '/native/' && ['native-read', 'native-operate'].includes(value.mode) &&
    Date.parse(value.expiresAt) > Date.now();
}

export function nativeSessionRenewDelay(expiresAt: number, now = Date.now()): number {
  // Short-lived replies still expire; do not create an immediate renewal loop.
  const remaining = expiresAt - now;
  return Math.max(1, Math.min(2_147_483_647, remaining - Math.min(NATIVE_SESSION_RENEW_LEAD_MS, remaining / 5)));
}
