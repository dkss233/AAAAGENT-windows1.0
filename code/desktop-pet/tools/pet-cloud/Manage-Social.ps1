param([ValidateSet('start','stop','restart','status')][string]$Action='status')
$ErrorActionPreference='Stop'
$TaskName='AAAAGENT-SocialMemory-Local'
$ProjectRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
$Data=Join-Path $ProjectRoot '.local/social-service'
$Run=Join-Path $PSScriptRoot 'Run-Social.ps1'
$Config=Get-Content -LiteralPath (Join-Path $Data 'service.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$Task=Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if($Action -in @('stop','restart')){
    if($Task){Stop-ScheduledTask -TaskName $TaskName}
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object {$_.CommandLine -like ('*'+$Run+'*')} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.ExecutablePath -eq $Config.nodePath -and $_.CommandLine -like ('*'+(Join-Path $PSScriptRoot 'cli.mjs')+'*') -and $_.CommandLine -like ('*'+$Data+'*')} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force}
}
if($Action -in @('start','restart')){
    if(-not $Task){
        $Identity=[Security.Principal.WindowsIdentity]::GetCurrent().Name
        $TaskAction=New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "'+$Run+'"')
        $Trigger=New-ScheduledTaskTrigger -AtLogOn -User $Identity
        $Principal=New-ScheduledTaskPrincipal -UserId $Identity -LogonType Interactive -RunLevel Limited
        $Settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
        Register-ScheduledTask -TaskName $TaskName -Action $TaskAction -Trigger $Trigger -Principal $Principal -Settings $Settings | Out-Null
    }
    Enable-ScheduledTask -TaskName $TaskName | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    $Timer=[Diagnostics.Stopwatch]::StartNew();$Ready=$false
    while($Timer.Elapsed.TotalSeconds -lt 30){
        try{$Health=Invoke-RestMethod ('http://127.0.0.1:'+$Config.port+'/health') -TimeoutSec 2;if($Health.ok -and $Health.protocol -eq 1){$Ready=$true;break}}catch{}
        Start-Sleep -Milliseconds 300
    }
    if(-not $Ready){throw 'Social memory service did not become ready within 30 seconds.'}
    Write-Output ('Social memory ready in '+[Math]::Round($Timer.Elapsed.TotalSeconds,1)+'s')
}
if($Action -eq 'status'){
    $Health=Invoke-RestMethod ('http://127.0.0.1:'+$Config.port+'/health') -TimeoutSec 5
    @{ready=$Health.ok;protocol=$Health.protocol;task=(Get-ScheduledTask -TaskName $TaskName).State} | ConvertTo-Json
}
