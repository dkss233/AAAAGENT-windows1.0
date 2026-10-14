import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
// Read the actual decoder without initializing DOM view modules.
const source=await readFile('management/ui/native-workbench-view.mjs','utf8');
const begin=source.indexOf('export function managementEntryMode('),end=source.indexOf('\n}',begin)+2;
assert.ok(begin>=0&&end>begin);
const {managementEntryMode}=await import('data:text/javascript;base64,'+Buffer.from(source.slice(begin,end)).toString('base64'));
const node=(mode,version='0.1.0')=>({getAttribute:key=>({'content':mode,'data-version':version})[key]??null});
const doc=rows=>({querySelectorAll:selector=>{assert.equal(selector,'meta[name="aaa-management-entry"]');return rows;}});
test('only an exact unique server marker identifies the original or mounted entry',()=>{
 for(const mode of ['original-management','mounted-readonly'])assert.equal(managementEntryMode(doc([node(mode)])),mode);
});
test('missing, duplicate, unknown or future markers are refused without requesting an endpoint',()=>{
 for(const rows of [[],[node('original-management'),node('mounted-readonly')],[node('original-management'),node('original-management')],[node('other')],[node('')],[node('original-management','future')],[node('mounted-readonly',null)]])assert.equal(managementEntryMode(doc(rows)),null);
});
