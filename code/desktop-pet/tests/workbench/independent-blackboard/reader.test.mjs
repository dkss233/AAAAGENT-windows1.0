import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createIndependentBlackboardReader } from '../../../workbench/independent-blackboard/reader.mjs';

test('scope and original conversation identity gate the projection without exposing capabilities', async t => {
  const temp = await mkdtemp(resolve(tmpdir(), 'aaa-independent-board-')); t.after(() => rm(temp, { recursive: true, force: true }));
  const database = resolve(temp, 'board.sqlite');
  const store = fileURLToPath(new URL('../../../workbench/independent-blackboard/store.py', import.meta.url));
  execFileSync(process.env.AAAAGENT_BOARD_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['-X', 'utf8', '-I', '-c', `import importlib.util,hashlib; s=importlib.util.spec_from_file_location('board',${JSON.stringify(store)}); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.initialize(${JSON.stringify(database)},{'boardId':'board','scope':{'environmentId':'env','projectId':'project'},'participants':[{'actorId':a,'threadId':a,'providerInstanceId':'codex','title':a,'role':'coordinator' if a=='c' else 'executor','capabilitySha256':hashlib.sha256(a.encode()).hexdigest()} for a in ['c','a','b']]})`], { windowsHide: true });
  let reads = 0, wrong = false;
  const reader = createIndependentBlackboardReader({ database, scope: { environmentId: 'env', projectId: 'project' }, readThread: async id => {
    reads++; return { thread: { id, projectId: wrong ? 'other-project' : 'project', modelSelection: { instanceId: 'codex' } } };
  } });
  assert.equal((await reader({ environmentId: 'other', projectId: 'project' })).status, 404); assert.equal(reads, 0);
  const good = await reader({ environmentId: 'env', projectId: 'project' });
  assert.equal(good.status, 200); assert.equal(good.body.participants.length, 3);
  assert.equal(good.body.participants[0].identitySource, 't3-original-thread-snapshot');
  assert.ok(!JSON.stringify(good.body).includes('capabilitySha256'));
  wrong = true; assert.equal((await reader({ environmentId: 'env', projectId: 'project' })).status, 503);
  await rm(database); assert.equal((await reader({ environmentId: 'env', projectId: 'project' })).status, 503);
});
