$ErrorActionPreference = 'Stop'
$BaseDir = $PSScriptRoot
$LogDir = Join-Path $BaseDir 'logs'
$ServerJs = Join-Path $BaseDir 'app\src\server.js'
$StateFile = Join-Path $LogDir 'watchdog-state.json'
$LogFile = Join-Path $LogDir 'watchdog.log'
$TaskName = 'CHZ Office Worker'
New-Item -ItemType Directory -Path $LogDir -Force | Out-Null
function Log([string]$Message) {
  if ((Test-Path $LogFile) -and (Get-Item $LogFile).Length -gt 2MB) { Move-Item -LiteralPath $LogFile -Destination ($LogFile + '.previous') -Force }
  Add-Content -LiteralPath $LogFile -Encoding UTF8 -Value ('{0:o} {1}' -f (Get-Date), $Message)
}
function Start-Worker {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-ScheduledTask -TaskName $TaskName
  Log 'Main task started'
}
try {
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($ServerJs) })
  if ($procs.Count -eq 0) { Start-Worker; exit 0 }
  if (@($procs | Where-Object { ((Get-Date) - $_.CreationDate).TotalSeconds -lt 90 }).Count -gt 0) { exit 0 }
  $healthy = $false
  try {
    $reply = Invoke-RestMethod -Uri 'http://127.0.0.1:3035/health' -TimeoutSec 5
    $healthy = ($reply.ok -eq $true -and $reply.service -eq 'chz-worker')
  } catch { $healthy = $false }
  $state = @{ failures = 0; processIds = '' }
  if (Test-Path $StateFile) { try { $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch {} }
  $processIds = ($procs.ProcessId | Sort-Object) -join ','
  if ($healthy) {
    if ($state.failures -gt 0) { Log 'HTTP recovered without restart' }
    @{ failures = 0; processIds = $processIds } | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
    exit 0
  }
  $failures = 1
  if ($state.processIds -eq $processIds) { $failures = [int]$state.failures + 1 }
  @{ failures = $failures; processIds = $processIds } | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
  Log "HTTP liveness failed: attempt $failures; process ids $processIds"
  if ($failures -lt 2) { exit 0 }
  # Internet loss never triggers a restart; only local application failure.
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  foreach ($proc in $procs) { Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-Worker
} catch { Log $_.Exception.Message; exit 1 }
