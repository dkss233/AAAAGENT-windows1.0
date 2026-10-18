// Every module app.mjs imports must be reachable from the management server.
//
// The server serves the console through an explicit allow-list (`names` in management/server.ts), while
// app.mjs imports its views statically. A view that exists on disk but is missing from the allow-list
// answers 404, and because the import is static the whole console renders blank instead of failing
// loudly — which is exactly what shipping custom-tts-view.mjs without registering it did.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Compiled output lives at dist/tests/integration/, so the project root is three levels up. Resolving
// from the source layout would have pointed at dist/management/server.ts, which does not exist.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ui = resolve(repo, 'management/ui');
const server = readFileSync(resolve(repo, 'management/server.ts'), 'utf8');

test('every relative module the console imports is in the server allow-list', () => {
  // Files that are bundled or injected rather than fetched by name are legitimately absent.
  const injected = new Set(['presentation-preview.js']);
  const missing: string[] = [];
  const checked: string[] = [];

  for (const file of readdirSync(ui).filter((f) => f.endsWith('.mjs'))) {
    const source = readFileSync(resolve(ui, file), 'utf8');
    for (const match of source.matchAll(/from\s+'\.\/([A-Za-z0-9_.-]+\.mjs)'/g)) {
      const name = match[1];
      if (!name || injected.has(name)) continue;
      checked.push(name);
      // The allow-list maps '/name' -> 'name'; either spelling proves it is reachable.
      if (!server.includes(`'/${name}'`) && !server.includes(`, '${name}'`)) missing.push(`${file} → ${name}`);
    }
  }

  assert.ok(checked.length > 0, '应至少检查到一个模块导入');
  assert.deepEqual(missing, [], '这些模块不在服务器白名单里，控制台会加载失败并显示空白');
  console.log(`  检查了 ${new Set(checked).size} 个被导入的模块，全部在白名单内`);

  // And every file the allow-list names must actually exist, or the page 500s instead of 404ing.
  const absent: string[] = [];
  for (const match of server.matchAll(/\[(\/[A-Za-z0-9_.-]+)',\s*'([A-Za-z0-9_.-]+)'\]/g)) {
    const name = match[2];
    if (!name) continue;
    if (!existsSync(resolve(ui, name))) absent.push(name);
  }
  assert.deepEqual(absent, [], '白名单里有指向不存在文件的名字');
  console.log('  白名单引用的文件全部存在');
});
