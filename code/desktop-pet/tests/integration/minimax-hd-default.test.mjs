import test from 'node:test';
import assert from 'node:assert/strict';
import { firstUseBudget, firstUseCost, minimaxReleaseProfile } from '../../tools/minimax-first-synthesis.mjs';
import { selectedSettings } from '../../tools/install-minimax-default.mjs';

test('HD first use preserves historical unknown reservation and cannot fit the original budget', () => {
  const state = { limitMicros: 20_000_000, entries: [
    { status: 'settled', reservedMicros: 13_000_000, actualMicros: 12_104_369 },
    { status: 'unknown', reservedMicros: 19_600, actualMicros: null },
  ] }, before = structuredClone(state);
  assert.deepEqual(firstUseBudget(state, 350), { reservationMicros: 9_929_400, availableMicros: 7_876_031,
    requiredTotalMicros: 22_053_369, shortfallMicros: 2_053_369, withinCurrentBudget: false });
  assert.deepEqual(state, before);
  assert.throws(() => firstUseBudget({ ...state, limitMicros: 30_000_000 }, 350), /reviewed budget/);
  assert.throws(() => firstUseBudget(state, 200 / 10000), /reviewed budget/);
  const complete = { output: { base_resp: { status_code: 0 }, data: { status: 2 } }, usage: { characters: 51 } };
  assert.equal(firstUseCost(complete, 350), 9_917_850);
  assert.equal(firstUseCost(complete, 200), 9_910_200);
  assert.equal(firstUseCost({ ...complete, usage: undefined }, 350), null);
  assert.equal(firstUseCost({ ...complete, output: { base_resp: { status_code: 1000 } } }, 350), null);
});

test('HD candidate keeps the selected new voice distinct and changes only copied TTS settings', () => {
  const hd = minimaxReleaseProfile(true), turbo = minimaxReleaseProfile(false);
  assert.equal(hd.voiceId, 'DaniaCnHDa40702e4644a4edc934cf8782b583e1b');
  assert.notEqual(hd.voiceId, turbo.voiceId); assert.notEqual(hd.assetDirectory, turbo.assetDirectory);
  const original = { providers: { tts: { model: turbo.model, voice: turbo.voiceId }, dialogue: { model: 'existing' } }, context: { limit: 123 } };
  const before = structuredClone(original), selection = { model: hd.model, voice: hd.voiceId, characterMicros: 350 };
  const next = selectedSettings(original, selection);
  assert.deepEqual(original, before); assert.deepEqual(next.providers.tts, selection);
  assert.deepEqual(next.providers.dialogue, original.providers.dialogue); assert.deepEqual(next.context, original.context);
  next.providers.tts.voice = 'mutated-candidate'; assert.equal(selection.voice, hd.voiceId);
});
