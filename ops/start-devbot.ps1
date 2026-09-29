<#
.SYNOPSIS
Scheduled-task entry for GOJO (the dev Discord bot). Runs ops\supervisor.mjs, which keeps the
bot alive, pulls the devbot branch before each start and reads tokens from Windows Credential
Manager (DEX_DISCORD_DEVBOT) and the gh CLI keyring.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File D:\Dex\Servers\devbot\repo\ops\start-devbot.ps1

Windows PowerShell 5.1 compatible. ASCII only.
#>
[CmdletBinding()]
param(
    [string]$HomeDir = 'D:\Dex\Servers\devbot',
    [switch]$NoPull
)
$ErrorActionPreference = 'Stop'
$node = (Get-Command node.exe -ErrorAction Stop).Source
$supervisor = Join-Path $PSScriptRoot 'supervisor.mjs'
$argsList = @($supervisor, '--home', $HomeDir)
if ($NoPull) { $argsList += '--no-pull' }
& $node @argsList
exit $LASTEXITCODE
