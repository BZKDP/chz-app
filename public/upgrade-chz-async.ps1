$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run PowerShell as administrator under the CHZ user.' }
$base = Join-Path $env:LOCALAPPDATA 'CHZWorker'
$app = Join-Path $base 'app'
$target = Join-Path $app 'src\bridge-worker.js'
$server = Join-Path $app 'src\server.js'
$node = 'C:\Program Files\nodejs\node.exe'
if (-not (Test-Path $target)) { throw "Worker not found: $app" }
$health = Invoke-RestMethod 'http://127.0.0.1:3035/health' -TimeoutSec 5
if ($health.bridge.version -eq '2026.10.05.2') { Write-Host 'Already installed: 2026.10.05.2'; return }
if ($health.bridge.version -notin @('2026.09.28.1','2026.10.04.1','2026.10.05.1')) { throw 'Unexpected worker version. No changes made.' }
$stage = Join-Path $env:TEMP ('chz-async-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$zip = Join-Path $stage 'release.zip'
& curl.exe --fail --silent --show-error --location --connect-timeout 15 --max-time 90 --output $zip 'https://chz.example.com/assets/chz-worker-signature-20261005-r2.zip'
if ($LASTEXITCODE -ne 0) { throw 'Download failed. No changes made.' }
if ((Get-FileHash $zip).Hash -ne '62EB4E43447F7BDAC9B4169A419533FD807A8B9F95F5AE4BFBC05D9F63EA09BF') { throw 'Release checksum mismatch. No changes made.' }
Expand-Archive -LiteralPath $zip -DestinationPath (Join-Path $stage 'release')
$manifest = Get-Content (Join-Path $stage 'release\manifest.json') -Raw | ConvertFrom-Json
if ($manifest.version -ne '2026.10.05.2' -or $manifest.files.Count -ne 2) { throw 'Invalid release contents.' }
foreach ($file in $manifest.files) {
  if ($file.path -notin @('bridge-worker.js','signer.js')) { throw 'Invalid file path' }
  $source=Join-Path $stage ('release\'+$file.path)
  $installed=Join-Path $app ('src\'+$file.path)
  if ((Get-FileHash $source).Hash -ne $file.sha256) { throw 'Invalid source checksum' }
  if ((Get-FileHash $installed).Hash -notin $file.previousSha256) { throw "Local changes in $($file.path). Update stopped." }
  & $node --check $source
  if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed.' }
}
$taskNames = @('CHZ Office Worker Watchdog','CHZ Office Worker')
foreach ($name in $taskNames) { $null = Get-ScheduledTask -TaskName $name }
function Set-ClaimPause([string]$Mode) {
  # The installed config and HMAC secret stay in this process, never in output.
  $js = @'
const p=require('path'),a=process.argv[1],c=require(p.join(a,'src/config.js')),t=require(p.join(a,'src/bridge-transport.js')).createTransport({secret:c.bridge.secret,workerId:c.bridge.workerId}); t.request('POST',c.bridge.url+'/maintenance',{pause:process.argv[2]==='pause'}).then(()=>process.exit(0)).catch(()=>{console.error('Portal maintenance request failed');process.exit(1)});
'@
  & $node -e $js $app $Mode
  if ($LASTEXITCODE -ne 0) { throw 'Could not safely pause/resume claims.' }
}
$stopped = $false
$backup = $null
try {
  Set-ClaimPause 'pause'
  # Claim pause is acknowledged before idle check; no job can start in between.
  $health = Invoke-RestMethod 'http://127.0.0.1:3035/health' -TimeoutSec 5
  for ($i=0; $i -lt 20 -and $health.bridge.running -and -not $health.bridge.currentJobId; $i++) {
    Start-Sleep -Milliseconds 500
    $health = Invoke-RestMethod 'http://127.0.0.1:3035/health' -TimeoutSec 5
  }
  if ($health.bridge.currentJobId -or $health.bridge.running) { throw 'Worker is busy. Wait until current processing finishes, then run this update again.' }
  $backup = Join-Path $base ('backups\async-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  New-Item -ItemType Directory -Path $backup | Out-Null
  foreach ($file in $manifest.files) { Copy-Item -LiteralPath (Join-Path $app ('src\'+$file.path)) -Destination (Join-Path $backup $file.path) }
  $stopped = $true
  foreach ($name in $taskNames) { Disable-ScheduledTask -TaskName $name | Out-Null }
  foreach ($name in $taskNames) { Stop-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue }
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($server) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Copy-Item -LiteralPath (Join-Path $app 'data\db.json') -Destination (Join-Path $backup 'db.json')
  foreach ($file in $manifest.files) { Copy-Item -LiteralPath (Join-Path $stage ('release\'+$file.path)) -Destination (Join-Path $app ('src\'+$file.path)) -Force }
  Enable-ScheduledTask -TaskName 'CHZ Office Worker' | Out-Null
  Start-ScheduledTask -TaskName 'CHZ Office Worker'
  $healthy = $false
  for ($attempt=0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Seconds 2
    try { $health = Invoke-RestMethod 'http://127.0.0.1:3035/health' -TimeoutSec 3; if ($health.ok -and $health.bridge.version -eq $manifest.version) { $healthy=$true; break } } catch {}
  }
  if (-not $healthy) { throw 'New worker failed health check.' }
  Write-Host "Installed: $($manifest.version). Backup: $backup"
} catch {
  if ($stopped -and $backup) {
    Stop-ScheduledTask -TaskName 'CHZ Office Worker' -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($server) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    foreach ($file in $manifest.files) { Copy-Item -LiteralPath (Join-Path $backup $file.path) -Destination (Join-Path $app ('src\'+$file.path)) -Force }
    Write-Host "Source rolled back. Order database was not rolled back. Backup: $backup"
  }
  throw
} finally {
  if ($stopped) {
    foreach ($name in $taskNames) { Enable-ScheduledTask -TaskName $name | Out-Null; Start-ScheduledTask -TaskName $name }
  }
  try { Set-ClaimPause 'resume' } catch { Write-Warning 'Claims will resume automatically within 3 minutes.' }
}
