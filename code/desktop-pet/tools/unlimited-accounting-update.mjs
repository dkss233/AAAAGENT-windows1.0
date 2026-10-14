import{createHash}from'node:crypto';
const hash=b=>createHash('sha256').update(b).digest('hex');
/** The only allowed policy transition is the explicitly reviewed unlimited mode.
 * Entries, unknown amounts and all non-policy ledger fields are preserved exactly. */
export function inspectUnlimitedAccountingUpdate(plan,current,next,bytes){
 if(!plan.accountingUpdate)return null;
 const review=plan.accountingUpdate,ledger=JSON.parse(bytes);
 if(review.mode!=='unlimited'||review.ledgerBeforeSha256!==hash(bytes)||review.entriesSha256!==hash(JSON.stringify(ledger.entries))
  ||current.purpose!=='user-trial'||next.purpose!=='user-trial'||current.budgetMode==='unlimited'||current.limitMicros===null
  ||next.budgetMode!=='unlimited'||next.limitMicros!==null||ledger.limitMicros!==current.limitMicros||ledger.batchId!==current.budgetBatchId
  ||['phaseLimitMicros','maxCalls','operationLimits'].some(k=>k in next))throw Error('Unlimited accounting transition differs from review');
 const after=Buffer.from(JSON.stringify({...ledger,budgetMode:'unlimited',limitMicros:null},null,2)+'\n');
 return{before:bytes,after,entriesSha256:review.entriesSha256};
}
