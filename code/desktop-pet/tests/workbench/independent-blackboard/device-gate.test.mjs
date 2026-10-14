import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { PetDeviceGate } from '../../../../workbench/integration/independent-blackboard/pet-device-gate.mjs';

test('the actual protocol gate refuses capture and unapproved or foreign speech; current ordinary reply is admitted only once', () => {
  const root = mkdtempSync(join(tmpdir(), 'aaa-pet-device-')), now = Date.now(), gate = new PetDeviceGate(root, () => now);
  const scope = { characterId: 'companion', sessionId: 'synthetic', turnId: 'current', generation: 1 };
  const text = 'Synthetic ordinary input', play = { channel: 'play', requestId: 'current-play', tts: { scope } };
  const permit = { version: 1, kind: 'one-ordinary-reply-playback', maxPlays: 1, humanMessageId: 'controlled-authorization',
    inputSha256: createHash('sha256').update(text).digest('hex'), approvedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 60000).toISOString() };
  try {
    assert.equal(gate.admit({ channel: 'capture_start' }), false); assert.equal(gate.admit(play), false);
    gate.input({ channel: 'command', command: { type: 'submit_text', text, clientRequestId: 'input-1' } });
    gate.observe({ channel: 'event', event: { type: 'turn', input: { kind: 'text', scope, clientRequestId: 'input-1' } } });
    writeFileSync(join(root, 'speaker-permit.json'), JSON.stringify(permit), { mode: 0o600 });
    assert.equal(gate.admit(play), false);
    gate.observe({ channel: 'input_route', route: 'companion', scope });
    assert.equal(gate.admit({ ...play, tts: { scope: { ...scope, turnId: 'work-notice' } } }), false);
    writeFileSync(join(root, 'speaker-permit.json'), JSON.stringify({ ...permit, expiresAt: new Date(now).toISOString() }));
    assert.equal(gate.admit(play), false);
    writeFileSync(join(root, 'speaker-permit.json'), JSON.stringify(permit));
    assert.equal(gate.admit(play), true); assert.equal(gate.admit(play), false);
    assert.equal(new PetDeviceGate(root, () => now).admit(play), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
