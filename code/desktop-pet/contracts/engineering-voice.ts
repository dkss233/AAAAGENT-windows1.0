/** Raw engineering speech returns to a captured draft; it never submits a turn. */
export const ENGINEERING_VOICE_VERSION = '0.1.0' as const;
export interface EngineeringVoiceTarget {
  readonly environmentId: string;
  readonly projectId: string;
  readonly threadId: string;
  readonly draftId: string | null;
  readonly captureEpoch: number;
}
export interface EngineeringVoiceRequest {
  readonly version: typeof ENGINEERING_VOICE_VERSION;
  readonly inputId: string;
  readonly target: EngineeringVoiceTarget;
  readonly audio: { readonly wavBase64: string };
}
export interface EngineeringVoiceReceipt {
  readonly version: typeof ENGINEERING_VOICE_VERSION;
  readonly inputId: string;
  readonly target: EngineeringVoiceTarget;
  readonly status: 'submitted' | 'completed' | 'unknown' | 'discarded';
  readonly transcript?: string;
}
/** Uses the existing ASR transport, authorization and accounting; no companion turn. */
export interface EngineeringAsrPort {
  readonly model: string;
  transcribe(inputId: string, wav: Uint8Array, signal: AbortSignal): Promise<string>;
}
