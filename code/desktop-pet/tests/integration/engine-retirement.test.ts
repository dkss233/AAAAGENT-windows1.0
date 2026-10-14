import test from 'node:test';
import assert from 'node:assert/strict';
import { assertRuntimeRetirements } from '../../app/trial-config.js';

const old = 'artifacts/runtime/codex-0.156.0-aarch64-apple-darwin-6f7bdad25693/bin/codex';
const metadata = 'code/desktop-pet/dist/app/trial-backend.js';
const current = { [old]: 'old', [metadata]: 'current' };
const next = ['artifacts/runtime/engine-profile.json',
  'artifacts/runtime/engine-pin-54/t3-runtime/apps/server/dist/bin.mjs',
  'artifacts/runtime/engines-codex-0.160.0-dsh-0.2.0-rc.2-darwin-arm64/.aaaagent-engine.json', metadata];
test('exact engine transition removes obsolete engine dependency without permitting removal of product code/data', () => {
  assert.doesNotThrow(() => assertRuntimeRetirements(current, next, [old]));
  assert.throws(() => assertRuntimeRetirements(current, next, [metadata]), /exact replaced/);
  assert.throws(() => assertRuntimeRetirements(current, next.slice(1), [old]), /exact replaced/);
  assert.throws(() => assertRuntimeRetirements(current, [...next,old], [old]), /exact replaced/);
  assert.throws(() => assertRuntimeRetirements(current, next, [old,old]), /exact replaced/);
});

test('native read build replaces only registered generated assets with a fixed new mode receipt', () => {
  const prefix='code/desktop-pet/t3-native/apps/web/dist/';
  const assets={...current,[prefix+'index.html']:'index',[prefix+'assets/old.js']:'script',[prefix+'assets/old.js.map']:'map'};
  const paths=[prefix+'aaa-native-read-build.json',prefix+'assets/new.js'];
  assert.doesNotThrow(()=>assertRuntimeRetirements(assets,paths,[prefix+'assets/old.js',prefix+'assets/old.js.map']));
  for(const invalid of [[prefix+'index.html'],[metadata],[old],['data/desktop-pet/companion.sqlite'],[prefix+'assets/unregistered.js'],[prefix+'assets/../index.html'],[prefix+'assets/old.js',prefix+'assets/old.js']])
    assert.throws(()=>assertRuntimeRetirements(assets,paths,invalid));
  assert.throws(()=>assertRuntimeRetirements(assets,paths.slice(1),[prefix+'assets/old.js']));
  assert.throws(()=>assertRuntimeRetirements(assets,paths.slice(0,1),[prefix+'assets/old.js']));
  assert.throws(()=>assertRuntimeRetirements(assets,[...paths,prefix+'assets/old.js'],[prefix+'assets/old.js']));
});
