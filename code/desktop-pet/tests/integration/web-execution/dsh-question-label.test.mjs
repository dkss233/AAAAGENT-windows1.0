import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import Database from 'better-sqlite3';

const source=resolve(process.env.DSH_WEB_SOURCE),output=resolve(process.env.DSH_LABEL_TEST_OUTPUT);
let fold,original;
before(async()=>{
  await mkdir(output,{recursive:true});
  const file=join(output,'user-input.mjs');
  await build({entryPoints:[join(source,'packages/client-runtime/src/work-log/userInput.ts')],
    outfile:file,bundle:true,platform:'node',format:'esm'});
  ({foldUserInputActivities:fold}=await import(pathToFileURL(file)));
  const db=new Database(process.env.DSH_LABEL_ORIGINAL_DB,{readonly:true,fileMustExist:true});
  try {
    original=db.prepare("SELECT activity_id AS id,created_at,kind,summary,tone,turn_id,payload_json FROM projection_thread_activities WHERE thread_id=? AND kind IN ('user-input.requested','user-input.resolved') ORDER BY created_at,activity_id")
      .all(process.env.DSH_LABEL_ORIGINAL_THREAD).map(row=>({id:row.id,createdAt:row.created_at,kind:row.kind,
        summary:row.summary,tone:row.tone,turnId:row.turn_id,payload:JSON.parse(row.payload_json)}));
  }finally{db.close();}
});

test('original answered DSH projection retains its actual submitted label when resolved omits answer contents',()=>{
  assert.equal(original.length,2);
  assert.equal(original[1].summary,'User input submitted');
  assert.deepEqual(original[1].payload.answers,{});
  const folded=fold(original);
  assert.equal(folded.length,1);
  assert.equal(folded[0].summary,'User input submitted');
  assert.deepEqual(folded[0].payload.answers,{},'display status does not invent answer contents');
});

test('original folding still distinguishes pending questions and explicitly dismissed callbacks',()=>{
  assert.equal(fold([original[0]])[0].summary,'User input requested');
  const dismissed={...original[1],summary:'User input dismissed'};
  assert.equal(fold([original[0],dismissed])[0].summary,'User input dismissed');
});
