import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JellyfishRenderer, createPresentationPreview } from '../../desktop/live2d-unavailable.mjs';

test('public desktop bundles exclude missing private Live2D inputs and reject preview readiness', async () => {
  const prefix = join(tmpdir(), 'aaaagent-public-desktop-');
  const fixture = await mkdtemp(prefix);
  try {
    // Only build logic and the explicit unavailable module enter this fixture.
    // Never copy a model, preset catalog or SDK from the local installation.
    for (const name of ['optional-live2d-build.mjs', 'live2d-unavailable.mjs']) {
      await copyFile(new URL('../../desktop/' + name, import.meta.url), join(fixture, name));
    }
    const { optionalLive2dBuild } = await import(pathToFileURL(join(fixture, 'optional-live2d-build.mjs')).href);
    const selection = await optionalLive2dBuild();
    assert.equal(selection.available, false);
    const desktop = await build({
      entryPoints: [fileURLToPath(new URL('../../desktop/main.mjs', import.meta.url))],
      bundle: true, format: 'esm', platform: 'browser', target: 'safari17', write: false,
      metafile: true, plugins: selection.plugins,
    });
    const preview = await build({
      entryPoints: [selection.previewEntry], bundle: true, format: 'esm', platform: 'browser',
      write: false, metafile: true,
    });
    for (const result of [desktop, preview]) {
      assert.ok(Object.keys(result.metafile.inputs).some(input => input.endsWith('live2d-unavailable.mjs')));
      assert.ok(Object.keys(result.metafile.inputs).every(input => !/vendor[\\/]cubism|assets[\\/]jellyfish|cubism-renderer\.mjs/.test(input)));
    }
    assert.ok(Object.keys(desktop.metafile.inputs).some(input => input.endsWith('video-pet-renderer.mjs')));
    const renderer = new JellyfishRenderer();
    assert.equal(renderer.ready, false);
    await assert.rejects(renderer.load(), { code: 'LIVE2D_RESOURCES_MISSING' });
    renderer.dispose();
    assert.equal(renderer.ready, false);
    const statuses = [];
    await assert.rejects(createPresentationPreview({ onStatus: value => statuses.push(value) }), { code: 'LIVE2D_RESOURCES_MISSING' });
    assert.deepEqual(statuses.map(value => value.state), ['error']);
  } finally {
    assert.ok(resolve(fixture).startsWith(resolve(prefix)));
    await rm(fixture, { recursive: true, force: true });
  }
});
