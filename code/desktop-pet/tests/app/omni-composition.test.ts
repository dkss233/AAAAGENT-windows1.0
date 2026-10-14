import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {OmniEvaluationAuthorizer,OMNI_EVALUATION_MODEL,OMNI_EVALUATION_ENDPOINT,OMNI_EVALUATION_CASES} from '../../core/omni-evaluation-authorizer.js';
import {evaluateOmniSevenEmotion} from '../../app/omni-seven-emotion-evaluation.js';
import {ProviderTransport} from '../../providers/transport.js';
test('frozen public dataset completes all 28 cases through the real authorizer and a zero-network SSE transport',async()=>{
  const manifest=await readFile('/Users/example/AAAAGENT/artifacts/W0-S/omni-seven-emotion-01/manifest.json');
  assert.equal(createHash('sha256').update(manifest).digest('hex'),'8f030697f868b858438346897600a65e5d0d0f0298fa8885236d85aad1c258a4');
  const parent=resolve(import.meta.dirname,'../../../../../artifacts/W0-I/memory-dynamics-01/composition-test');await mkdir(parent,{recursive:true});
  const dir=await mkdtemp(resolve(parent,'run-')),ledger=resolve(dir,'isolated-ledger.json');
  await writeFile(ledger,JSON.stringify({batchId:'isolated',currency:'CNY',limitMicros:60_000_000,blocked:false,entries:[]}));
  try{
    let calls=0;const sequence:string[]=[];
    const transport=new ProviderTransport(async()=>{
      calls++;return new Response('data: '+JSON.stringify({id:'isolated',choices:[{delta:{content:JSON.stringify({transcript:'Kids are talking by the door.',emotion:'neutral'})},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:20,prompt_tokens_details:{audio_tokens:28}}})+'\n\ndata: [DONE]\n\n');
    });
    const result=await evaluateOmniSevenEmotion(JSON.parse(manifest.toString()),{config:{endpoint:OMNI_EVALUATION_ENDPOINT,model:OMNI_EVALUATION_MODEL,apiKey:()=> 'ISOLATED-NO-NETWORK',authorizer:new OmniEvaluationAuthorizer(ledger,'isolated',[])},transport,signal:new AbortController().signal,
      writeRecord:async event=>{if(event.type==='started')sequence.push(event.id+'-'+event.condition);}});
    assert.equal(calls,28);assert.equal(result.status,'completed');assert.deepEqual(sequence,OMNI_EVALUATION_CASES);
    const account=JSON.parse(await readFile(ledger,'utf8'));assert.equal(account.entries.length,28);assert.ok(account.entries.every((e:{status:string})=>e.status==='settled'));
    await writeFile(resolve(parent,'result.json'),JSON.stringify({status:'controlled_passed',networkCalls:0,simulatedRequests:calls,sequence,allPermitsSettled:true},null,2));
  }finally{await rm(dir,{recursive:true});}
});
