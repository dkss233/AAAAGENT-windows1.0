[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $PSScriptRoot '../../.local/local-models'),
    [string]$ConfigPath,
    [ValidateRange(1024, 65535)][int]$Port = 9880
)
$ErrorActionPreference = 'Stop'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$service = Join-Path $DataDir 'services/gpt-sovits/GPT-SoVITS-v2pro-20250604-nvidia50'
$python = Join-Path $service 'runtime/python.exe'
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Run tools/prepare-gpt-sovits.ps1 first.' }
if (-not $ConfigPath) { $ConfigPath = Join-Path $DataDir 'services/gpt-sovits/aaaagent-tts.yaml' }
$ConfigPath = [IO.Path]::GetFullPath($ConfigPath)
if (-not (Test-Path -LiteralPath $ConfigPath)) {
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $ConfigPath) | Out-Null
    & $python -c 'import sys,yaml; c=yaml.safe_load(open(sys.argv[1],encoding="utf8")); c["custom"]=dict(c["v2Pro"],device="cuda",is_half=True); yaml.safe_dump(c,open(sys.argv[2],"w",encoding="utf8"),allow_unicode=True)' (Join-Path $service 'GPT_SoVITS/configs/tts_infer.yaml') $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create the independent stock v2Pro CUDA configuration.' }
}
$savedGptEnv = @{}
foreach ($name in @('PYTHONUTF8', 'PYTHONIOENCODING', 'HF_HUB_OFFLINE', 'HF_HUB_DISABLE_IMPLICIT_TOKEN', 'GRADIO_ANALYTICS_ENABLED', 'PATH')) {
    $savedGptEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
Push-Location -LiteralPath $service
try {
    $env:PYTHONUTF8 = '1'
    $env:PYTHONIOENCODING = 'utf-8'
    $env:HF_HUB_OFFLINE = '1'
    $env:HF_HUB_DISABLE_IMPLICIT_TOKEN = '1'
    $env:GRADIO_ANALYTICS_ENABLED = 'False'
    $env:PATH = "$(Join-Path $service 'runtime');$env:PATH"
    & $python 'api_v2.py' -a 127.0.0.1 -p $Port -c $ConfigPath
    if ($LASTEXITCODE -ne 0) { throw 'GPT-SoVITS API stopped with an error; inspect its local output.' }
} finally {
    Pop-Location
    foreach ($name in $savedGptEnv.Keys) { [Environment]::SetEnvironmentVariable($name, $savedGptEnv[$name], 'Process') }
}
