// Prepare a model folder for the pet by adding the missing FileReferences.Expressions entry.
// The original model folder is copied to a staging directory and left untouched.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const source = process.argv[2];
const stage = process.argv[3];
if (!source || !stage) { console.log('用法: node aaaagent-prepare-model.mjs <源目录> <暂存目录>'); process.exit(2); }

if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
console.log('  复制到暂存目录（原目录不动）…');
cpSync(source, stage, { recursive: true, force: true });

const entries = readdirSync(stage).filter((n) => n.endsWith('.model3.json'));
if (entries.length !== 1) { console.log('  ❌ 期望恰好一个 .model3.json，实际 ' + entries.length + ' 个'); process.exit(1); }
const entryName = entries[0];
const entryPath = join(stage, entryName);
const entry = JSON.parse(readFileSync(entryPath, 'utf8'));

const expressions = readdirSync(stage).filter((n) => n.endsWith('.exp3.json')).sort();
if (!expressions.length) { console.log('  ❌ 目录里没有 .exp3.json 表情文件'); process.exit(1); }

entry.FileReferences ??= {};
entry.FileReferences.Expressions = expressions.map((file) => ({ Name: file.replace(/\.exp3\.json$/, ''), File: file }));
writeFileSync(entryPath, JSON.stringify(entry, null, 2) + '\n', 'utf8');

console.log('  ✅ 已在入口文件里补上 ' + expressions.length + ' 个表情引用:');
for (const e of entry.FileReferences.Expressions) console.log('      ' + e.Name + '  →  ' + e.File);
console.log('');
console.log('  入口文件: ' + entryName);
console.log('  暂存目录: ' + stage);
console.log('  原始模型: ' + source + '（未改动）');
