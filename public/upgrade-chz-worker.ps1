$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function New-ChzTaskDefinitions([string]$Base, [string]$App, [string]$Account) {
  $userPrincipal = New-ScheduledTaskPrincipal -UserId $Account -LogonType Interactive -RunLevel Limited
  $mainAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Base 'chz-worker-launch.ps1')) -WorkingDirectory $App
  $mainTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User $Account), (New-ScheduledTaskTrigger -AtStartup))
  $mainSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
  # Load the Windows schema so CIM preserves the MSFT_TaskTrigger base type.
  # -ClassName with -ClientOnly alone creates an untyped inheritance hierarchy.
  $eventClass = Get-CimClass -Namespace 'Root/Microsoft/Windows/TaskScheduler' -ClassName 'MSFT_TaskEventTrigger'
  $networkTrigger = New-CimInstance -CimClass $eventClass -ClientOnly -Property @{
    Enabled = $true
    Delay = 'PT15S'
    Subscription = '<QueryList><Query Id="0" Path="Microsoft-Windows-NetworkProfile/Operational"><Select Path="Microsoft-Windows-NetworkProfile/Operational">*[System[EventID=10000]]</Select></Query><Query Id="1" Path="System"><Select Path="System">*[System[Provider[@Name="Microsoft-Windows-Power-Troubleshooter"] and EventID=1]]</Select></Query></QueryList>'
  }
  $watchAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f (Join-Path $Base 'chz-worker-watchdog-v2.ps1'))
  $watchTriggers = @((New-ScheduledTaskTrigger -AtLogOn -User $Account), (New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)), $networkTrigger)
  $watchSettings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2)
  $clockAction = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\w32tm.exe" -Argument '/resync /force'
  $clockPrincipal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
  $clockTriggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5)), $networkTrigger)
  @(
    [pscustomobject]@{ Name = 'CHZ Office Worker'; Task = (New-ScheduledTask -Action $mainAction -Trigger $mainTriggers -Settings $mainSettings -Principal $userPrincipal) },
    [pscustomobject]@{ Name = 'CHZ Office Worker Watchdog'; Task = (New-ScheduledTask -Action $watchAction -Trigger $watchTriggers -Settings $watchSettings -Principal $userPrincipal) },
    [pscustomobject]@{ Name = 'CHZ Clock Sync'; Task = (New-ScheduledTask -Action $clockAction -Trigger $clockTriggers -Settings $watchSettings -Principal $clockPrincipal) }
  )
}
function Test-ChzTaskDefinitions($Definitions) {
  $scheduler = New-Object -ComObject 'Schedule.Service'
  $scheduler.Connect()
  foreach ($definition in $Definitions) {
    $xml = Export-ScheduledTask -InputObject $definition.Task
    # TASK_VALIDATE_ONLY=1: Windows checks the XML without registering a task.
    $null = $scheduler.GetFolder('\').RegisterTask('CHZ-Installer-Validation', $xml, 1, $null, $null, 0, $null)
  }
}
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Open PowerShell as administrator under the CHZ Windows user and run again.' }
$base = Join-Path $env:LOCALAPPDATA 'CHZWorker'
$app = Join-Path $base 'app'
$server = Join-Path $app 'src\server.js'
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $server)) { throw "CHZ worker not found in this user profile: $base" }
$mainTask = Get-ScheduledTask -TaskName 'CHZ Office Worker'
$taskDefinitions = @(New-ChzTaskDefinitions -Base $base -App $app -Account $mainTask.Principal.UserId)
Test-ChzTaskDefinitions $taskDefinitions
Write-Host 'Installer revision 2: all three scheduled task definitions validated by Windows.'
$before = Invoke-RestMethod -Uri 'http://127.0.0.1:3035/api/status' -TimeoutSec 20
if ($before.bridge.currentJobId) { throw 'A job is being processed. Wait until the queue is idle, then run the update again.' }
$stage = Join-Path $env:TEMP ('chz-update-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$zip = Join-Path $stage 'update.zip'
& curl.exe --fail --silent --show-error --location --connect-timeout 15 --max-time 120 --output $zip 'https://chz.example.com/assets/chz-worker-reliability-20260928.zip'
if ($LASTEXITCODE -ne 0) { throw 'Download failed. No files were changed.' }
$expectedHash = '06C52FB0A041BA205D323A4425DCAA1183FA162451DA2215F3889470F016E170'
if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $expectedHash) { throw 'Package checksum mismatch. No files were changed.' }
$unpacked = Join-Path $stage 'unpacked'
Expand-Archive -LiteralPath $zip -DestinationPath $unpacked
$manifest = Get-Content -LiteralPath (Join-Path $unpacked 'manifest.json') -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
  $source = Join-Path $unpacked $file.path
  $target = [IO.Path]::GetFullPath((Join-Path $base $file.path))
  if (-not $target.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid package path' }
  if ((Get-FileHash $source -Algorithm SHA256).Hash -ne $file.sha256) { throw "Invalid file checksum: $($file.path)" }
  if ($file.previousSha256 -and (Test-Path $target)) {
    $actual = (Get-FileHash $target -Algorithm SHA256).Hash
    if ($actual -ne $file.previousSha256 -and $actual -ne $file.sha256) { throw "File differs from the verified baseline: $($file.path). Update stopped to preserve local changes." }
  }
  if ($file.path.EndsWith('.js')) {
    & $node --check $source
    if ($LASTEXITCODE -ne 0) { throw 'JavaScript syntax check failed' }
  }
}
$backup = Join-Path $base ('backups\reliability-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
$taskNames = @('CHZ Office Worker','CHZ Office Worker Watchdog','CHZ Clock Sync')
foreach ($name in $taskNames) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
    Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $backup ($name + '.xml')) -Encoding UTF8
  }
}
foreach ($file in $manifest.files) {
  $target = Join-Path $base $file.path
  if (Test-Path $target) {
    $copy = Join-Path $backup $file.path
    New-Item -ItemType Directory -Force -Path (Split-Path $copy) | Out-Null
    Copy-Item -LiteralPath $target -Destination $copy
  }
}
$registeredNewTasks = @()
try {
  Stop-ScheduledTask -TaskName 'CHZ Office Worker Watchdog' -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName 'CHZ Office Worker' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($server) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Copy-Item -LiteralPath (Join-Path $app 'data\db.json') -Destination (Join-Path $backup 'db.json')
  foreach ($file in $manifest.files) { Copy-Item -LiteralPath (Join-Path $unpacked $file.path) -Destination (Join-Path $base $file.path) -Force }
  foreach ($definition in $taskDefinitions) {
    Register-ScheduledTask -TaskName $definition.Name -InputObject $definition.Task -Force | Out-Null
    if (-not (Test-Path (Join-Path $backup ($definition.Name + '.xml')))) { $registeredNewTasks += $definition.Name }
  }
  # SYSTEM executes only the protected Windows binary, never a user-writable script.
  Set-Service -Name W32Time -StartupType Automatic
  Start-Service -Name W32Time
  Start-ScheduledTask -TaskName 'CHZ Clock Sync'
  Start-ScheduledTask -TaskName 'CHZ Office Worker'
  $healthy = $false
  for ($attempt = 0; $attempt -lt 12; $attempt++) {
    Start-Sleep -Seconds 3
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:3035/health' -TimeoutSec 3
      if ($health.ok -and $health.bridge.version -eq $manifest.version) { $healthy = $true; break }
    } catch {}
  }
  if (-not $healthy) { throw 'Updated worker did not pass local health check' }
  Start-ScheduledTask -TaskName 'CHZ Office Worker Watchdog'
  Write-Host "Installed version: $($manifest.version)"
  Write-Host "Backup: $backup"
  Write-Host 'Time sync: startup, logon, every 5 minutes. Watchdog: every minute.'
  Start-Sleep -Seconds 12
  $health = Invoke-RestMethod 'http://127.0.0.1:3035/health' -TimeoutSec 5
  $health.bridge | Select-Object version,lastHeartbeatAt,lastHeartbeatError,clockOffsetMs | ConvertTo-Json
} catch {
  $updateError = $_.Exception.Message
  Stop-ScheduledTask -TaskName 'CHZ Office Worker Watchdog' -ErrorAction SilentlyContinue
  Stop-ScheduledTask -TaskName 'CHZ Office Worker' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($server) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  foreach ($file in $manifest.files) {
    $copy = Join-Path $backup $file.path
    if (Test-Path $copy) { Copy-Item -LiteralPath $copy -Destination (Join-Path $base $file.path) -Force }
  }
  foreach ($name in $taskNames) {
    $xml = Join-Path $backup ($name + '.xml')
    if (Test-Path $xml) { Register-ScheduledTask -TaskName $name -Xml (Get-Content -LiteralPath $xml -Raw) -Force | Out-Null }
  }
  foreach ($name in $registeredNewTasks) { Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue }
  Start-ScheduledTask -TaskName 'CHZ Office Worker'
  Start-ScheduledTask -TaskName 'CHZ Office Worker Watchdog' -ErrorAction SilentlyContinue
  throw "Update rolled back: $updateError. Backup: $backup"
}
