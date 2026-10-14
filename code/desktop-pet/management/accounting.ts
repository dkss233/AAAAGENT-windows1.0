import {readFile} from 'node:fs/promises';
import type {TrialConfiguration} from '../app/trial-config.js';
import type {ManagementSnapshot} from '../contracts/management.js';
/** Read-only display; unknown amounts remain estimates, never converted into charges. */
export async function accountingSnapshot(config:TrialConfiguration):Promise<NonNullable<ManagementSnapshot['accounting']>> {
 // A fresh install has no ledger yet: EvaluationBudget creates the file lazily on the first
 // chargeable operation. Reporting all zeros is the honest answer, and it keeps the management
 // snapshot reachable. Only a genuinely unreadable or mismatched ledger is an error.
 const empty={mode:config.budgetMode??'bounded',limitMicros:config.limitMicros,knownMicros:0,unknownReservedMicros:0,pendingReservedMicros:0};
 let raw:string;
 try{raw=await readFile(config.budgetFile,'utf8');}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return empty;throw error;}
 const ledger=JSON.parse(raw);
 if(ledger.batchId!==config.budgetBatchId||ledger.limitMicros!==config.limitMicros||!Array.isArray(ledger.entries)||(config.budgetMode==='unlimited')!==(ledger.budgetMode==='unlimited'))throw Error('Accounting mode mismatch');
 return {mode:config.budgetMode??'bounded',limitMicros:config.limitMicros,
  knownMicros:ledger.entries.reduce((n:number,e:{actualMicros:number|null})=>n+(e.actualMicros??0),0),
  unknownReservedMicros:ledger.entries.filter((e:{status:string})=>e.status==='unknown').reduce((n:number,e:{reservedMicros:number})=>n+e.reservedMicros,0),
  pendingReservedMicros:ledger.entries.filter((e:{status:string})=>e.status==='reserved').reduce((n:number,e:{reservedMicros:number})=>n+e.reservedMicros,0)};
}
