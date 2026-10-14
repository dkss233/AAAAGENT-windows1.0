// Browser consumption of I-owned engineering-voice.ts 0.1.0; no credentials or dispatch API.
export interface EngineeringVoiceTarget {
  readonly environmentId: string; readonly projectId: string; readonly threadId: string;
  readonly draftId: string | null; readonly captureEpoch: number;
}
interface EngineeringVoiceReceipt {
  readonly version: "0.1.0"; readonly inputId: string; readonly target: EngineeringVoiceTarget;
  readonly status: "submitted" | "completed" | "unknown" | "discarded"; readonly transcript?: string;
}
interface EngineeringVoiceRequest {
  readonly version: "0.1.0"; readonly inputId: string; readonly target: EngineeringVoiceTarget;
  readonly audio: { readonly wavBase64: string };
}

const VERSION = "0.1.0" as const;
const BASE = "/api/native-mount/voice";
export interface VoiceCapability {
  version: typeof VERSION; available: true; model: string;
  sampleRate: 16000; channels: 1; bits: 16; maxAudioSeconds: number;
}
export function sameVoiceTarget(a: EngineeringVoiceTarget, b: EngineeringVoiceTarget): boolean {
  return a.environmentId === b.environmentId && a.projectId === b.projectId &&
    a.threadId === b.threadId && a.draftId === b.draftId && a.captureEpoch === b.captureEpoch;
}
export async function voiceCapability(signal: AbortSignal, request: typeof fetch = fetch): Promise<VoiceCapability | null> {
  const response = await request(`${BASE}/capabilities`, { credentials: "same-origin", cache: "no-store", signal });
  if (!response.ok) return null;
  const value = await response.json();
  return value?.version === VERSION && value.available === true && typeof value.model === "string" && value.model.length > 0 &&
    value.sampleRate === 16000 && value.channels === 1 && value.bits === 16 &&
    Number.isFinite(value.maxAudioSeconds) && value.maxAudioSeconds > 0 && value.maxAudioSeconds <= 60 ? value : null;
}
function receipt(value: unknown, inputId: string, target: EngineeringVoiceTarget): EngineeringVoiceReceipt {
  const v = value as EngineeringVoiceReceipt | null;
  if (!v || v.version !== VERSION || v.inputId !== inputId || !v.target || !sameVoiceTarget(v.target, target) ||
    !["submitted", "completed", "unknown", "discarded"].includes(v.status) ||
    (v.status === "completed" ? typeof v.transcript !== "string" : v.transcript !== undefined)) throw Error("invalid_voice_receipt");
  return v;
}
function base64(bytes: Uint8Array): string {
  let encoded = "";
  for (let i = 0; i < bytes.length; i += 8192) encoded += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(encoded);
}
/** One capture owns one immutable request. Recovery only reads this inputId. */
export class EngineeringVoiceInput {
  readonly target: EngineeringVoiceTarget;
  private controller = new AbortController();
  private submitted: Promise<EngineeringVoiceReceipt> | null = null;
  private result: EngineeringVoiceReceipt | null = null;
  private cancelled = false;
  private applied = false;
  constructor(readonly inputId: string, target: EngineeringVoiceTarget, private request: typeof fetch = (url, init) => fetch(url, init)) {
    this.target = Object.freeze({ ...target });
  }
  private unknown(): EngineeringVoiceReceipt { return { version: VERSION, inputId: this.inputId, target: this.target, status: "unknown" }; }
  async read(): Promise<EngineeringVoiceReceipt> {
    try {
      const response = await this.request(`${BASE}/receipts/${encodeURIComponent(this.inputId)}?target=${encodeURIComponent(JSON.stringify(this.target))}`,
        { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(10_000) });
      this.result = response.ok ? receipt(await response.json(), this.inputId, this.target) : this.unknown();
    } catch { this.result = this.unknown(); }
    return this.result;
  }
  submit(wav: Uint8Array): Promise<EngineeringVoiceReceipt> {
    if (this.submitted) return this.submitted;
    if (this.cancelled) return Promise.resolve(this.unknown());
    const body: EngineeringVoiceRequest = { version: VERSION, inputId: this.inputId, target: this.target, audio: { wavBase64: base64(wav) } };
    this.submitted = (async () => {
      try {
        const response = await this.request(`${BASE}/transcribe`, { method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: this.controller.signal });
        if (!response.ok) throw Error("voice_submission_unconfirmed");
        this.result = receipt(await response.json(), this.inputId, this.target);
        if (this.result.status === "submitted" || this.result.status === "unknown") return this.read();
        return this.result;
      } catch { return this.read(); }
    })();
    return this.submitted;
  }
  cancel(): void {
    this.cancelled = true;
    this.controller.abort();
    // A submitted request may have reached ASR. Never turn cancellation into a replay.
    if (this.submitted) void this.read();
  }
  append(current: EngineeringVoiceTarget, edited: string, apply: (text: string) => void): boolean {
    if (this.cancelled || this.applied || this.result?.status !== "completed" || !sameVoiceTarget(this.target, current) || !edited.trim()) return false;
    this.applied = true;
    apply(edited);
    return true;
  }
}

