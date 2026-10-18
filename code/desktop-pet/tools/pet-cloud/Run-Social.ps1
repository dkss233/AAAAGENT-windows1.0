$ErrorActionPreference='Stop'
$ProjectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Data=Join-Path $ProjectRoot '.local/social-service'
$Mutex=New-Object System.Threading.Mutex($false,'Local\AAAAGENT-SocialMemory-Local')
try{$Acquired=$Mutex.WaitOne(0)}catch [System.Threading.AbandonedMutexException]{$Acquired=$true}
if(-not $Acquired){exit 0}
$Config=Get-Content -LiteralPath (Join-Path $Data 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Node=$Config.nodePath
if(-not [IO.Path]::IsPathRooted($Node) -or -not (Test-Path -LiteralPath $Node)){throw 'The configured Node runtime is unavailable.'}
foreach($Name in @('PET_SOCIAL_API_KEY','PET_SOCIAL_API_KEY_FILE','PET_SOCIAL_MODEL_ENDPOINT','PET_SOCIAL_MODEL','PET_SOCIAL_HOST','PET_SOCIAL_PORT')){Remove-Item -LiteralPath ('Env:'+$Name) -ErrorAction SilentlyContinue}
$Log=Join-Path $Data 'service.log'
$ErrorLog=Join-Path $Data 'service-error.log'
while($true){
    foreach($File in @($Log,$ErrorLog)){if(Test-Path -LiteralPath $File){Move-Item -LiteralPath $File -Destination ($File+'.previous') -Force}}
    try{
        $Arguments='"'+(Join-Path $PSScriptRoot 'cli.mjs')+'" serve "'+$Data+'"'
        $Child=Start-Process -FilePath $Node -ArgumentList $Arguments -WorkingDirectory (Join-Path $ProjectRoot 'code/desktop-pet') -WindowStyle Hidden -PassThru -RedirectStandardOutput $Log -RedirectStandardError $ErrorLog
        $Child.WaitForExit()
    }catch{Add-Content -LiteralPath (Join-Path $Data 'supervisor.log') -Value ((Get-Date -Format o)+' Social service stopped; retrying in 10 seconds.')}
    Start-Sleep -Seconds 10
}
