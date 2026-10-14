export class T3LocalService {
  constructor(options: { sourceDir: string; nodeExecutable: string; baseDir: string; logFile: string; dshWebLogPath?: string; engineProjectRoot?: string });
  start(): Promise<{ readonly origin: string; readonly accessToken: string; readonly expiresAt: string;
    readonly sourceCommit: string; readonly pid: number }>;
  signProviderContextProof(payload: string): Promise<string>;
  openBrowser(target: { kind: 'home' | 'project' | 'task'; environmentId: string; t3ProjectId?: string;
    workspaceRoot?: string; threadId?: string; providerInstanceId?: string }): Promise<{ url: string; expiresAt: string }>;
  stop(): Promise<void>;
  stopBackground(): Promise<void>;
  status(): Promise<{ origin: string; pid: number; hostPid: number }>;
}
