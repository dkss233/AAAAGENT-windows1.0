export interface SharedCodexTransport {
  socketPath: string;
  desktopWebsocketUrl: string;
  providerLaunchArgs: string;
}
export function sharedCodexConnectionPath(root: string): string;
export function codexSharedTransport(homePath: string): SharedCodexTransport;
export interface SharedCodexCheckOptions {
  stat?: typeof import('node:fs').lstatSync;
  read?: typeof import('node:fs').readFileSync;
  realpath?: typeof import('node:fs').realpathSync;
  alive?: (pid: number) => boolean;
  uid?: number;
  nativeSessionId?: string;
}
export function inspectSharedCodexSocket(socketPath: string, options?: SharedCodexCheckOptions): {
  physicalPath: string; device: number; inode: number;
};
export function readCodexSharedConnection(root: string, codexHome: string, options?: SharedCodexCheckOptions):
  (SharedCodexTransport & { codexHome: string; serverPid: number; originalAppPid: number }) | null;

export type OriginalAppSharedSession =
  { kind: 'native' } | { kind: 'unavailable' } | { kind: 'shared'; launchArgs: string };
export function originalAppSharedSession(input: {
  binaryPath: string; homePath?: string; cwd: string; threadId: string;
  resumeCursor?: { threadId?: string };
}): Promise<OriginalAppSharedSession>;
