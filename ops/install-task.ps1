<#
.SYNOPSIS
Registers (or updates) the scheduled task \Dex\Dex Devbot: starts GOJO at logon for the current
user and restarts the supervisor if it ever exits with an error. Idempotent.

.EXAMPLE
powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:\Dex\Servers\devbot\repo\ops\install-task.ps1 -StartNow

Windows PowerShell 5.1 compatible. ASCII only.
#>
[CmdletBinding()]
param(
    [string]$HomeDir = 'D:\Dex\Servers\devbot',
    [string]$TaskPath = '\Dex\',
    [string]$TaskName = 'Dex Devbot',
    [switch]$StartNow
)
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'start-devbot.ps1'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{0}" -HomeDir "{1}"' -f $script, $HomeDir
$action = New-ScheduledTaskAction -Execute $ps -Argument $arguments -WorkingDirectory $HomeDir
$user = "$env:USERDOMAIN\$env:USERNAME"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'GOJO SATORU: dev Discord bot for the sam altman office server (commit feeds, source access, feedback). Source: github.com/dexnotavailable/dex-builds branch devbot.'
Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject $task -Force | Out-Null
if ($StartNow) { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName }
$info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName
[pscustomobject]@{ task = "$TaskPath$TaskName"; state = (Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName).State; lastRun = $info.LastRunTime } | ConvertTo-Json
