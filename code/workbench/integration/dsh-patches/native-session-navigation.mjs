import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

/**
 * Pinned hashes of the published DSH browser bundle and its session-controller client.
 *
 * Reference data only: entry navigation is delivered by the `@aaaagent/dsh-session-entry` client plugin
 * (code/desktop-pet/plugins/dsh-session-entry), so nothing patched DSH's bundle and there is no patched
 * hash to keep in sync when DSH is upgraded. The published hashes stay useful because they let the
 * runtime prove the installed bundle is exactly the released one.
 */
export const navigationSource = JSON.parse(readFileSync(new URL('./native-session-navigation-source.json', import.meta.url), 'utf8'));
export const sourceDigest = (bytes) => createHash('sha256').update(bytes).digest('hex');
