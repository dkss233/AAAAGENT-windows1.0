import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../../../desktop-pet/node_modules/esbuild/lib/main.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const source = process.env.AAAAGENT_PROVIDER_SOURCE;
assert.ok(source, 'An exact prepared T3 source is required');
const evidence = join(root, 'artifacts/W0-I/codex-provider-status-57');
mkdirSync(evidence, { recursive: true });
const temporary = mkdtempSync(join(evidence, 'status-test-'));
const output = join(temporary, 'probe.mjs');
await build({
  stdin: {
    resolveDir: join(source, 'apps/server/src'), loader: 'ts', sourcefile: 'controlled-provider-probe.ts',
    contents: `
import * as Effect from 'effect/Effect';
import * as Fiber from 'effect/Fiber';
import * as Deferred from 'effect/Deferred';
import * as Ref from 'effect/Ref';
import * as TestClock from 'effect/testing/TestClock';
import {checkCodexProviderStatus} from './provider/Layers/CodexProvider.ts';
const mode = process.argv[2];
const program = Effect.gen(function* () {
  const started = yield* Deferred.make();
  const finalized = yield* Ref.make(false);
  let calls = 0;
  const probe = () => Effect.gen(function* () {
    calls++;
    yield* Deferred.succeed(started, undefined);
    if (mode === 'hung') yield* Effect.never;
    else yield* Effect.sleep('11 seconds');
    return {account: {account: mode === 'unauthenticated' ? null : {type: 'apiKey'}, requiresOpenaiAuth: true}, version: '0.160.0', models: [{slug:'controlled-model', name:'Controlled model', isCustom:false, capabilities:null}], skills:[]};
  }).pipe(Effect.ensuring(Ref.set(finalized, true)));
  const work = checkCodexProviderStatus({enabled: mode !== 'disabled', binaryPath:'controlled-probe', customModels:[]}, probe, {});
  let provider;
  if (mode === 'disabled') provider = yield* work;
  else {
    const fiber = yield* work.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* TestClock.adjust(mode === 'hung' ? '31 seconds' : '11 seconds');
    provider = yield* Fiber.join(fiber);
  }
  return {status:provider.status, authStatus:provider.auth.status, installed:provider.installed, version:provider.version, message:provider.message, models:provider.models.length, calls, finalized:yield* Ref.get(finalized)};
}).pipe(Effect.scoped, Effect.provide(TestClock.layer()));
console.log(JSON.stringify(await Effect.runPromise(program)));`,
  },
  bundle: true, format: 'esm', platform: 'node', target: 'node24', outfile: output,
  banner: { js: "import {createRequire as __createRequire} from 'node:module'; const require=__createRequire(import.meta.url);" },
  logLevel: 'silent',
});
const node = process.env.AAAAGENT_PROVIDER_NODE ?? process.execPath;
const probe = mode => JSON.parse(execFileSync(node, [output, mode], { encoding:'utf8', timeout:15000 }));

test('an authenticated full status probe may take over ten seconds', () => {
  const result = probe('authenticated');
  assert.equal(result.status, 'ready');
  assert.equal(result.authStatus, 'authenticated');
  assert.equal(result.version, '0.160.0');
  assert.equal(result.models, 1);
  assert.equal(result.finalized, true);
});

test('a slow unauthenticated probe still reports an authentication error', () => {
  const result = probe('unauthenticated');
  assert.equal(result.status, 'error');
  assert.equal(result.authStatus, 'unauthenticated');
  assert.match(result.message, /not authenticated/);
});

test('a hung provider remains bounded and cancels its scoped probe', () => {
  const result = probe('hung');
  assert.equal(result.status, 'error');
  assert.equal(result.authStatus, 'unknown');
  assert.match(result.message, /Timed out/);
  assert.equal(result.finalized, true);
});

test('disabled Codex does not start a status probe', () => {
  const result = probe('disabled');
  assert.equal(result.status, 'disabled');
  assert.equal(result.calls, 0);
});

process.on('exit', () => rmSync(temporary, { recursive:true, force:true }));
