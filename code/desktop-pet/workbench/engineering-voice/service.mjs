import { existsSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { isPrivateDirectorySync, restrictPrivatePathSync } from '../../dist/core/platform-files.js';
import { dirname, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { inspectPcmWav } from '../../dist/media/wav.js';
import { boardDigest, boardId, readPrivateBoardJson, writePrivateBoardJson } from '../independent-blackboard/registry.mjs';

export const ENGINEERING_VOICE_VERSION = '0.1.0';
const uuid = x => typeof x === 'string' && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(x);
const keys = (x, expected) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === expected.length && Object.keys(x).every(k => expected.includes(k));
const targetValid = t => keys(t,['environmentId','projectId','threadId','draftId','captureEpoch']) &&
  [t.environmentId,t.projectId,t.threadId].every(boardId) && (t.draftId === null || boardId(t.draftId)) && Number.isSafeInteger(t.captureEpoch) && t.captureEpoch > 0;
const publicReceipt = r => ({version:ENGINEERING_VOICE_VERSION,inputId:r.inputId,target:r.target,status:r.status,
  ...(r.status === 'completed' ? {transcript:r.transcript} : {})});

/** Private once-only ASR receipts; original T3 remains the sole engineering executor. */
export function createEngineeringVoiceService({directory,client,gate,asr}) {
  if (resolve(directory) !== directory || realpathSync(dirname(directory)) !== dirname(directory) ||
      !asr || typeof asr.transcribe !== 'function' || !boardId(asr.model) || !gate || typeof gate.targetCapability !== 'function') throw Error('engineering_voice_unavailable');
  if (!existsSync(directory)) { mkdirSync(directory,{mode:0o700}); restrictPrivatePathSync(directory); }
  const stat=lstatSync(directory);
  if (realpathSync(directory) !== directory || !isPrivateDirectorySync(directory)) throw Error('engineering_voice_private_state_required');
  const inflight = new Map();
  const file = inputId => join(directory,inputId+'.json');
  const load = inputId => {
    const saved=existsSync(file(inputId)) ? readPrivateBoardJson(file(inputId)) : null;
    if (saved && (saved.version !== ENGINEERING_VOICE_VERSION || saved.inputId !== inputId || !targetValid(saved.target) ||
        !/^[a-f0-9]{64}$/.test(saved.bodySha256) || !/^[a-f0-9]{64}$/.test(saved.originalSha256) ||
        !['submitted','completed','unknown','discarded'].includes(saved.status) ||
        saved.status === 'completed' && typeof saved.transcript !== 'string')) throw Error('engineering_voice_receipt_changed');
    return saved;
  };
  async function original(target) {
    if ((await client.environmentDescriptor()).environmentId !== target.environmentId) throw Error('engineering_voice_target_changed');
    const shell=await client.shellSnapshot(), project=shell.projects?.find(p => p.id === target.projectId && p.deletedAt == null);
    if (!project || !boardId(project.workspaceRoot)) throw Error('engineering_voice_project_unavailable');
    const exists=shell.threads?.some(t => t.id === target.threadId && t.deletedAt == null);
    if (target.draftId !== null) {
      if (exists) throw Error('engineering_voice_draft_promoted');
      return boardDigest([target,project.workspaceRoot,'new-draft']);
    }
    if (!exists) throw Error('engineering_voice_thread_unavailable');
    const {thread}=await client.threadSnapshot(target.threadId), capability=await gate.targetCapability(target.threadId);
    if (!thread || thread.id !== target.threadId || thread.projectId !== target.projectId || thread.deletedAt != null || thread.archivedAt != null ||
        !capability || capability.environmentId !== target.environmentId || capability.projectId !== target.projectId || capability.source !== 't3' || capability.readonly)
      throw Error('engineering_voice_thread_unavailable');
    return boardDigest([target,project.workspaceRoot,thread.worktreePath ?? null,thread.branch ?? null,
      thread.modelSelection,capability.providerInstanceId,capability.nativeSessionId]);
  }
  async function checked(saved) {
    if (saved.status === 'completed') {
      let same=false;try {same=await original(saved.target) === saved.originalSha256;} catch { /* Late results remain private. */ }
      if (!same) {saved.status='discarded';delete saved.transcript;writePrivateBoardJson(file(saved.inputId),saved);}
    }
    return publicReceipt(saved);
  }
  return {
    capabilities: () => ({version:ENGINEERING_VOICE_VERSION,available:true,model:asr.model,sampleRate:16000,channels:1,bits:16,maxAudioSeconds:60}),
    async receipt(inputId,target) {
      if (!uuid(inputId) || !targetValid(target)) throw Error('engineering_voice_invalid_request');
      const saved=load(inputId);
      if (!saved || boardDigest(saved.target) !== boardDigest(target)) throw Error('engineering_voice_receipt_unavailable');
      if (saved.status === 'submitted' && !inflight.has(inputId)) {
        saved.status='unknown';writePrivateBoardJson(file(inputId),saved);
      }
      return checked(saved);
    },
    async transcribe(request,signal) {
      if (!keys(request,['version','inputId','target','audio']) || request.version !== ENGINEERING_VOICE_VERSION || !uuid(request.inputId) || !targetValid(request.target) ||
          !keys(request.audio,['wavBase64']) || typeof request.audio.wavBase64 !== 'string' || request.audio.wavBase64.length > 3*1024*1024 ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(request.audio.wavBase64)) throw Error('engineering_voice_invalid_request');
      const bytes=Buffer.from(request.audio.wavBase64,'base64');
      let wav;
      try {wav=inspectPcmWav(bytes);if (wav.sampleRate !== 16000 || wav.channels !== 1 || wav.bits !== 16 || wav.durationMs > 60000) throw Error();}
      catch {bytes.fill(0);throw Error('engineering_voice_pcm_required');}
      const target=structuredClone(request.target), inputId=request.inputId;
      const bodySha256=boardDigest([target,createHash('sha256').update(bytes).digest('hex')]);
      const pending=inflight.get(inputId);
      if (pending) {bytes.fill(0);if (pending.hash !== bodySha256) throw Error('engineering_voice_input_frozen');return pending.promise;}
      let existing;
      try {existing=load(inputId);} catch (error) {bytes.fill(0);throw error;}
      if (existing) {
        bytes.fill(0);
        if (existing.bodySha256 !== bodySha256) throw Error('engineering_voice_input_frozen');
        return this.receipt(inputId,target);
      }
      const promise=(async () => {
        let saved, claimed=false;
        try {
          signal.throwIfAborted();const originalSha256=await original(target);signal.throwIfAborted();
          saved={version:ENGINEERING_VOICE_VERSION,inputId,target,bodySha256,originalSha256,status:'submitted',submittedAt:new Date().toISOString()};
          writePrivateBoardJson(file(inputId),saved,true);
          claimed=true;
          const transcript=await asr.transcribe(inputId,bytes,signal);
          if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 60000) throw Error('engineering_voice_transcript_unavailable');
          let same=false;try {same=!signal.aborted && await original(target) === originalSha256;} catch { /* No retargeting. */ }
          saved.status=same?'completed':'discarded';if (same) saved.transcript=transcript;
          writePrivateBoardJson(file(inputId),saved);
          return publicReceipt(saved);
        } catch {
          if (claimed) {
            // A submitted request may have incurred a charge, including after browser cancellation.
            saved.status='unknown';delete saved.transcript;writePrivateBoardJson(file(inputId),saved);
            return publicReceipt(saved);
          }
          throw Error('engineering_voice_target_unavailable');
        } finally {bytes.fill(0);inflight.delete(inputId);}
      })();
      inflight.set(inputId,{hash:bodySha256,promise});
      return promise;
    },
  };
}
