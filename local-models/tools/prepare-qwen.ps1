[CmdletBinding()]
param(
    [string]$DataDir = (Join-Path $PSScriptRoot '../../.local/local-models'),
    [string]$Python = 'python',
    [switch]$SkipEnvironment,
    [switch]$SkipModel
)
$ErrorActionPreference = 'Stop'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$qwenDownloads = Join-Path $DataDir 'downloads/qwen'
$qwenEnvironment = Join-Path $DataDir 'venv-qwen'
$qwenPython = Join-Path $qwenEnvironment 'Scripts/python.exe'
$qwenTarget = Join-Path $DataDir 'models/qwen3-tts-0.6b-base'
$qwenRepository = 'Qwen/Qwen3-TTS-12Hz-0.6B-Base'
$qwenRevision = '5d83992436eae1d760afd27aff78a71d676296fc'
New-Item -ItemType Directory -Force -Path $qwenDownloads, $qwenTarget | Out-Null

function Test-QwenFile([string]$Path, [long]$Size, [string]$Sha256) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ($Size -ge 0 -and (Get-Item -LiteralPath $Path).Length -ne $Size) { return $false }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Sha256
}

function Get-QwenFile([string]$Url, [string]$Path, [long]$Size, [string]$Sha256) {
    $qwenResolvedFile = [IO.Path]::GetFullPath($Path)
    $qwenAllowedRoot = $DataDir.TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $qwenResolvedFile.StartsWith($qwenAllowedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Qwen download target is outside DataDir.'
    }
    if (Test-QwenFile $qwenResolvedFile $Size $Sha256) { return }
    New-Item -ItemType Directory -Force -Path ([IO.Path]::GetDirectoryName($qwenResolvedFile)) | Out-Null
    $qwenPartial = "$qwenResolvedFile.download"
    if ((Test-Path -LiteralPath $qwenPartial) -and $Size -ge 0 -and (Get-Item -LiteralPath $qwenPartial).Length -ge $Size) {
        if (Test-QwenFile $qwenPartial $Size $Sha256) {
            if (Test-Path -LiteralPath $qwenResolvedFile) {
                Move-Item -LiteralPath $qwenResolvedFile -Destination "$qwenResolvedFile.incomplete-$([guid]::NewGuid().ToString('N'))"
            }
            Move-Item -LiteralPath $qwenPartial -Destination $qwenResolvedFile
            return
        }
        Move-Item -LiteralPath $qwenPartial -Destination "$qwenPartial.rejected-$([guid]::NewGuid().ToString('N'))"
    }
    & curl.exe --fail --location --silent --show-error --connect-timeout 20 --retry 3 --max-time 3600 --continue-at - --output $qwenPartial $Url
    if ($LASTEXITCODE -ne 0) { throw "Official download failed: $Url. Rerun to resume." }
    if (-not (Test-QwenFile $qwenPartial $Size $Sha256)) {
        $qwenRejected = "$qwenPartial.rejected-$([guid]::NewGuid().ToString('N'))"
        Move-Item -LiteralPath $qwenPartial -Destination $qwenRejected
        throw "Qwen SHA256/length mismatch. Retained rejected download: $qwenRejected. Rerun to download afresh."
    }
    if (Test-Path -LiteralPath $qwenResolvedFile) {
        Move-Item -LiteralPath $qwenResolvedFile -Destination "$qwenResolvedFile.incomplete-$([guid]::NewGuid().ToString('N'))"
    }
    Move-Item -LiteralPath $qwenPartial -Destination $qwenResolvedFile
}

