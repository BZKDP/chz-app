$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$base = 'C:\ProgramData\CHZPortal'
$app = Join-Path $base 'app'
$stage = Join-Path $base 'releases\reliability-20260928'
$files = @('server.js','worker-health.js','public\app.js','public\index.html','public\upgrade-chz-worker.ps1','public\chz-worker-reliability-20260928.zip')
$manifest = Get-Content -LiteralPath (Join-Path $stage 'release-manifest.json') -Raw | ConvertFrom-Json
foreach ($file in $manifest.files) {
  if ((Get-FileHash (Join-Path $stage $file.path)).Hash -ne $file.sha256) { throw "Release checksum mismatch: $($file.path)" }
  $target = Join-Path $app $file.path
  if ($file.previousSha256 -and (Test-Path $target)) {
    if ((Get-FileHash $target).Hash -ne $file.previousSha256) { throw "Remote file changed since inspection: $($file.path)" }
  }
}
& 'C:\Program Files\nodejs\node.exe' --check (Join-Path $stage 'server.js')
if ($LASTEXITCODE -ne 0) { throw 'Syntax check failed' }
$port80Before = @(Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
$backup = Join-Path $base ('backups\reliability-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Path $backup | Out-Null
foreach ($file in $files) {
  if (Test-Path (Join-Path $app $file)) {
    $dest = Join-Path $backup $file
    New-Item -ItemType Directory -Path (Split-Path $dest) -Force | Out-Null
    Copy-Item -LiteralPath (Join-Path $app $file) -Destination $dest
  }
}
function Stop-Portal {
  Stop-ScheduledTask -TaskName 'CHZ Employee Portal'
  $entry = Join-Path $app 'server.js'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}
try {
  Stop-Portal
  Copy-Item -LiteralPath (Join-Path $app 'data\portal-db.json') -Destination (Join-Path $backup 'portal-db.json')
  foreach ($file in $files) { Copy-Item -LiteralPath (Join-Path $stage $file) -Destination (Join-Path $app $file) -Force }
  Start-ScheduledTask -TaskName 'CHZ Employee Portal'
  $ok = $false
  for ($attempt = 0; $attempt -lt 10; $attempt++) {
    Start-Sleep -Seconds 2
    try {
      $health = Invoke-RestMethod 'http://127.0.0.1:3040/health' -TimeoutSec 3
      if ($health.version -eq '2026.09.28.1') { $ok = $true; break }
    } catch {}
  }
  if (-not $ok) { throw 'Portal failed health check' }
  $port80After = @(Get-NetTCPConnection -LocalPort 80 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  [pscustomobject]@{ backup=$backup; health=$health; port80Before=$port80Before; port80After=$port80After } | ConvertTo-Json -Depth 4
} catch {
  $failure = $_.Exception.Message
  Stop-Portal
  foreach ($file in $files) { if (Test-Path (Join-Path $backup $file)) { Copy-Item -LiteralPath (Join-Path $backup $file) -Destination (Join-Path $app $file) -Force } }
  Start-ScheduledTask -TaskName 'CHZ Employee Portal'
  throw "Portal rolled back: $failure; backup=$backup"
}
