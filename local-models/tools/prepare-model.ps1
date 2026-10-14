[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('sensevoice', 'kokoro')][string]$Model,
    [string]$DataDir = (Join-Path $PSScriptRoot '../../.local/local-models')
)
$ErrorActionPreference = 'Stop'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$catalog = @{
    sensevoice = @{
        bundle = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17'
        tag = 'asr-models'
        size = 163002883
        required = @('model.int8.onnx', 'tokens.txt', 'LICENSE', 'test_wavs/zh.wav')
        sha256 = '7d1efa2138a65b0b488df37f8b89e3d91a60676e416f515b952358d83dfd347e'
    }
    kokoro = @{
        bundle = 'kokoro-int8-multi-lang-v1_1'
        tag = 'tts-models'
        size = 147031220
        required = @('model.int8.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data', 'lexicon-us-en.txt', 'lexicon-zh.txt', 'phone-zh.fst', 'date-zh.fst', 'number-zh.fst', 'LICENSE')
        sha256 = 'a1e94694776049035c4f2c6529f003aaece993c76aae9a78995831c3c4dcafc6'
    }
}
$entry = $catalog[$Model]
$downloads = Join-Path $DataDir 'downloads'
$models = Join-Path $DataDir 'models'
New-Item -ItemType Directory -Force -Path $downloads, $models | Out-Null
$archive = Join-Path $downloads "$($entry.bundle).tar.bz2"
if (-not (Test-Path -LiteralPath $archive)) {
    $partial = "$archive.download"
    $url = "https://github.com/k2-fsa/sherpa-onnx/releases/download/$($entry.tag)/$($entry.bundle).tar.bz2"
    & curl.exe --fail --location --silent --show-error --connect-timeout 15 --retry 2 --max-time 900 --output $partial $url
    if ($LASTEXITCODE -ne 0) { throw 'Official model download failed; rerun the command to retry.' }
    if ((Get-Item -LiteralPath $partial).Length -ne $entry.size -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
        throw 'SHA256 mismatch. Download was not extracted or activated.'
    }
    Move-Item -LiteralPath $partial -Destination $archive
}
if ((Get-Item -LiteralPath $archive).Length -ne $entry.size -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $entry.sha256) {
    throw 'SHA256 mismatch. Archive was not extracted; inspect the downloaded file.'
}
$modelPath = Join-Path $models "$($entry.bundle)/model.int8.onnx"
$target = Join-Path $models $entry.bundle
function Test-CompleteModel([string]$Directory, [switch]$Extracted) {
    foreach ($relative in $entry.required) {
        $file = Join-Path $Directory $relative
        if (-not (Test-Path -LiteralPath $file)) { return $false }
        $item = Get-Item -LiteralPath $file
        if (-not $item.PSIsContainer -and $item.Length -eq 0) { return $false }
    }
    if (-not $Extracted) {
        $marker = Join-Path $Directory '.aaaagent-installed.json'
        if (-not (Test-Path -LiteralPath $marker)) { return $false }
        try {
            $inventory = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
            if ($inventory.archiveSha256 -ne $entry.sha256) { return $false }
            foreach ($file in $inventory.files) {
                if ($file.path -match '(^|/)\.\.(/|$)' -or $file.path.Contains(':') -or [IO.Path]::IsPathRooted($file.path)) { return $false }
                $installed = Join-Path $Directory $file.path
                if (-not (Test-Path -LiteralPath $installed) -or (Get-Item -LiteralPath $installed).Length -ne $file.size) { return $false }
                if ((Get-FileHash -LiteralPath $installed -Algorithm SHA256).Hash.ToLowerInvariant() -ne $file.sha256) { return $false }
            }
            if (-not $inventory.files.Count) { return $false }
        } catch { return $false }
    }
    return $true
}
if (-not (Test-CompleteModel $target)) {
    $members = & tar.exe -tjf $archive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot read model archive with Windows tar.exe.' }
    foreach ($member in $members) {
        if (-not $member.StartsWith("$($entry.bundle)/") -or $member -match '(^|/)\.\.(/|$)' -or $member.Contains('\') -or $member.Contains(':')) {
            throw 'Unexpected archive path; extraction stopped.'
        }
    }
    $staging = Join-Path $DataDir ("staging/" + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    & tar.exe -xjf $archive -C $staging
    if ($LASTEXITCODE -ne 0) { throw 'Model extraction failed.' }
    $prepared = Join-Path $staging $entry.bundle
    if (-not (Test-CompleteModel $prepared -Extracted)) { throw 'Model archive is incomplete; previous installation was retained.' }
    $inventoryFiles = @(Get-ChildItem -LiteralPath $prepared -File -Recurse | ForEach-Object {
        @{
            path = $_.FullName.Substring($prepared.Length + 1).Replace('\', '/')
            size = $_.Length
            sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        }
    })
    @{ archiveSha256 = $entry.sha256; files = $inventoryFiles } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $prepared '.aaaagent-installed.json') -Encoding UTF8
    if (Test-Path -LiteralPath $target) {
        $resolvedTarget = [IO.Path]::GetFullPath($target)
        $intendedModels = [IO.Path]::GetFullPath($models).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
        if (-not $resolvedTarget.StartsWith($intendedModels, [StringComparison]::OrdinalIgnoreCase)) { throw 'Model backup path is outside the intended model directory.' }
        $backup = "$target.incomplete-$([guid]::NewGuid().ToString('N'))"
        Move-Item -LiteralPath $resolvedTarget -Destination $backup
        Write-Host "Retained incomplete installation: $backup"
    }
    $resolvedPrepared = [IO.Path]::GetFullPath($prepared)
    $intendedStaging = [IO.Path]::GetFullPath($staging).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedPrepared.StartsWith($intendedStaging, [StringComparison]::OrdinalIgnoreCase)) { throw 'Prepared model path is outside staging.' }
    Move-Item -LiteralPath $resolvedPrepared -Destination $target
}
if (-not (Test-CompleteModel $target)) { throw 'Model installation verification failed.' }
Write-Host "$Model ready: $modelPath"
Write-Host 'Keep model LICENSE files. Weights remain local and are not included in AAAAGENT source releases.'
