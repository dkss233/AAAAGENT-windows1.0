// Node half of the session-entry plugin.
//
// The work happens in the browser: the pet only needs this package to be a valid Loader entry so the
// client half is discovered by dsh-client-modules' dsh.client scan. Registering anything on the host
// would give the pet a second, redundant way to move a session around.
export const name = 'aaaagent-session-entry';
export const inject = [];
export function apply() { /* client-only */ }
