import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

test('closed native output still lets the original child finish cleanup', { timeout: 5000 }, async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'pet-bridge-exit-'));
  const dir = root + '/code/workbench/integration/independent-blackboard';
  await mkdir(dir, { recursive: true }); await mkdir(root + '/code/desktop-pet/dist/app', { recursive: true });
  for (const name of ['guarded-pet-backend.mjs', 'pet-device-gate.mjs']) {
    await copyFile(new URL('../../../../workbench/integration/independent-blackboard/' + name, import.meta.url), dir + '/' + name);
  }
  await writeFile(root + '/code/desktop-pet/dist/app/trial-backend.js', `
    const fs=require('node:fs');
    const timer=setInterval(()=>process.stdout.write(JSON.stringify({channel:'test-close-frame'})+'\\n'),20);
    process.stdin.resume();
    process.stdin.once('end',()=>{clearInterval(timer);fs.writeFileSync(${JSON.stringify(root + '/cleanup-finished')},'yes');});
  `);
  const child = spawn(process.execPath, [dir + '/guarded-pet-backend.mjs'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = []; child.stderr.on('data', chunk => stderr.push(chunk));
  try {
    await once(child.stdout, 'data');
    const exited = once(child, 'exit'); child.stdout.destroy();
    const [code] = await exited; assert.equal(code, 0, Buffer.concat(stderr).toString());
    assert.equal(await readFile(root + '/cleanup-finished', 'utf8'), 'yes');
  } finally { child.stdin.destroy(); if (child.exitCode === null) child.kill('SIGTERM'); await rm(root, { recursive: true }); }
});
