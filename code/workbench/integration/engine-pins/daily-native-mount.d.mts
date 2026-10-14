import type { WorkbenchNativeBrowserPort } from '../../../desktop-pet/contracts/workbench.js';
export interface DailyNativeMount extends WorkbenchNativeBrowserPort {
  readonly origin: string;
  audit(): unknown;
  close(): Promise<void>;
  independentGroupAvailable(): boolean;
  registerIndependentGroup(input: unknown): Promise<unknown>;
  readIndependentGroupRegistration(scope: { environmentId: string; projectId: string }): Promise<unknown>;
}
export function verifyDailyNativeRenderer(projectRoot: string, runtimeFiles: Readonly<Record<string, string>>): Promise<string>;
export function startDailyNativeMount(options: {
  projectRoot: string; runtimeFiles: Readonly<Record<string,string>>;
  runtimeSourceDir: string; nodeExecutable: string; managementOrigin: string; managementToken: string;
  service: { start(): Promise<{ origin: string; accessToken: string }> };
  client: import('../t3-http-client.mjs').T3HttpClient;
  presentationReadPaths?: readonly string[];
  codexHome?: string;
  engineeringAsr?: import('../../../desktop-pet/contracts/engineering-voice.js').EngineeringAsrPort;
}): Promise<DailyNativeMount>;