/** Produce the service's actual wire format; preserve duration when resampling. */
export function pcm16Wav(samples: Float32Array, sampleRate: number): Uint8Array {
  if (!Number.isFinite(sampleRate) || sampleRate < 16000 || !samples.length || samples.length > sampleRate * 60) throw Error("voice_audio_invalid");
  const count = Math.floor(samples.length * 16000 / sampleRate);
  if (!count) throw Error("voice_audio_empty");
  const bytes = new Uint8Array(44 + count * 2), view = new DataView(bytes.buffer);
  const word = (at: number, text: string) => { for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i); };
  word(0, "RIFF"); view.setUint32(4, bytes.length - 8, true); word(8, "WAVE"); word(12, "fmt ");
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  word(36, "data"); view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    const start = i * sampleRate / 16000, end = (i + 1) * sampleRate / 16000;
    let sum = 0;
    for (let j = Math.floor(start); j < Math.ceil(end); j++) sum += (samples[j] ?? 0) * (Math.min(end, j + 1) - Math.max(start, j));
    const value = Math.max(-1, Math.min(1, sum / (end - start)));
    view.setInt16(44 + i * 2, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
  }
  return bytes;
}
export interface VoiceCapture { stop(): Promise<Uint8Array>; cancel(): void }
export async function recordVoice(signal: AbortSignal, maxSeconds: number, onLimit: () => void,
  media: Pick<MediaDevices, "getUserMedia"> = navigator.mediaDevices,
  Context: typeof AudioContext = AudioContext): Promise<VoiceCapture> {
  let stream: MediaStream | null = null, context: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null, processor: ScriptProcessorNode | null = null, mute: GainNode | null = null;
  let ended = false, total = 0;
  const chunks: Float32Array[] = [];
  const erase = () => { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; };
  const release = () => {
    signal.removeEventListener("abort", cancel);
    if (processor) processor.onaudioprocess = null;
    source?.disconnect(); processor?.disconnect(); mute?.disconnect();
    stream?.getTracks().forEach(track => track.stop());
    if (context && context.state !== "closed") void context.close().catch(() => {});
    stream = null; context = null; source = null; processor = null; mute = null;
  };
  const cancel = () => { ended = true; release(); erase(); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    if (signal.aborted) throw Error("voice_cancelled");
    stream = await media.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
    if (signal.aborted || ended) { release(); throw Error("voice_cancelled"); }
    context = new Context();
    source = context.createMediaStreamSource(stream); processor = context.createScriptProcessor(4096, 1, 1);
    mute = context.createGain(); mute.gain.value = 0;
    const rate = context.sampleRate, limit = Math.floor(rate * Math.min(60, maxSeconds));
    processor.onaudioprocess = event => {
      if (ended) return;
      const channels = event.inputBuffer.numberOfChannels, count = Math.min(event.inputBuffer.length, limit - total);
      if (count > 0) {
        const frame = new Float32Array(count);
        for (let c = 0; c < channels; c++) { const data = event.inputBuffer.getChannelData(c); for (let i = 0; i < count; i++) frame[i] = (frame[i] ?? 0) + (data[i] ?? 0) / channels; }
        chunks.push(frame); total += count;
      }
      if (total >= limit) { processor!.onaudioprocess = null; onLimit(); }
    };
    source.connect(processor); processor.connect(mute); mute.connect(context.destination);
    await context.resume();
    if (signal.aborted || ended) throw Error("voice_cancelled");
    return {
      cancel,
      async stop() {
        if (ended) throw Error("voice_cancelled");
        ended = true; release();
        try { const samples = new Float32Array(total); let offset = 0; for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
          try { return pcm16Wav(samples, rate); } finally { samples.fill(0); }
        } finally { erase(); }
      },
    };
  } catch (error) { cancel(); throw error; }
}
