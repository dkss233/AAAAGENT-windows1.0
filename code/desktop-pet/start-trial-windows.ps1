# Windows launcher for the AAAAGENT desktop pet.
#
# Double-click 启动桌宠.cmd next to this file, or use a shortcut to that .cmd.
# It is safe to run repeatedly: it stops any running instance first.
#
# Steps:
#   1. check the prepared configuration against the current runtime files
#   2. rebuild + re-pin when needed (this is the part that used to be manual)
#   3. stop a running pet (WMI Terminate; never taskkill, which kills the caller's job)
#   4. start the pet and stay attached, because trial-launcher waits for Electron
[CmdletBinding()]
param(
  [switch]$Force,     # rebuild and re-pin even when the configuration looks current
  [switch]$Check      # report what would happen, then exit
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Write-Step($text) { Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Write-Err($text)  { Write-Host "    $text" -ForegroundColor Red }

Write-Host ''
Write-Host 'AAAAGENT 启动器' -ForegroundColor White
Write-Host "项目目录: $PSScriptRoot"
Write-Host ''

# --- 1. prerequisites ------------------------------------------------------
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Err '找不到 node，请先安装 Node.js 并加入 PATH。'; exit 1 }
# The trial state lives beside the package root (windows\), not inside code\desktop-pet.
# code\desktop-pet -> code -> windows\.local (two levels up)
$windowsRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$trialState = Join-Path $windowsRoot '.local\model-evaluation\trial\user-trial'
$configFile = Join-Path $trialState 'config.json'
$activationFile = Join-Path $trialState 'activation.json'
if (-not (Test-Path $configFile) -or -not (Test-Path $activationFile)) {
  Write-Err '还没有完成首次配置。请先在本目录运行：'
  Write-Host '        npm run configure-local'
  Write-Host '    然后在打开的网页里保存 Key，再运行：'
  Write-Host '        npm run configure-local -- --activate-existing'
  exit 1
}

# --- 2. keep the pinned configuration current -----------------------------
# A rebuild always changes runtime files, and the launcher refuses to start on a
# stale pin. Re-pinning here means "edit source, double-click" is the whole flow.
Write-Step '检查配置是否与当前文件一致'
$repin = Join-Path $PSScriptRoot 'tools\repin-config.mjs'
$stale = $false
if (Test-Path $repin) {
  & $node $repin --check *> $null
  if ($LASTEXITCODE -eq 2) { $stale = $true }
  elseif ($LASTEXITCODE -ne 0) {
    Write-Err '配置与当前文件差异过大（有文件被新增或删除）。'
    Write-Host '    请先完整重做一次首次配置：npm run configure-local'
    exit 1
  }
}

if ($stale -or $Force) {
  if ($stale) { Write-Warn '源码或构建产物已变化，需要重建并重新固定配置' } else { Write-Warn '使用了 -Force，强制重建' }
  Write-Step '构建 desktop 前端'
  & npm run build:desktop
  if ($LASTEXITCODE -ne 0) { Write-Err '构建失败，未启动。'; exit 1 }
  Write-Ok '构建完成'
  Write-Step '重新固定配置'
  & $node $repin --activate
  if ($LASTEXITCODE -ne 0) { Write-Err '重新固定失败，未启动。'; exit 1 }
  Write-Ok '配置已更新'
} else {
  Write-Ok '配置已是最新'
}

if ($Check) { Write-Step '-Check 模式：到此结束，未启动桌宠'; exit 0 }

# --- 3. stop a running instance -------------------------------------------
# Match on the exe path (not on the word in this script's own command line, which
# used to make the launcher kill itself).
$electronExe = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
Write-Step '停止正在运行的桌宠（如果有）'
$running = @(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.Equals($electronExe, [StringComparison]::OrdinalIgnoreCase) })
if ($running.Count) {
  foreach ($p in $running) {
    try { Invoke-CimMethod -InputObject $p -MethodName Terminate -ErrorAction SilentlyContinue | Out-Null } catch {}
  }
  Write-Ok "已停止 $($running.Count) 个进程"
  Start-Sleep -Seconds 4
} else { Write-Ok '没有正在运行的实例' }

# Remove leftovers only when they are provably stale.
$modelEval = Split-Path $trialState -Parent
foreach ($f in @((Join-Path $modelEval 'backend.lock'),
                 (Join-Path $trialState 'management-session.json'),
                 (Join-Path $trialState 'first-run.lock'))) {
  if (Test-Path $f) {
    $dead = $true
    if ($f.EndsWith('backend.lock')) {
      try { $owner = (Get-Content $f -Raw | ConvertFrom-Json).pid; if (Get-Process -Id $owner -ErrorAction SilentlyContinue) { $dead = $false } } catch {}
    }
    if ($dead) { Remove-Item $f -Force -ErrorAction SilentlyContinue }
    else { Write-Warn "仍在使用中，保留 $(Split-Path $f -Leaf)" }
  }
}

# --- 4. start --------------------------------------------------------------
# Start the pet *detached*, then leave. Running npm start in the foreground tied the
# pet's stdio to this console: closing this window delivered a console-close event to the
# whole console group, so the pet died with it. Start-Process gives the chain its own
# console and returns immediately, so this launcher can be closed at any time.
Write-Step '正在启动桌宠'
$logFile = Join-Path $windowsRoot '.local\pet-launch.log'
$npmCmd = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if (-not $npmCmd) { $npmCmd = (Get-Command npm -ErrorAction SilentlyContinue).Source }
if (-not $npmCmd) { Write-Err '找不到 npm。'; exit 1 }
# Avoid Start-Process -RedirectStandardOutput: it makes PowerShell wait for the child,
# which recreates the coupling this change removes. cmd /c start detaches, and cmd owns
# the file redirection.
$errFile = Join-Path $windowsRoot '.local\pet-launch.err.log'
# Pass arguments as an array so PowerShell handles quoting. cmd owns the file redirection,
# so no pipe is held open and this launcher never waits for the pet.
Start-Process -FilePath 'cmd.exe' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden `
  -ArgumentList '/c', "npm start > `"$logFile`" 2> `"$errFile`""
Start-Sleep -Seconds 3
Write-Ok '桌宠已启动（后台运行）'
Write-Host ''
Write-Ok '现在可以关闭这个窗口了，桌宠会继续运行。'
Write-Host "    日志: $logFile"
Write-Host '    退出桌宠请用桌宠面板的退出按钮。'
Write-Host ''
