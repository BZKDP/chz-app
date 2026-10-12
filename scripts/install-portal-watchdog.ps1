$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = 'C:\ProgramData\CHZPortal'
$backup = Join-Path $base ('backups\watchdog-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup -Force | Out-Null
foreach ($name in @('CHZ Employee Portal','CHZ HTTPS Gateway','CHZ Portal Watchdog')) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $backup ($name + '.xml')) -Encoding UTF8 }
}
$target = Join-Path $base 'portal-watchdog.ps1'
if (Test-Path $target) { Copy-Item -LiteralPath $target -Destination (Join-Path $backup 'portal-watchdog.ps1') }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'portal-watchdog.ps1') -Destination $target -Force
foreach ($name in @('CHZ Employee Portal','CHZ HTTPS Gateway')) {
  $task = Get-ScheduledTask -TaskName $name
  $task.Settings.RestartCount = 999
  $task.Settings.RestartInterval = 'PT1M'
  $task.Settings.StartWhenAvailable = $true
  Set-ScheduledTask -InputObject $task | Out-Null
}
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $target)
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)))
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
Register-ScheduledTask -TaskName 'CHZ Portal Watchdog' -Action $action -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
& $target
Write-Output "Watchdog installed; backup=$backup"
Get-Content (Join-Path $base 'logs\watchdog-state.json')
