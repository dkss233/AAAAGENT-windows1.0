// Download the five wake-word model files, verify them, and hand the install to the project's own
// installer.
//
// The repository cannot ship these (they are third-party release assets), and the wake feature stays
// disabled until every file matches the hashes in media/wake/models.ts. This script fetches the KWS
// package from a GitHub proxy that works from mainland China, renames the four release files to the
// canonical names media/wake/detector-worker.ts loads, fetches the silero VAD model, and verifies all
// five against the pins.
//
// Installing is NOT done here. code/desktop-pet/tools/install-wake-models.mjs owns that step, and it
// is the only path that refuses symlinked sources, refuses a symlinked destination chain, writes with
// 'wx' so it cannot clobber, and preserves an existing file whose hash differs instead of overwriting
// it. An earlier version of this script reimplemented the copy itself and silently bypassed all four.
import { writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync, statSync, existsSync, copyFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { installWakeModels } from '../code/desktop-pet/tools/install-wake-models.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dest = join(root, '.local', 'data', 'wake-models');
// Downloads and extraction land here; only the five canonical files are copied on to `staging`,
// which is what installWakeModels is allowed to read.
//
// Deliberately NOT under %TEMP%: on this machine TEMP is the 8.3 short form
// (C:\Users\ADMINI~1\AppData\Local\Temp) and realpathSync does not expand it, which makes
// installWakeModels's source path checks reject the install — the same directory reached through the
// long form (C:\Users\Administrator\...) installs fine. homedir() gives the long form.
const staging = join(homedir(), '.aaaagent', 'wake-models-staging');
const work = join(staging, 'download');
const repo = join(root, 'code', 'desktop-pet');

const KWS_ARCHIVE = 'sherpa-onnx-kws-zipformer-zh-en-3M-2025-12-20.tar.bz2';
const KWS_PATH = 'github.com/k2-fsa/sherpa-onnx/releases/download/kws-models/' + KWS_ARCHIVE;
const VAD_PATH = 'github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx';
const PROXIES = ['https://ghfast.top/', 'https://gh-proxy.com/', 'https://ghproxy.net/', 'https://github.com/'];

// The operator-facing intro is printed here rather than by a batch wrapper. The original
// 准备唤醒模型.cmd was removed with the other root .cmd files: cmd.exe decodes a .cmd with the console
// code page active when it starts reading, and UTF-8 Chinese there was executed as a command on a 936
// console. The console's 【安装唤醒模型】 button runs this script and shows this output.
console.log('');
console.log('  ============================================');
console.log('    准备语音唤醒模型');
console.log('  ============================================');
console.log('');
console.log('  唤醒功能需要 5 个模型文件，仓库里不含（体积和授权原因）。');
console.log('  本脚本会从镜像下载、校验并安装，约 33 MB。');
console.log('');
if (existsSync(dest) && readdirSync(dest).length > 0) {
  console.log('  检测到模型已存在，将重新校验；与已安装内容不一致的文件会被保留。');
  console.log('');
}

// Canonical name -> the name inside the KWS release.
const KWS_FILES = {
  'encoder.onnx': 'encoder-epoch-13-avg-2-chunk-8-left-64.int8.onnx',
  'decoder.onnx': 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx',
  'joiner.onnx': 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  'tokens.txt': 'tokens.txt',
};

// Read the expected size and hash from the project's own pin table, so this script cannot drift from
// the code that verifies it. installWakeModels gets the same table, in the shape it expects.
const pinSource = readFileSync(join(repo, 'media', 'wake', 'models.ts'), 'utf8');
const EXPECTED = {};
for (const [, name, bytes, sha] of pinSource.matchAll(/"([\w.]+)":\s*\{\s*"bytes":\s*(\d+),\s*"sha256":\s*"([a-f0-9]{64})"/g)) {
  EXPECTED[name] = { bytes: Number(bytes), sha256: sha };
}
if (Object.keys(EXPECTED).length !== 5) {
  console.error('  无法从 media/wake/models.ts 读取校验表');
  process.exit(1);
}
const expectedHashes = Object.fromEntries(Object.entries(EXPECTED).map(([name, pin]) => [name, pin.sha256]));
console.log('  从 media/wake/models.ts 读取到 ' + Object.keys(EXPECTED).length + ' 个文件的期望校验值\n');

const verify = (path, name) => {
  const e = EXPECTED[name];
  if (!e) return '未知文件';
  const bytes = readFileSync(path);
  if (bytes.length !== e.bytes) return '尺寸不符（' + bytes.length + ' ≠ ' + e.bytes + '）';
  const sha = createHash('sha256').update(bytes).digest('hex');
  return sha === e.sha256 ? 'ok' : '哈希不符';
};

const fetchVia = async (path, label) => {
  for (const proxy of PROXIES) {
    const url = proxy + 'https://' + path.replace(/^https?:\/\//, '');
    try {
      process.stdout.write('  下载 ' + label + '（' + proxy.replace('https://', '').replace('/', '') + '）… ');
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(600000) });
      if (!res.ok) { console.log('HTTP ' + res.status); continue; }
      const buf = Buffer.from(await res.arrayBuffer());
      console.log(buf.length + ' 字节');
      return buf;
    } catch (e) {
      console.log(String(e.message ?? e).slice(0, 40));
    }
  }
  return null;
};

rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(staging, { recursive: true });

// 1. KWS package
const archive = join(work, KWS_ARCHIVE);
const archiveBytes = await fetchVia(KWS_PATH, '关键词检测模型包');
if (!archiveBytes) { console.error('\n  ✗ 下载失败。请检查网络，或稍后重试。'); process.exit(1); }
writeFileSync(archive, archiveBytes);

try {
  execFileSync('tar', ['-xjf', archive, '-C', work], { stdio: 'inherit', windowsHide: true });
} catch {
  console.error('\n  ✗ 解压失败（需要系统自带 tar）。');
  process.exit(1);
}
const kwsDir = readdirSync(work).map((n) => join(work, n)).find((p) => statSync(p).isDirectory());
if (!kwsDir) { console.error('\n  ✗ 解压目录未找到。'); process.exit(1); }

// 2. Rename to canonical names and verify each against the project's pins, into the staging directory.
console.log('\n  校验:');
let verified = 0;
for (const [canonical, source] of Object.entries(KWS_FILES)) {
  const from = join(kwsDir, source);
  if (!existsSync(from)) { console.log('    ✗ ' + canonical + '：发布包内未找到 ' + source); continue; }
  const verdict = verify(from, canonical);
  if (verdict !== 'ok') { console.log('    ✗ ' + canonical + '：' + verdict); continue; }
  copyFileSync(from, join(staging, canonical));
  console.log('    ✓ ' + canonical.padEnd(15) + EXPECTED[canonical].bytes + ' 字节');
  verified++;
}

// 3. silero VAD
const vadBytes = await fetchVia(VAD_PATH, 'silero VAD 模型');
if (vadBytes) {
  const vadPath = join(staging, 'silero_vad.onnx');
  writeFileSync(vadPath, vadBytes);
  const verdict = verify(vadPath, 'silero_vad.onnx');
  if (verdict === 'ok') {
    console.log('    ✓ silero_vad.onnx  ' + EXPECTED['silero_vad.onnx'].bytes + ' 字节');
    verified++;
  } else {
    console.log('    ✗ silero_vad.onnx：' + verdict);
  }
} else {
  console.log('    ✗ silero_vad.onnx：下载失败');
}

if (verified !== 5) {
  rmSync(work, { recursive: true, force: true });
  console.error('\n  ✗ 只取得 ' + verified + '/5 个文件，未改动已安装内容。');
  process.exit(1);
}

// 4. Hand the verified directory to the project's installer. It does the destination checks and the
//    write; this script never writes into `dest` itself.
let result;
try {
  result = await installWakeModels({ sourceDirectory: staging, destinationDirectory: dest, expectedHashes });
} catch (error) {
  rmSync(work, { recursive: true, force: true });
  console.error('\n  ✗ 安装被拒绝：' + String(error?.message ?? error));
  console.error('    已安装的文件未被覆盖，请核对后重试。');
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });

// 5. Report the final state by re-reading what is now installed.
console.log('\n  安装结果（' + dest + '）:');
let complete = 0;
for (const name of Object.keys(EXPECTED)) {
  const p = join(dest, name);
  const state = !existsSync(p) ? '缺失' : verify(p, name) === 'ok' ? 'ok' : '校验失败';
  if (state === 'ok') complete++;
  console.log('    ' + (state === 'ok' ? '✓' : '✗') + ' ' + name.padEnd(16) + state);
}
if (result.created.length === 0) console.log('\n  （5 个文件均已存在且校验通过，没有写入任何内容。）');

if (complete === 5) {
  console.log('\n  ✅ 5 个文件全部就绪。重启桌宠后即可在控制台开启语音唤醒。');
} else {
  console.log('\n  ✗ 只完成 ' + complete + '/5。唤醒不会启用，请把上面的信息发给协助者。');
  process.exit(1);
}