if (-not $SkipEnvironment) {
    if (-not (Test-Path -LiteralPath $qwenPython)) {
        & $Python -c "import sys, struct; assert sys.platform == 'win32' and struct.calcsize('P') == 8, 'Use native Windows x64 Python'; assert (3, 11) <= sys.version_info[:2] <= (3, 13), 'Use Python 3.11 to 3.13 for the pinned Torch wheels'"
        if ($LASTEXITCODE -ne 0) { throw 'Native Windows x64 Python 3.11 to 3.13 is required.' }
        & $Python -m venv $qwenEnvironment
        if ($LASTEXITCODE -ne 0) { throw 'Qwen virtual environment creation failed.' }
    }
    # Bootstrap SOCKS support before pip contacts a configured local proxy.
    $qwenSocksWheel = Join-Path $qwenDownloads 'PySocks-1.7.1-py3-none-any.whl'
    Get-QwenFile 'https://files.pythonhosted.org/packages/8d/59/b4572118e098ac8e46e399a1dd0f2d85403ce8bbaad9ec79373ed6badaf9/PySocks-1.7.1-py3-none-any.whl' $qwenSocksWheel 16725 '2725bd0a9925919b9b51739eea5f9e2bae91e83288108a9ad338b2e3a4435ee5'
    & $qwenPython -m pip --isolated install --disable-pip-version-check --no-index $qwenSocksWheel
    if ($LASTEXITCODE -ne 0) { throw 'Qwen proxy dependency bootstrap failed.' }
    & $qwenPython -m pip --isolated install --disable-pip-version-check --cache-dir (Join-Path $DataDir 'downloads/pip-qwen') -r (Join-Path $PSScriptRoot '../python/requirements-qwen.txt')
    if ($LASTEXITCODE -ne 0) { throw 'Qwen dependency installation failed.' }
    & $qwenPython -c "import torch, torchaudio; assert torch.cuda.is_available(), 'CUDA unavailable'; print('Torch', torch.__version__, 'CUDA', torch.version.cuda, torch.cuda.get_device_name(0))"
    if ($LASTEXITCODE -ne 0) { throw 'Qwen CUDA check failed.' }
}

if (-not $SkipModel) {
    # Every file is pinned to an official HF commit and independent SHA256.
    $qwenFiles = @(
        @{path='.gitattributes'; size=1519; sha256='11ad7efa24975ee4b0c3c3a38ed18737f0658a5f75a0a96787b576a78a023361'},
        @{path='README.md'; size=3640; sha256='181187b6057906bd960bc7f938d0b7a16652509776a0d52c4885b4ae5ccda0ea'},
        @{path='config.json'; size=4494; sha256='2e714c787c8edb98b05432685cddb634add2de4d4e645f653d68251ef72ba011'},
        @{path='generation_config.json'; size=245; sha256='f1b90b4513f3b34c62851049e2492d7b4c5940daf1276f89c82b8ef04127f3aa'},
        @{path='merges.txt'; size=1671839; sha256='599bab54075088774b1733fde865d5bd747cbcc7a547c5bc12610e874e26f5e3'},
        @{path='model.safetensors'; size=1829344272; sha256='180b3b10eb1c9f1b4db7806d5475bae3071c0243c299d49926bab1da3b6946f6'},
        @{path='preprocessor_config.json'; size=127; sha256='efdde1022ea9d76928bf7a9cd53139138f5ba2e466e837f08f6105ab1af1c119'},
        @{path='speech_tokenizer/config.json'; size=2336; sha256='ee65bb901c876664ab8707c487157aa1a6ee57c65969b28fb5ec9dc211e68167'},
        @{path='speech_tokenizer/configuration.json'; size=76; sha256='6bc26d64eb5024b4d1dab5a52371958b429256d6c9d59787f1f5294a54e0cebd'},
        @{path='speech_tokenizer/model.safetensors'; size=682293092; sha256='836b7b357f5ea43e889936a3709af68dfe3751881acefe4ecf0dbd30ba571258'},
        @{path='speech_tokenizer/preprocessor_config.json'; size=234; sha256='fcb3805e597e786d4067706e602f6688524640f8d3396790e2e09b5942fcbdfb'},
        @{path='tokenizer_config.json'; size=7344; sha256='dc3c31c3bdaedd5016382bb3cbe07323026775ad51f5a4fb564505992ae4a670'},
        @{path='vocab.json'; size=2776833; sha256='ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910'}
    )
    foreach ($qwenFile in $qwenFiles) {
        Write-Host "Qwen: verify/download $($qwenFile.path) ($($qwenFile.size) bytes)"
        $qwenUrl = "https://huggingface.co/$qwenRepository/resolve/$qwenRevision/$($qwenFile.path)"
        Get-QwenFile $qwenUrl (Join-Path $qwenTarget $qwenFile.path) $qwenFile.size $qwenFile.sha256
    }
    @{repository=$qwenRepository; revision=$qwenRevision; source='https://huggingface.co/Qwen/Qwen3-TTS-12Hz-0.6B-Base'; license='apache-2.0'; files=$qwenFiles; verifiedAt=[DateTime]::UtcNow.ToString('o')} |
        ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $qwenTarget '.aaaagent-installed.json') -Encoding UTF8
}
Write-Host "Qwen environment: $qwenPython"
Write-Host "Qwen model: $qwenTarget"
Write-Host 'Start with: venv-qwen/Scripts/python.exe windows/local-models/python/qwen_service.py --data-dir <DataDir>'
Write-Host 'Keep the downloaded model card and upstream licenses. The default reference is a synthetic Kokoro smoke clip for connectivity validation.'
