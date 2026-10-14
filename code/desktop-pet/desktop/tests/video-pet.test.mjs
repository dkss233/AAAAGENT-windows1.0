import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replyAction, workAction, catalogEntries } from '../video-pet-state.mjs';
import { assetResponse } from '../electron/assets.mjs';
import { fitDisplay } from '../electron/layout.mjs';

test('reply mapping respects explicit neutral and disabled presets', () => {
  assert.equal(replyAction({presetId:null,emotion:'happy',gesture:'heart'}),'idle');
  assert.equal(replyAction({presetId:'exp-shengqi'},new Set()),'idle');
  assert.equal(replyAction({presetId:'exp-shengqi'},new Set(['exp-shengqi'])),'angry');
  assert.equal(replyAction({emotion:'warm'}),'affectionate');
  assert.equal(replyAction({emotion:'warm'},new Set()),'idle');
});
test('work animation follows the exact focused native task', () => {
  const task={id:'one',projectId:'project'},other={id:'two',projectId:'project'};
  assert.equal(workAction('workbench',{focus:{task},tasks:[{task:other,projection:{phase:'completed'}},{task,projection:{phase:'running'}}]}),'working');
  assert.equal(workAction('workbench',{focus:{task:null},tasks:[{task,projection:{phase:'completed'}}]}),'idle');
  assert.equal(workAction('work',{stage:'failed'}),'error');
});
test('catalog resource paths cannot escape the private resource directory', () => {
  const entries=catalogEntries({nativeActions:[{id:'native:a',video:'a',file:'assets/webm/a.webm'},{id:'escape',video:'b',file:'assets/webm/../../secret.webm'}],actions:[{id:'idle',video:'a'}],memes:[{id:'meme:x',kind:'meme',file:'https://example.test/image.png'}]});
  assert.deepEqual([...entries.keys()],['native:a','idle']);
});
test('video range responses stream only requested bytes and reject invalid ranges', async t => {
  const root=await mkdtemp(join(tmpdir(),'aaaagent-video-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await writeFile(join(root,'clip.webm'),Buffer.from('0123456789'));
  const response=await assetResponse(root,'pet://app/clip.webm',{'Range':'bytes=3-6'});
  assert.equal(response.status,206);assert.equal(response.headers.get('content-type'),'video/webm');
  assert.equal(response.headers.get('content-range'),'bytes 3-6/10');assert.equal(await response.text(),'3456');
  assert.equal((await assetResponse(root,'pet://app/clip.webm',{'Range':'bytes=100-'})).status,416);
  assert.equal(await (await assetResponse(root,'pet://app/clip.webm',{'Range':'bytes=-2'})).text(),'89');
});
test('collapsed window fits a screen and restores the same pet anchor', () => {
  const area={x:0,y:0,width:1920,height:1080},anchor={x:600,y:500};
  const collapsed=fitDisplay(360,true,area,anchor,'full',true);
  assert.deepEqual(collapsed.bounds,{x:573,y:500,width:54,height:54});
  assert.equal(collapsed.config.collapsed,true);assert.deepEqual(collapsed.anchor,anchor);
  assert.deepEqual(fitDisplay(360,true,area,collapsed.anchor).anchor,anchor);
});
