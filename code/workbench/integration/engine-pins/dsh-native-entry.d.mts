export interface DshEntryBinding { sessionId: string; cwd: string; preset: string }
export function validateDshEntryBinding(binding: DshEntryBinding, listed: unknown, capability: number): DshEntryBinding;
export function dshSessionEntryUrl(origin: string, binding: DshEntryBinding, capability: number): string;
export function originalDshSessionEntry(context: { database: unknown; environmentId: string; rpc: { call(method: string, args: unknown): Promise<unknown> }; origin: string; capability: number }, query: unknown): Promise<string>;
export function resolveDshEntryFragment(hash: string, workspaces: unknown, sessions: unknown): { kind: 'none' | 'rejected' | 'session'; sessionId?: string; cwd?: string };
