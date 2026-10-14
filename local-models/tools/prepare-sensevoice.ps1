[CmdletBinding()]
param([string]$DataDir = (Join-Path $PSScriptRoot '../../.local/local-models'))
& (Join-Path $PSScriptRoot 'prepare-model.ps1') -Model sensevoice -DataDir $DataDir
