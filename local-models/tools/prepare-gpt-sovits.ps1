[CmdletBinding()]
param([string]$DataDir = (Join-Path $PSScriptRoot '../../.local/local-models'))
$ErrorActionPreference = 'Stop'
$DataDir = [IO.Path]::GetFullPath($DataDir)
$bundle = 'GPT-SoVITS-v2pro-20250604-nvidia50'
$revision = 'fb387b7a65a5441e5e3985f4ab9b721a9d455363'
$archiveHash = '97b4edcd451c42357db7e26e6c1c877ca5d85144fe97beaff6d7005d35bee008'
$downloads = Join-Path $DataDir 'downloads'
$toolsDir = Join-Path $DataDir 'tools/7zip'
$services = Join-Path $DataDir 'services/gpt-sovits'
$target = Join-Path $services $bundle
New-Item -ItemType Directory -Force -Path $downloads, $toolsDir, $services | Out-Null

function Assert-Within([string]$Path, [string]$Root) {
    $absolute = [IO.Path]::GetFullPath($Path)
    $prefix = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $absolute.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'GPT preparation path is outside its intended directory.' }
    return $absolute
}
function Get-VerifiedDownload([string]$Url, [string]$Path, [long]$Size, [string]$Hash) {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        if ((Get-Item -LiteralPath $Path).Length -eq $Size -and (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Hash) { return }
        Move-Item -LiteralPath (Assert-Within $Path $DataDir) -Destination (Assert-Within "$Path.invalid-$([guid]::NewGuid().ToString('N'))" $DataDir)
    }
    $partial = Assert-Within "$Path.download" $DataDir
    if (Test-Path -LiteralPath $partial -PathType Leaf) {
        if ((Get-Item -LiteralPath $partial).Length -ge $Size) {
            if ((Get-Item -LiteralPath $partial).Length -eq $Size -and (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -eq $Hash) {
                Move-Item -LiteralPath $partial -Destination (Assert-Within $Path $DataDir)
                return
            }
            Move-Item -LiteralPath $partial -Destination (Assert-Within "$partial.rejected-$([guid]::NewGuid().ToString('N'))" $DataDir)
        }
    }
    Write-Host "Downloading $(Split-Path -Leaf $Path) from its official source..."
    & curl.exe --fail --location --silent --show-error --connect-timeout 15 --retry 2 --retry-all-errors --continue-at - --max-time 3600 --output $partial $Url
    if ($LASTEXITCODE -ne 0) { throw 'GPT preparation download failed; rerun to retry.' }
    if ((Get-Item -LiteralPath $partial).Length -ne $Size -or (Get-FileHash -LiteralPath $partial -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Hash) { throw 'Size/SHA256 mismatch. Nothing was extracted or activated.' }
    Move-Item -LiteralPath $partial -Destination (Assert-Within $Path $DataDir)
}
function Assert-ArchivePaths([string]$Exe, [string]$Archive, [string]$Prefix = '') {
    $listing = & $Exe l -slt $Archive
    if ($LASTEXITCODE -ne 0) { throw 'Cannot list the verified archive.' }
    foreach ($member in @($listing | Where-Object { $_.StartsWith('Path = ') } | Select-Object -Skip 1)) {
        $relative = $member.Substring(7).Replace('\', '/')
        if ($relative -match '(^|/)\.\.(/|$)' -or $relative.Contains(':') -or [IO.Path]::IsPathRooted($relative) -or ($Prefix -and $relative -ne $Prefix -and -not $relative.StartsWith("$Prefix/"))) { throw 'Unexpected archive member path; extraction stopped.' }
    }
    if ($listing -match '^(Symbolic Link|Hard Link) = .+') { throw 'Unexpected archive link; extraction stopped.' }
}
$required = @(
    'api_v2.py', 'LICENSE', 'runtime/python.exe', 'runtime/Lib/site-packages/torch/version.py',
    'GPT_SoVITS/TTS_infer_pack/TTS.py', 'GPT_SoVITS/configs/tts_infer.yaml',
    'GPT_SoVITS/pretrained_models/s1v3.ckpt', 'GPT_SoVITS/pretrained_models/v2Pro/s2Gv2Pro.pth',
    'GPT_SoVITS/pretrained_models/sv/pretrained_eres2netv2w24s4ep4.ckpt',
    'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/pytorch_model.bin',
    'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/config.json',
    'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large/tokenizer.json',
    'GPT_SoVITS/pretrained_models/chinese-hubert-base/pytorch_model.bin',
    'GPT_SoVITS/pretrained_models/chinese-hubert-base/config.json',
    'GPT_SoVITS/pretrained_models/chinese-hubert-base/preprocessor_config.json'
)
function Test-Installed([string]$Directory) {
    try {
        $marker = Get-Content -LiteralPath (Join-Path $Directory '.aaaagent-installed.json') -Raw | ConvertFrom-Json
        if ($marker.archiveSha256 -ne $archiveHash -or $marker.files.Count -ne $required.Count) { return $false }
        foreach ($relative in $required) {
            $record = @($marker.files | Where-Object { $_.path -eq $relative })
            $file = Join-Path $Directory $relative
            if ($record.Count -ne 1 -or -not (Test-Path -LiteralPath $file -PathType Leaf)) { return $false }
            if ((Get-Item -LiteralPath $file).Length -ne $record[0].size -or (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $record[0].sha256) { return $false }
        }
        return $true
    } catch { return $false }
}
if (-not (Test-Installed $target)) {
    $bootstrap = Join-Path $toolsDir '7zr.exe'
    $extra = Join-Path $toolsDir '7z2603-extra.7z'
    Get-VerifiedDownload 'https://github.com/ip7z/7zip/releases/download/26.03/7zr.exe' $bootstrap 602624 'ad4c82fadcbdf93c03b4fc440f300509c7d60c5c2f4d183e35d9d70d6957037d'
    Get-VerifiedDownload 'https://github.com/ip7z/7zip/releases/download/26.03/7z2603-extra.7z' $extra 1764178 '191894e6acb3647ffb69ce630479ff318523b2e2b9890aa7f05c1127c2e59b8f'
    Assert-ArchivePaths $bootstrap $extra
    & $bootstrap x $extra "-o$toolsDir" -y -bso0 -bsp0
    if ($LASTEXITCODE -ne 0) { throw 'Portable 7-Zip extraction failed.' }
    $sevenZip = Join-Path $toolsDir 'x64/7za.exe'
    $archive = Join-Path $downloads "$bundle.7z"
    Get-VerifiedDownload "https://huggingface.co/lj1995/GPT-SoVITS-windows-package/resolve/$revision/$bundle.7z" $archive 8835144925 $archiveHash
    Assert-ArchivePaths $sevenZip $archive $bundle
    $staging = Join-Path $DataDir ('staging/gpt-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Force -Path $staging | Out-Null
    Write-Host 'Extracting the verified Windows CUDA 12.8 package...'
    & $sevenZip x $archive "-o$staging" -y -bso0 -bsp0
    if ($LASTEXITCODE -ne 0) { throw 'GPT package extraction failed; the previous installation was retained.' }
    $prepared = Assert-Within (Join-Path $staging $bundle) $staging
    $inventory = @($required | ForEach-Object {
        $file = Join-Path $prepared $_
        if (-not (Test-Path -LiteralPath $file -PathType Leaf) -or (Get-Item -LiteralPath $file).Length -eq 0) { throw "Required GPT package resource is missing: $_" }
        @{ path = $_; size = (Get-Item -LiteralPath $file).Length; sha256 = (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
    })
    @{ repository = 'lj1995/GPT-SoVITS-windows-package'; revision = $revision; archiveSha256 = $archiveHash; files = $inventory } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $prepared '.aaaagent-installed.json') -Encoding UTF8
    if (-not (Test-Installed $prepared)) { throw 'Prepared GPT package verification failed.' }
    if (Test-Path -LiteralPath $target) {
        $backup = Assert-Within "$target.incomplete-$([guid]::NewGuid().ToString('N'))" $services
        Move-Item -LiteralPath (Assert-Within $target $services) -Destination $backup
        Write-Host "Retained the previous incomplete installation: $backup"
    }
    Move-Item -LiteralPath $prepared -Destination (Assert-Within $target $services)
}
Write-Host "GPT-SoVITS v2Pro Windows runtime ready: $target"
Write-Host 'Stock weights verify runtime connectivity. Configure your matching fine-tuned weights and voice separately.'
