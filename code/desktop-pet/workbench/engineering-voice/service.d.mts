import type { EngineeringAsrPort, EngineeringVoiceRequest, EngineeringVoiceReceipt, EngineeringVoiceTarget } from '../../contracts/engineering-voice.js';
export interface EngineeringVoiceService {
  capabilities(): { version: '0.1.0'; available: boolean; model: string; sampleRate: 16000; channels: 1; bits: 16; maxAudioSeconds: 60 };
  transcribe(request: EngineeringVoiceRequest, signal: AbortSignal): Promise<EngineeringVoiceReceipt>;
  receipt(inputId: string, target: EngineeringVoiceTarget): Promise<EngineeringVoiceReceipt>;
}
export function createEngineeringVoiceService(options: {
  directory: string;
  client: import('../../../workbench/integration/t3-http-client.mjs').T3HttpClient;
  gate: { targetCapability(threadId: string): Promise<unknown> };
  asr: EngineeringAsrPort;
}): EngineeringVoiceService;
