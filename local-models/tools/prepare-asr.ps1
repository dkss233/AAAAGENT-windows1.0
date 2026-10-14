[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('paraformer', 'whisper-small')][string]$Model,
    [string]$DataDir = (Join-Path $PSScriptRoot '../../.local/local-models')
)
$ErrorActionPreference = 'Stop'
$DataDir = [IO.Path]::GetFullPath($DataDir)
# ONNX exports are published by the sherpa-onnx maintainer and linked from the
# project's official pretrained-model documentation. Download only int8 files.
# ModelScope's original Paraformer v1.1.9 card says Apache License 2.0; Whisper
# code and weights are MIT. Preserve source cards and upstream license texts.
$catalog = @{
    paraformer = @{
        bundle = 'sherpa-onnx-paraformer-zh-2024-03-09'
        repository = 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09'
        revision = '906992d326ebf0c5171cde675aa0902be9e5bc6c'
        license = 'Apache-2.0 (original ModelScope v1.1.9 model card)'
        files = @(
            @{ path='model.int8.onnx'; size=227330205; sha256='90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c' },
            @{ path='tokens.txt'; size=75354; sha256='6c0e3b35cece259829e6cb5b8d90d13db88f61ea3a2953d11898e4b2bfd7a2e2' },
            @{ path='test_wavs/0.wav'; size=179646; sha256='668bf8df51a10027b84d5d8816a1ce11ae93545538dc05cfe2aa6811d399c250' },
            @{ path='MODEL_CARD.md'; size=22435; sha256='14f43c7c1909276a8edd271974adf7f2985a0a263c2ae9431f2a87fdc4efdb90'; url='https://modelscope.cn/api/v1/models/iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8358-tensorflow1/repo?Revision=v1.1.9&FilePath=README.md' },
            @{ path='LICENSE'; size=11358; sha256='cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30'; url='https://www.apache.org/licenses/LICENSE-2.0.txt' }
        )
    }
    'whisper-small' = @{
        bundle = 'sherpa-onnx-whisper-small'
        repository = 'csukuangfj/sherpa-onnx-whisper-small'
        revision = '8f3c18b358db4d1f2fc1eae49d75cd20989e4309'
        license = 'MIT (OpenAI Whisper code and model weights)'
        files = @(
            @{ path='small-encoder.int8.onnx'; size=112442483; sha256='4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9' },
            @{ path='small-decoder.int8.onnx'; size=262226114; sha256='acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee' },
            @{ path='small-tokens.txt'; size=816730; sha256='b34b360dbb493e781e479794586d661700670d65564001f23024971d1f2fa126' },
            @{ path='test_wavs/0.wav'; size=212044; sha256='6bc58a4efdf20daac252b6b1502632601a71efe0308f6757dc1eda34891a7e4f' },
            @{ path='LICENSE'; size=1063; sha256='b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d'; url='https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE' }
        )
    }
}
$entry = $catalog[$Model]
$downloads = Join-Path $DataDir ('downloads/' + $entry.bundle)
$models = Join-Path $DataDir 'models'
$target = Join-Path $models $entry.bundle
New-Item -ItemType Directory -Force -Path $downloads, $models | Out-Null

function Assert-Within([string]$Path, [string]$Root) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'ASR path is outside the intended directory.' }
    return $absolute
}
function Test-VerifiedFile([string]$Path, $File) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    return ((Get-Item -LiteralPath $Path).Length -eq $File.size -and
        (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $File.sha256)
}
function Test-CompleteModel([string]$Directory) {
    foreach ($file in $entry.files) {
        if (-not (Test-VerifiedFile (Join-Path $Directory $file.path) $file)) { return $false }
    }
    return $true
}

if (-not (Test-CompleteModel $target)) {
    foreach ($file in $entry.files) {
        $cached = Assert-Within (Join-Path $downloads $file.path) $downloads
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cached) | Out-Null
        if (-not (Test-VerifiedFile $cached $file)) {
            if (Test-Path -LiteralPath $cached) {
                $backup = "$cached.invalid-$([guid]::NewGuid().ToString('N'))"
                Move-Item -LiteralPath $cached -Destination (Assert-Within $backup $downloads)
            }
            $partial = Assert-Within "$cached.download" $downloads
            $url = if ($file.url) { $file.url } else { "https://huggingface.co/$($entry.repository)/resolve/$($entry.revision)/$($file.path)" }
            Write-Host "Downloading $Model/$($file.path) from its verified official source..."
            & curl.exe --fail --location --silent --show-error --connect-timeout 15 --retry 2 --max-time 1800 --output $partial $url
            if ($LASTEXITCODE -ne 0) { throw 'Official ASR download failed. No model was activated; rerun to retry.' }
            if (-not (Test-VerifiedFile $partial $file)) { throw 'ASR size/SHA256 mismatch. No model was activated.' }
            Move-Item -LiteralPath $partial -Destination $cached
        }
    }
    $stagingRoot = Join-Path $DataDir ('staging/asr-' + [guid]::NewGuid().ToString('N'))
    $prepared = Assert-Within (Join-Path $stagingRoot $entry.bundle) $stagingRoot
    New-Item -ItemType Directory -Force -Path $prepared | Out-Null
    foreach ($file in $entry.files) {
        $destination = Assert-Within (Join-Path $prepared $file.path) $prepared
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
        Copy-Item -LiteralPath (Join-Path $downloads $file.path) -Destination $destination
    }
    if (-not (Test-CompleteModel $prepared)) { throw 'Prepared ASR files are incomplete. Previous installation was retained.' }
    $inventory = @{ version=1; model=$Model; repository=$entry.repository; revision=$entry.revision; license=$entry.license; files=$entry.files }
    [IO.File]::WriteAllText((Join-Path $prepared '.aaaagent-installed.json'), ($inventory | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $target) {
        $resolvedTarget = Assert-Within $target $models
        $backup = Assert-Within "$target.incomplete-$([guid]::NewGuid().ToString('N'))" $models
        Move-Item -LiteralPath $resolvedTarget -Destination $backup
        Write-Host "Retained incomplete ASR installation: $backup"
    }
    Move-Item -LiteralPath $prepared -Destination (Assert-Within $target $models)
}
if (-not (Test-CompleteModel $target)) { throw 'Final ASR installation verification failed.' }
Write-Host "$Model ready: $target"
Write-Host "License: $($entry.license). Keep LICENSE, MODEL_CARD (if present), and the source inventory with the weights."
