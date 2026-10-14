export interface EngineProfile {
  version: 1; projectRoot: string; runtimeRoot: string; home: string; dshWebLog: string; codexLauncher: string; dshPresetOverlay: string; codexHome: string; dshHome: string;
  runtime: { root: string; nodeExecutable: string; codexExecutable: string; dshEntrypoint: string; inventorySha256: string; fileCount: number };
}
export function readEngineProfile(projectRoot: string): EngineProfile | undefined;
export function installEngineProfile(projectRoot: string, runtimeRoot: string, t3Home: string,
  options?: { codexHome?: string; dshHome?: string; preserveSettings?: boolean }): EngineProfile;
export function verifyT3EngineSettings(t3Home: string, profile: EngineProfile): void;
export function codexLauncher(runtime: EngineProfile['runtime'], home: string, codexHome?: string): string;
export function presetOverlay(projectRoot: string, home: string, nodeExecutable: string, dshHome?: string): string;
export function projectT3EngineSettings(original: Record<string, any>, profile: EngineProfile): Record<string, any>;
