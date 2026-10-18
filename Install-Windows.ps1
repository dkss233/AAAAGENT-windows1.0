<#
.SYNOPSIS
Prepare a fresh Windows source checkout and open first-run setup.
.DESCRIPTION
Requires Windows x64 and Windows Node.js 22.12+ with npm. Installs locked
dependencies, builds the application, then opens the local setup service.
No keys, models, accounts, licensed assets or automatic activation are supplied.
.PARAMETER CheckOnly
Check prerequisites without installing, building or starting a server.
.PARAMETER PrepareOnly
Install and build without starting the interactive setup service.
#>
[CmdletBinding()]
param([switch]$CheckOnly, [switch]$PrepareOnly)

$ErrorActionPreference = 'Stop'
if ($CheckOnly -and $PrepareOnly) { throw 'Choose CheckOnly or PrepareOnly, not both.' }
if ($env:OS -ne 'Windows_NT') { throw 'Use this installer in Windows PowerShell, outside WSL.' }
$ProjectRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$CodeRoot = Join-Path $ProjectRoot 'code/desktop-pet'
if (-not (Test-Path -LiteralPath (Join-Path $CodeRoot 'package-lock.json') -PathType Leaf)) {
    throw 'The Windows source checkout is incomplete. See AGENT_INSTALL.md.'
}
$NodeCommand = Get-Command node.exe -CommandType Application -ErrorAction Stop | Select-Object -First 1
$NodePath = $NodeCommand.Source
$NpmPath = Join-Path (Split-Path -Parent $NodePath) 'npm.cmd'
if (-not (Test-Path -LiteralPath $NpmPath -PathType Leaf)) {
    throw 'Install Windows Node.js with its matching npm, then reopen the terminal.'
}
$Runtime = & $NodePath -e 'console.log(JSON.stringify({version:process.versions.node,platform:process.platform,arch:process.arch,abi:process.versions.modules}))'
if ($LASTEXITCODE -ne 0) { throw 'Node.js could not run.' }
$Runtime = $Runtime | ConvertFrom-Json
if ($Runtime.platform -ne 'win32' -or $Runtime.arch -ne 'x64' -or [version]$Runtime.version -lt [version]'22.12.0') {
    throw 'This installation path requires Windows x64 Node.js 22.12 or newer.'
}
$Configuration = Join-Path $ProjectRoot '.local/model-evaluation/trial/user-trial'
$ExistingConfig = (Test-Path -LiteralPath (Join-Path $Configuration 'config.json')) -or
                  (Test-Path -LiteralPath (Join-Path $Configuration 'activation.json'))
$SetupLock = Test-Path -LiteralPath (Join-Path $Configuration 'first-run.lock')
$BackendLock = Test-Path -LiteralPath (Join-Path $ProjectRoot '.local/model-evaluation/backend.lock')
if ($CheckOnly) {
    [ordered]@{ platform=$Runtime.platform; architecture=$Runtime.arch; node=$Runtime.version;
        nodeAbi=$Runtime.abi; existingConfiguration=$ExistingConfig; setupLock=$SetupLock;
        backendLock=$BackendLock } | ConvertTo-Json
    exit 0
}
if ($ExistingConfig) { throw 'Existing configuration preserved. Use the start/upgrade section of AGENT_INSTALL.md.' }
if ($SetupLock -or $BackendLock) {
    throw 'A setup/backend lock exists. Close the matching application before installing. Do not delete an unverified lock.'
}

function Invoke-NpmStep([string[]]$NpmArguments) {
    & $NpmPath @NpmArguments
    if ($LASTEXITCODE -ne 0) { throw ('npm failed: ' + ($NpmArguments -join ' ')) }
}

$PreviousPath = $env:PATH
Push-Location $CodeRoot
try {
    $env:PATH = (Split-Path -Parent $NodePath) + [IO.Path]::PathSeparator + $PreviousPath
    Invoke-NpmStep @('ci', '--no-audit', '--no-fund')
    Invoke-NpmStep @('run', 'build:windows')
    Invoke-NpmStep @('run', 'doctor')
    Write-Output 'Build prepared. Credentials, licensed resources and activation are still required; see AGENT_INSTALL.md.'
    if (-not $PrepareOnly) {
        Write-Output 'Keep this session open. Open the local URL below, complete setup, then press Ctrl+C.'
        Invoke-NpmStep @('run', 'configure-local')
    }
} finally {
    Pop-Location
    $env:PATH = $PreviousPath
}
