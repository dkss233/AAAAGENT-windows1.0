import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const pet = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const { startManagementServer } = await import(pathToFileURL(process.env.ORIGINAL_SERVER_FILE ?? resolve(pet, 'dist/management/server.js')));

test('original management HTTP entry serves every actual static module dependency with exact bytes and no business calls', async t => {
  let businessCalls = 0;
  const server = await startManagementServer({ uiRoot: resolve(pet, 'management/ui'),
    settings: { async drain() {} }, snapshot: () => { businessCalls++; throw Error('No business access'); } });
  t.after(() => server.close());
  const seen = new Set(), queue = ['/app.mjs', '/appearance.mjs', '/style.css'];
  while (queue.length) {
    const path = queue.shift(); if (seen.has(path)) continue; seen.add(path);
    const response = await fetch(server.origin + path);
    assert.equal(response.status, 200, `actual management dependency ${path}`);
    const data = Buffer.from(await response.arrayBuffer());
    assert.ok(data.equals(await readFile(resolve(pet, 'management/ui', path.slice(1)))), `exact source bytes ${path}`);
    if (path.endsWith('.mjs') || path.endsWith('.js')) {
      assert.match(response.headers.get('content-type'), /javascript/);
      for (const match of data.toString().matchAll(/(?:from\s*|import\s*)["']([^"']+)["']/g))
        if (match[1].startsWith('.')) queue.push(new URL(match[1], server.origin + path).pathname);
    }
  }
  assert.ok(seen.has('/context-budget-view.mjs'));
  assert.ok(seen.size >= 20);
  assert.equal(businessCalls, 0);
});
