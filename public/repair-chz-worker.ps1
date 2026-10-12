$ErrorActionPreference = 'Stop'

$base = Join-Path $env:LOCALAPPDATA 'CHZWorker'
$app = Join-Path $base 'app'
$logs = Join-Path $base 'logs'
$watchdog = Join-Path $base 'chz-worker-watchdog.ps1'
$node = 'C:\Program Files\nodejs\node.exe'
$server = Join-Path $app 'src\server.js'
$mainTask = 'CHZ Office Worker'
$watchdogTask = 'CHZ Office Worker Watchdog'

New-Item -ItemType Directory -Path $logs -Force | Out-Null
$repairLog = Join-Path $logs 'repair.log'
function Log($message) {
  Add-Content -LiteralPath $repairLog -Encoding UTF8 -Value ('{0:s} {1}' -f (Get-Date), $message)
  Write-Host $message
}

if (-not (Test-Path -LiteralPath $server)) { throw "CHZ worker not found: $server" }
if (-not (Test-Path -LiteralPath $node)) { throw "Node not found: $node" }

$watchdogBody = @'
$ErrorActionPreference = 'Stop'

$BaseDir = Join-Path $env:LOCALAPPDATA 'CHZWorker'
$AppDir = Join-Path $BaseDir 'app'
$LogDir = Join-Path $BaseDir 'logs'
$NodeExe = 'C:\Program Files\nodejs\node.exe'
$ServerJs = Join-Path $AppDir 'src\server.js'
$TaskName = 'CHZ Office Worker'
$Port = 3035

New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
$LogFile = Join-Path $LogDir 'watchdog.log'

function Write-WatchdogLog {
  param([string]$Message)
  Add-Content -LiteralPath $LogFile -Value ('{0:s} {1}' -f (Get-Date), $Message) -Encoding UTF8
}

function Get-WorkerProcess {
  Get-CimInstance Win32_Process | Where-Object {
    $_.CommandLine -and $_.CommandLine -like '*node.exe*' -and $_.CommandLine -like ('*' + $ServerJs + '*')
  }
}

function Test-WorkerHttp {
  try {
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$Port/api/status" -TimeoutSec 8
    return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500)
  } catch {
    Write-WatchdogLog ('http check failed: ' + $_.Exception.Message)
    return $false
  }
}

function Start-Worker {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $TaskName
    Write-WatchdogLog "started scheduled task '$TaskName'"
    return
  }
  Start-Process -FilePath $NodeExe -ArgumentList ('"{0}"' -f $ServerJs) -WorkingDirectory $AppDir -WindowStyle Hidden
  Write-WatchdogLog 'started worker process directly'
}

try {
  $procs = @(Get-WorkerProcess)
  if ($procs.Count -eq 0) {
    Write-WatchdogLog 'worker process is absent; starting'
    Start-Worker
    exit 0
  }

  if (-not (Test-WorkerHttp)) {
    Write-WatchdogLog ("worker HTTP is unhealthy; restarting exact process ids: {0}" -f (($procs | Select-Object -ExpandProperty ProcessId) -join ','))
    foreach ($proc in $procs) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Seconds 3
    Start-Worker
    exit 0
  }

  Write-WatchdogLog ("ok process ids: {0}; http healthy" -f (($procs | Select-Object -ExpandProperty ProcessId) -join ','))
} catch {
  Write-WatchdogLog ('error: ' + $_.Exception.Message)
  exit 1
}
'@

Set-Content -LiteralPath $watchdog -Encoding UTF8 -Value $watchdogBody
Log "watchdog updated: $watchdog"

$procs = @(Get-CimInstance Win32_Process | Where-Object {
  $_.CommandLine -and $_.CommandLine -like '*node.exe*' -and $_.CommandLine -like ('*' + $server + '*')
})
foreach ($proc in $procs) {
  Log "stopping stuck worker pid $($proc.ProcessId)"
  Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
}

foreach ($task in @($mainTask, $watchdogTask)) {
  if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $task
    Log "started task: $task"
  } else {
    Log "task not found: $task"
  }
}

Start-Sleep -Seconds 10
try {
  $local = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3035/api/status' -TimeoutSec 15
  Log "local worker status HTTP $($local.StatusCode)"
} catch {
  Log ('local worker status failed: ' + $_.Exception.Message)
}

try {
  $portal = Invoke-WebRequest -UseBasicParsing -Uri 'https://chz.example.com/health' -TimeoutSec 15
  Log "portal health: $($portal.Content)"
} catch {
  Log ('portal health failed: ' + $_.Exception.Message)
}

Write-Host ''
Write-Host 'Готово. Если portal health показывает workerOnline=true, сайт снова видит ПК с ЧЗ.'
