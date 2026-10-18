<#
.SYNOPSIS
  Check the Windows prerequisites, then prepare this source checkout.
.DESCRIPTION
  The preflight mirrors the upstream windows/Install-Windows.ps1 (platform, architecture, Node
  version and the two lock files). The download and build are delegated to the Node installer so the
  npmmirror settings live in exactly one place and cannot drift.
.PARAMETER CheckOnly
  Print environment facts as JSON and change nothing.
.PARAMETER PrepareOnly
  Install and build without opening the setup page. 启动桌宠.cmd uses this, then launches the pet.
#>
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
if ($CheckOnly -and $PrepareOnly) { throw 'Choose CheckOnly or PrepareOnly, not both.' }

function Stop-With([int]$Code, [string]$Message) {
    # Write-Host (not the raw stderr handle) so cmd.exe and redirected logs both see the text.
    Write-Host ''
    Write-Host ('  ' + $Message) -ForegroundColor Yellow
    Write-Host ''
    exit $Code
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$CodeRoot = Join-Path $ProjectRoot 'code/desktop-pet'
$Configuration = Join-Path $ProjectRoot '.local/model-evaluation/trial/user-trial'

Write-Host ''
Write-Host '  AAAAGENT 桌宠 · 环境检查'
Write-Host ''

if ($env:OS -ne 'Windows_NT') {
    Stop-With 2 '这份安装流程只适用于 Windows。Mac / WSL 请使用仓库根目录的安装文档。'
}

# A partial copy cannot build: the backend imports ../../workbench at compile time.
if (-not (Test-Path -LiteralPath (Join-Path $CodeRoot 'package-lock.json') -PathType Leaf)) {
    Stop-With 2 '源码不完整：必须克隆整个仓库（code\workbench 与 code\desktop-pet 必须同级），只拷子目录无法编译。'
}

$NodeCommand = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $NodeCommand) {
    Stop-With 2 '未找到 node.exe。请安装 Node.js 22.12 或 24（自带 npm）：https://nodejs.org/ 然后重开终端。'
}
$NodePath = $NodeCommand.Source
$NpmPath = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
if (-not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) {
    Stop-With 2 '找到 node.exe，但同目录没有 npm.cmd。请安装带 npm 的官方 Node.js 发行版。'
}

$RuntimeJson = & $NodePath -e 'console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,abi:process.versions.modules}))'
if ($LASTEXITCODE -ne 0 -or -not $RuntimeJson) { Stop-With 2 'node.exe 无法运行。请重装 Node.js 后重试。' }
$Runtime = $RuntimeJson | ConvertFrom-Json

if ($Runtime.platform -ne 'win32' -or $Runtime.arch -ne 'x64' -or [version]$Runtime.version -lt [version]'22.12.0') {
    Stop-With 2 ('当前 Node 是 ' + $Runtime.version + ' / ' + $Runtime.platform + ' / ' + $Runtime.arch +
        '。这份流程要求 Windows x64 且 Node 22.12 以上，请装 22 或 24 的 LTS 版。')
}

$ExistingConfiguration = (Test-Path -LiteralPath (Join-Path $Configuration 'config.json')) -or
                         (Test-Path -LiteralPath (Join-Path $Configuration 'activation.json'))
$SetupLock = Test-Path -LiteralPath (Join-Path $Configuration 'first-run.lock')
$BackendLock = Test-Path -LiteralPath (Join-Path $ProjectRoot '.local/model-evaluation/backend.lock')

if ($CheckOnly) {
    [ordered]@{ platform = $Runtime.platform; architecture = $Runtime.arch; node = $Runtime.version;
        nodeAbi = $Runtime.abi; existingConfiguration = $ExistingConfiguration;
        setupLock = $SetupLock; backendLock = $BackendLock; projectRoot = $ProjectRoot } | ConvertTo-Json
    exit 0
}

if ($ExistingConfiguration) {
    Stop-With 3 '检测到已有配置，安装脚本不会覆盖它。日常启动直接双击 启动桌宠.cmd；需要修配置请用控制台或 tools\configure-local.mjs。'
}
if ($SetupLock -or $BackendLock) {
    Stop-With 3 '检测到设置或后端锁，说明还有实例在运行。请先关闭桌宠/设置窗口；不要删除锁文件来强开第二个实例。'
}

$env:PATH = (Split-Path -Parent $NodePath) + [IO.Path]::PathSeparator + $env:PATH
$env:ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/'

Write-Host '  Node.js ' + $Runtime.version + ' (ABI ' + $Runtime.abi + ')，开始安装依赖并构建。'
Write-Host ''
& $NodePath (Join-Path $ProjectRoot 'tools/aaaagent-install-mirror.mjs') --no-launch
if ($LASTEXITCODE -ne 0) {
    Stop-With 4 '安装或构建未完成。上面的输出里有具体命令；网络问题可重试，或参考 使用说明.txt 的手动步骤。'
}

if ($PrepareOnly) {
    Write-Host ''
    Write-Host '  构建已完成。双击 启动桌宠.cmd 即可启动（首次会打开设置页）。'
    exit 0
}

Write-Host ''
Write-Host '  ==> 打开首次设置页。完成后按 Ctrl+C 结束这个窗口。'
Write-Host ''
Push-Location $CodeRoot
try { & $NodePath (Join-Path $CodeRoot 'tools/configure-local.mjs') } finally { Pop-Location }
exit 0
