import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {sameThemeDefinition} from '../../../../t3-native/apps/web/src/aaaagent/AAAThemeMatch.ts';
const bytes=await readFile(new URL('./fixtures/aaa-warm-4d.json',import.meta.url));
assert.equal(createHash('sha256').update(bytes).digest('hex'),'f6e63c4903fb901ecdbee98d64360606d2d7d26c07ece718329974b7fa2bc5ce');
const legacy=JSON.parse(bytes);
test('complete original generated palette matches even when object keys reorder',()=>{
 assert.equal(sameThemeDefinition(JSON.parse(JSON.stringify(legacy)),legacy),true);
 assert.equal(sameThemeDefinition(Object.fromEntries(Object.entries(legacy).reverse()),legacy),true);
});
test('edited variant, label, extra metadata or missing variant cannot be migrated',()=>{
 const color=structuredClone(legacy);color.variants.dark.warningForeground='#ffeebb';
 const label=structuredClone(legacy);label.label='用户自己的主题';
 const extra=structuredClone(legacy);extra.userNote='用户保留字段';
 const missing=structuredClone(legacy);delete missing.variants;
 for(const own of [color,label,extra,missing,null,[legacy]])assert.equal(sameThemeDefinition(own,legacy),false);
});
