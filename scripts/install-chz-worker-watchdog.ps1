$ErrorActionPreference = 'Stop'

$BackupDir = 'C:\Users\user\AppData\Local\CHZWorker\backups\' + (Get-Date -Format 'yyyyMMddHHmmss') + '-scheduler-watchdog'
New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null

$MainTaskName = 'CHZ Office Worker'
$WatchdogTaskName = 'CHZ Office Worker Watchdog'
$WatchdogPath = 'C:\Users\user\AppData\Local\CHZWorker\chz-worker-watchdog.ps1'

if (Get-ScheduledTask -TaskName $MainTaskName -ErrorAction SilentlyContinue) {
  Export-ScheduledTask -TaskName $MainTaskName |
    Set-Content -LiteralPath (Join-Path $BackupDir ($MainTaskName + '.xml')) -Encoding UTF8
}

if (Get-ScheduledTask -TaskName $WatchdogTaskName -ErrorAction SilentlyContinue) {
  Export-ScheduledTask -TaskName $WatchdogTaskName |
    Set-Content -LiteralPath (Join-Path $BackupDir ($WatchdogTaskName + '.xml')) -Encoding UTF8
  Unregister-ScheduledTask -TaskName $WatchdogTaskName -Confirm:$false
}

$Node = 'C:\Program Files\nodejs\node.exe'
$Server = 'C:\Users\user\AppData\Local\CHZWorker\app\src\server.js'
$AppDir = 'C:\Users\user\AppData\Local\CHZWorker\app'

$MainAction = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Server) -WorkingDirectory $AppDir
$MainTriggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User 'DOMAIN\user'),
  (New-ScheduledTaskTrigger -AtStartup)
)
$MainSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
$MainPrincipal = New-ScheduledTaskPrincipal -UserId 'DOMAIN\user' -LogonType Interactive -RunLevel Limited
Set-ScheduledTask -TaskName $MainTaskName -Action $MainAction -Trigger $MainTriggers -Settings $MainSettings -Principal $MainPrincipal | Out-Null

$WatchdogAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "{0}"' -f $WatchdogPath)
$WatchdogTriggers = @(
  (New-ScheduledTaskTrigger -AtLogOn -User 'DOMAIN\user'),
  (New-ScheduledTaskTrigger -AtStartup),
  (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1))
)
$WatchdogSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$WatchdogPrincipal = New-ScheduledTaskPrincipal -UserId 'DOMAIN\user' -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $WatchdogTaskName -Action $WatchdogAction -Trigger $WatchdogTriggers -Settings $WatchdogSettings -Principal $WatchdogPrincipal -Description 'Keeps CHZ Office Worker alive after reboot, logon, Wi-Fi changes and crashes.' -Force | Out-Null

# Keep the CHZ laptop alive while plugged in. Battery sleep stays unchanged to avoid draining it during transport.
powercfg /change standby-timeout-ac 0 | Out-Null
powercfg /change monitor-timeout-ac 30 | Out-Null

Start-ScheduledTask -TaskName $WatchdogTaskName
Start-Sleep -Seconds 4

Get-ScheduledTask | Where-Object TaskName -like 'CHZ Office Worker*' | Select-Object TaskName,State
Get-ScheduledTaskInfo -TaskName $WatchdogTaskName | Select-Object LastRunTime,LastTaskResult,NextRunTime,NumberOfMissedRuns
Get-ScheduledTaskInfo -TaskName $MainTaskName | Select-Object LastRunTime,LastTaskResult,NextRunTime,NumberOfMissedRuns
Write-Host "BackupDir=$BackupDir"
