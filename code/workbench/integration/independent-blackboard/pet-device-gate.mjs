import { constants, openSync, fstatSync, readFileSync, closeSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
/** Test instrumentation: retain the original backend/renderer and admit hardware output only once. */
export class PetDeviceGate {
  constructor(directory, now = Date.now) { this.directory = directory; this.now = now; this.inputs = new Map(); this.scopes = new Map(); this.companion = new Set(); }
  input(message) {
    if (message.channel === 'command' && message.command?.type === 'submit_text' && typeof message.command.clientRequestId === 'string')
      this.inputs.set(message.command.clientRequestId, digest(message.command.text));
  }
  observe(message) {
    if (message.channel === 'event' && message.event?.type === 'turn' && message.event.input?.kind === 'text')
      this.scopes.set(message.event.input.scope.turnId, this.inputs.get(message.event.input.clientRequestId));
    if (message.channel === 'input_route' && message.route === 'companion') this.companion.add(message.scope.turnId);
  }
  admit(message) {
    if (message.channel.startsWith('capture_')) return false;
    if (message.channel !== 'play') return true;
    try {
      const fd = openSync(resolve(this.directory, 'speaker-permit.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let permit;
      try {
        const info = fstatSync(fd);
        if (!info.isFile() || info.size > 8192 || info.mode & 0o077 || info.uid !== process.getuid()) return false;
        permit = JSON.parse(readFileSync(fd, 'utf8'));
      } finally { closeSync(fd); }
      const scope = message.tts.scope;
      if (permit.version !== 1 || permit.kind !== 'one-ordinary-reply-playback' || permit.maxPlays !== 1 ||
          typeof permit.humanMessageId !== 'string' || !permit.humanMessageId.trim() ||
          !Number.isFinite(Date.parse(permit.approvedAt)) || !Number.isFinite(Date.parse(permit.expiresAt)) ||
          Date.parse(permit.approvedAt) > this.now() || Date.parse(permit.expiresAt) <= this.now() ||
          Date.parse(permit.expiresAt) - Date.parse(permit.approvedAt) > 1800000 ||
          !this.companion.has(scope.turnId) || this.scopes.get(scope.turnId) !== permit.inputSha256) return false;
      const claim = openSync(resolve(this.directory, 'speaker-consumed.json'), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(claim, JSON.stringify({ permitSha256: digest(JSON.stringify(permit)), requestId: message.requestId, scope,
        admittedAt: new Date(this.now()).toISOString(), outcome: 'admitted-not-yet-verified' }) + '\n'); } finally { closeSync(claim); }
      return true;
    } catch { return false; }
  }
}
