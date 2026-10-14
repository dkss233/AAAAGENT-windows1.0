// Pick a model folder with a native Windows dialog, then hand it to the swap tool.
//
// Dragging a folder onto the console window relies on cmd's `set /p`, which is unreliable after
// `chcp 65001` on some Windows builds. A real folder browser avoids typing and dragging entirely.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const windowsRoot = join(import.meta.dirname, '..');

const pick = () => {
  // The path is emitted as Base64 of its UTF-8 bytes. PowerShell writes its stdout using the OEM
  // code page by default, which turns a Chinese folder name into mojibake before Node ever sees it;
  // encoding the value avoids every code-page conversion in between.
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms | Out-Null',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    "$dialog.Description = '选择要安装的 Live2D 模型文件夹'",
    '$dialog.ShowNewFolderButton = $false',
    'try { $dialog.SelectedPath = [Environment]::GetFolderPath("Desktop") + "\\live2d" } catch {}',
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($dialog.SelectedPath))',
    '}',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', script],
    { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  const encoded = String(result.stdout ?? '').trim().split(/\r?\n/).pop() ?? '';
  if (!encoded) return '';
  let decoded;
  try { decoded = Buffer.from(encoded, 'base64').toString('utf8'); }
  catch { return String(encoded).trim(); }
  // A folder pick can come back with a trailing separator.
  return decoded.replace(/[\\/]+$/, '');
};

console.log('============================================');
console.log('  更换 Live2D 模型');
console.log('============================================');
console.log('');
console.log('  即将打开文件夹选择窗口，请选到模型所在的文件夹。');
console.log('  （例如 D:\\live2d\\<你的模型文件夹> —— 如果里面还套了一层同名文件夹，');
console.log('    安装工具会自动进入，你不用手动点进去。）');
console.log('');

const directory = pick();
if (!directory) {
  console.log('  已取消，未做任何改动。');
  process.exit(0);
}
console.log('  已选择: ' + directory);
if (!existsSync(directory)) {
  console.log('  ❌ 这个文件夹不存在。');
  process.exit(1);
}

const result = spawnSync(process.execPath, [join(windowsRoot, 'tools', 'aaaagent-set-model.mjs'), directory],
  { cwd: windowsRoot, stdio: 'inherit' });
process.exit(result.status ?? 1);
