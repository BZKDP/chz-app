$ErrorActionPreference = 'Stop'

$BaseDir = 'C:\Users\user\AppData\Local\CHZWorker'
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
  $line = '{0:s} {1}' -f (Get-Date), $Message
  Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8
}

function Get-WorkerProcess {
  Get-CimInstance Win32_Process |
    Where-Object {
      $_.CommandLine -and
      $_.CommandLine -like '*node.exe*' -and
      $_.CommandLine -like ('*' + $ServerJs + '*')
    }
}

function Test-WorkerPort {
  $client = $null
  try {
    $client = [Net.Sockets.TcpClient]::new()
    $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(2000)) { return $false }
    $client.EndConnect($async)
    return $true
  } catch {
    return $false
  } finally {
    if ($client) { $client.Close() }
  }
}

function Start-Worker {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Start-ScheduledTask -TaskName $TaskName
    Write-WatchdogLog "started scheduled task '$TaskName'"
    return
  }

  $stdout = Join-Path $LogDir 'worker.stdout.log'
  $stderr = Join-Path $LogDir 'worker.stderr.log'
  Start-Process -FilePath $NodeExe -ArgumentList ('"{0}"' -f $ServerJs) -WorkingDirectory $AppDir -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Write-WatchdogLog 'started worker process directly'
}

try {
  if (-not (Test-Path -LiteralPath $NodeExe)) { throw "Node is missing: $NodeExe" }
  if (-not (Test-Path -LiteralPath $ServerJs)) { throw "Worker server is missing: $ServerJs" }

  $procs = @(Get-WorkerProcess)
  $portOk = Test-WorkerPort

  if ($procs.Count -eq 0) {
    Write-WatchdogLog 'worker process is absent; starting'
    Start-Worker
    exit 0
  }

  if (-not $portOk) {
    Write-WatchdogLog ("worker process exists but port {0} is closed; restarting exact process ids: {1}" -f $Port, (($procs | Select-Object -ExpandProperty ProcessId) -join ','))
    foreach ($proc in $procs) {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 2
    Start-Worker
    exit 0
  }

  Write-WatchdogLog ("ok process ids: {0}; port {1} open" -f (($procs | Select-Object -ExpandProperty ProcessId) -join ','), $Port)
} catch {
  Write-WatchdogLog ("error: " + $_.Exception.Message)
  exit 1
}
