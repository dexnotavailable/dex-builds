<#
.SYNOPSIS
Registers (or updates) the scheduled task \Dex\Dex Devbot: starts GOJO at logon for the current
user, and again every 5 minutes if the supervisor is not running (a tick while it is alive is a
no-op, and the launch is headless so nothing flashes on screen). Idempotent.

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
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
# conhost --headless gives powershell no console at all, so a relaunch never pops a window
$arguments = '--headless "{0}" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -HomeDir "{2}"' -f $ps, $script, $HomeDir
$action = New-ScheduledTaskAction -Execute $conhost -Argument $arguments -WorkingDirectory $HomeDir
$user = "$env:USERDOMAIN\$env:USERNAME"
$logon = New-ScheduledTaskTrigger -AtLogOn -User $user
# MultipleInstances IgnoreNew (below) makes each tick do nothing while the supervisor is alive
$tick = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$task = New-ScheduledTask -Action $action -Trigger @($logon, $tick) -Settings $settings -Principal $principal `
    -Description 'GOJO SATORU: dev Discord bot for the sam altman office server (commit feeds, source access, feedback). Source: github.com/dexnotavailable/dex-builds branch devbot.'
Register-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName -InputObject $task -Force | Out-Null
if ($StartNow) { Start-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName }
$info = Get-ScheduledTaskInfo -TaskPath $TaskPath -TaskName $TaskName
[pscustomobject]@{ task = "$TaskPath$TaskName"; state = (Get-ScheduledTask -TaskPath $TaskPath -TaskName $TaskName).State; lastRun = $info.LastRunTime } | ConvertTo-Json
