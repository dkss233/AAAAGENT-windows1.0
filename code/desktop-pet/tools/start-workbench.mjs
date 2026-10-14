#!/usr/bin/env node
import { openLocalUrl } from '../dist/core/open-url.js';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
try {
  const input = JSON.parse(process.argv[2] ?? '{"target":"home"}');
  const session = JSON.parse(await readFile(resolve(root, 'artifacts/W0-I/model-evaluation/trial/user-trial/management-session.json'), 'utf8'));
  const url = new URL(session.url);
  if (session.version !== 1 || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || !/^#token=[a-f0-9]{64}$/.test(url.hash)) throw Error();
  process.kill(session.pid, 0);
  const headers = { Authorization: 'Bearer ' + url.hash.slice(7), Origin: url.origin, 'Content-Type': 'application/json' };
  const check = await fetch(url.origin + '/api/snapshot', { headers, redirect: 'error', signal: AbortSignal.timeout(2000) });
  const snapshot = await check.json();
  if (!check.ok || snapshot.runtime?.instanceId !== session.instanceId || snapshot.runtime?.pid !== session.pid) throw Error();
  const response = await fetch(url.origin + '/api/workbench/native-open/desktop', { method: 'POST', headers,
    body: JSON.stringify(input), redirect: 'error', signal: AbortSignal.timeout(3500) });
  if (!response.ok) throw Error();
  const result = await response.json(), destination = new URL(result.url);
  if (result.status !== 'ready' || destination.protocol !== 'http:' || destination.hostname !== '127.0.0.1' ||
      destination.pathname !== '/open' || destination.search || !/^#[A-Za-z0-9_-]{43}$/.test(destination.hash)) throw Error();
  const relation = result.originalManagementReturn;
  if (relation?.version !== '0.1.1' || relation.origin !== url.origin || relation.path !== '/' ||
      relation.environmentId !== result.target?.environmentId) throw Error();
  // Reuse the normal complete management session. The exact one-use frame
  // receipt stays in the fragment and is consumed before any page requests.
  const entry = new URL(url);
  const fragment = new URLSearchParams(entry.hash.slice(1));
  fragment.set('nativeEntry', JSON.stringify(result));
  entry.hash = fragment.toString();
  await openLocalUrl(entry.href);
} catch { process.stderr.write('完整工作台未打开，请确认后台仍在运行并刷新当前任务。\n'); process.exitCode = 1; }
