import test from "node:test";
import assert from "node:assert/strict";
import { EngineeringVoiceInput, pcm16Wav, recordVoice, voiceCapability, type EngineeringVoiceTarget } from "./engineering-voice-client";
const target: EngineeringVoiceTarget = { environmentId: "env", projectId: "project", threadId: "thread", draftId: "draft", captureEpoch: 1 };
const id = "11111111-1111-4111-8111-111111111111";
const result = (status = "completed", transcript?: string) => ({ version: "0.1.0", inputId: id, target, status, ...(status === "completed" ? { transcript: transcript ?? "  Twelve 十二 English  " } : {}) });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const asFetch = (fn: (url: string, init: RequestInit) => Promise<Response>) => fn as unknown as typeof fetch;
const wav = () => pcm16Wav(new Float32Array(480).fill(0.25), 48000);

test("wire is 16 kHz mono PCM16 with duration, clipping and downsampling", () => {
  const bytes = pcm16Wav(new Float32Array([1, 1, 1, -1, -1, -1, 0.5, 0.5, 0.5]), 48000), view = new DataView(bytes.buffer);
  assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), "RIFF"); assert.equal(bytes.length, 50);
  assert.equal(view.getUint32(24, true), 16000); assert.equal(view.getUint16(22, true), 1); assert.equal(view.getUint16(34, true), 16);
  assert.deepEqual([0, 1, 2].map(i => view.getInt16(44 + i * 2, true)), [32767, -32768, 16384]);
  assert.throws(() => pcm16Wav(new Float32Array(), 48000));
  assert.throws(() => pcm16Wav(new Float32Array(16001 * 60), 16000));
});
test("one capture concurrently submits once and preserves raw and edited wording", async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const input = new EngineeringVoiceInput(id, target, asFetch(async (url, init) => { calls.push({ url, init }); return json(result()); }));
  const [a, b] = await Promise.all([input.submit(wav()), input.submit(wav())]);
  assert.deepEqual(a, b); assert.equal(a.transcript, "  Twelve 十二 English  "); assert.equal(calls.length, 1);
  const request = JSON.parse(calls[0]!.init.body as string); assert.deepEqual(request.target, target); assert.equal(request.inputId, id);
  assert.equal(calls[0]!.init.credentials, "same-origin");
  const draft = { prompt: "Original body", attachments: [{ id: "TXT" }], model: "original" };
  assert.equal(input.append(target, "  Edited 十二 English  ", text => { draft.prompt += "\n" + text; }), true);
  assert.equal(input.append(target, "repeat", () => { throw Error("duplicate append"); }), false);
  assert.deepEqual(draft, { prompt: "Original body\n  Edited 十二 English  ", attachments: [{ id: "TXT" }], model: "original" });
  assert.equal(calls.filter(c => /dispatch|send|turn|tts|companion/.test(c.url)).length, 0);
});
test("every exact target dimension prevents late backfill", async () => {
  for (const delta of [{ environmentId: "other" }, { projectId: "other" }, { threadId: "other" }, { draftId: null }, { captureEpoch: 2 }]) {
    const input = new EngineeringVoiceInput(id, target, asFetch(async () => json(result()))); await input.submit(wav());
    assert.equal(input.append({ ...target, ...delta }, "late", () => { throw Error("wrong draft"); }), false);
  }
});
test("unknown response only cold-reads the original ID and never submits again", async () => {
  const calls: { url: string; method: string }[] = [];
  const input = new EngineeringVoiceInput(id, target, asFetch(async (url, init) => { calls.push({ url, method: init.method ?? "GET" }); return json(result("unknown")); }));
  assert.equal((await input.submit(wav())).status, "unknown"); await input.read(); await input.submit(wav());
  assert.equal(calls.filter(c => c.method === "POST").length, 1); assert.equal(calls.filter(c => c.method === "GET").length, 2);
  for (const call of calls.filter(c => c.method === "GET")) { assert.ok(call.url.includes(`/receipts/${id}?`)); assert.deepEqual(JSON.parse(new URL(call.url, "http://localhost").searchParams.get("target")!), target); }
});
test("transport failure, invalid target and unauthenticated result stay unconfirmed", async () => {
  for (const outcome of [() => { throw Error("lost receipt"); }, () => json({ ...result(), target: { ...target, projectId: "wrong" } }), () => json({}, 403)]) {
    let posts = 0, reads = 0;
    const input = new EngineeringVoiceInput(id, target, asFetch(async (_url, init) => { if (init.method === "POST") { posts++; return outcome(); } reads++; return json({}, 404); }));
    assert.equal((await input.submit(wav())).status, "unknown"); assert.equal(input.append(target, "text", () => {}), false); assert.equal(posts, 1); assert.equal(reads, 1);
  }
});
test("cancel before submission makes zero requests; after submission cold-read cannot append", async () => {
  const early = new EngineeringVoiceInput(id, target, asFetch(async () => { throw Error("must not request"); })); early.cancel(); await early.submit(wav());
  let complete!: (v: Response) => void; let reads = 0, posts = 0;
  const late = new EngineeringVoiceInput(id, target, asFetch(async (_url, init) => {
    if (init.method === "POST") { posts++; return new Promise(resolve => { complete = resolve; }); } reads++; return json(result());
  }));
  const pending = late.submit(wav()); late.cancel(); complete(json(result())); await pending;
  await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(posts, 1); assert.equal(reads, 1);
  assert.equal(late.append(target, "late", () => { throw Error("cancelled backfill"); }), false);
});
test("submitted recovery may show original completed raw transcript without replay", async () => {
  let posts = 0, reads = 0;
  const input = new EngineeringVoiceInput(id, target, asFetch(async (_url, init) => { if (init.method === "POST") { posts++; return json(result("submitted")); } reads++; return json(result("completed", "  原话 zero  ")); }));
  assert.equal((await input.submit(wav())).transcript, "  原话 zero  "); assert.equal(posts, 1); assert.equal(reads, 1);
});
test("capability denies readonly, unavailable, mismatched format and oversized duration", async () => {
  const good = { version: "0.1.0", available: true, model: "asr", sampleRate: 16000, channels: 1, bits: 16, maxAudioSeconds: 60 };
  for (const [value, status] of [[good, 403], [good, 503], [{ ...good, available: false }, 200], [{ ...good, sampleRate: 48000 }, 200], [{ ...good, maxAudioSeconds: 61 }, 200]] as const)
    assert.equal(await voiceCapability(new AbortController().signal, asFetch(async () => json(value, status))), null);
  assert.deepEqual(await voiceCapability(new AbortController().signal, asFetch(async () => json(good))), good);
});
function device() {
  let trackStops = 0, closes = 0, disconnects = 0; let callback: ((event: AudioProcessingEvent) => void) | null = null;
  const node = () => ({ connect() {}, disconnect() { disconnects++; } });
  const processor = { ...node(), get onaudioprocess() { return callback; }, set onaudioprocess(value: ((event: AudioProcessingEvent) => void) | null) { callback = value; } };
  class Context {
    sampleRate = 48000; state = "running"; destination = {}; createMediaStreamSource() { return node(); } createScriptProcessor() { return processor; }
    createGain() { return { ...node(), gain: { value: 1 } }; } async resume() {} async close() { closes++; this.state = "closed"; }
  }
  const stream = { getTracks: () => [{ stop() { trackStops++; } }] } as unknown as MediaStream;
  return { Context: Context as unknown as typeof AudioContext, stream, stats: () => ({ trackStops, closes, disconnects }),
    frame(size = 4800) { callback?.({ inputBuffer: { numberOfChannels: 2, length: size, getChannelData: (channel: number) => new Float32Array(size).fill(channel ? 0.75 : 0.25) } } as unknown as AudioProcessingEvent); } };
}
test("stop mixes channels, releases all media and cancelled capture cannot stop again", async () => {
  const d = device(), controller = new AbortController();
  const capture = await recordVoice(controller.signal, 60, () => {}, { getUserMedia: async () => d.stream }, d.Context);
  d.frame(); const bytes = await capture.stop(); assert.equal(new DataView(bytes.buffer).getInt16(44, true), 16384);
  controller.abort(); capture.cancel(); assert.deepEqual(d.stats(), { trackStops: 1, closes: 1, disconnects: 3 });
  await assert.rejects(capture.stop());
});
test("unmount cancellation releases a late permission grant before opening AudioContext", async () => {
  const d = device(), controller = new AbortController(); let grant!: (stream: MediaStream) => void;
  const pending = recordVoice(controller.signal, 60, () => {}, { getUserMedia: () => new Promise(resolve => { grant = resolve; }) }, d.Context);
  controller.abort(); grant(d.stream); await assert.rejects(pending);
  assert.deepEqual(d.stats(), { trackStops: 1, closes: 0, disconnects: 0 });
});
test("audio setup failure releases tracks and context", async () => {
  const d = device(); class Broken extends d.Context { override async resume() { throw Error("audio failed"); } }
  await assert.rejects(recordVoice(new AbortController().signal, 60, () => {}, { getUserMedia: async () => d.stream }, Broken));
  assert.deepEqual(d.stats(), { trackStops: 1, closes: 1, disconnects: 3 });
});
test("capture limit ends at capability duration instead of buffering indefinitely", async () => {
  const d = device(); let limits = 0; const capture = await recordVoice(new AbortController().signal, 0.1, () => { limits++; }, { getUserMedia: async () => d.stream }, d.Context);
  d.frame(48000); d.frame(48000); const bytes = await capture.stop(); assert.equal(bytes.length, 44 + 1600 * 2); assert.equal(limits, 1);
});
