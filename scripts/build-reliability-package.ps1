$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$stage = Join-Path $root ('work\reliability-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$files = @('src\bridge-worker.js','src\bridge-transport.js','src\db.js','src\server.js')
$manifest = @()
foreach ($file in $files) {
  $target = Join-Path $stage ('app\' + $file)
  New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $file) -Destination $target
  $baseline = Join-Path $root ('backups\reliability-20260928\' + $file)
  $oldHash = $null
  if (Test-Path $baseline) { $oldHash = (Get-FileHash $baseline -Algorithm SHA256).Hash }
  $manifest += @{ path = 'app\' + $file; sha256 = (Get-FileHash $target -Algorithm SHA256).Hash; previousSha256 = $oldHash }
}
foreach ($script in @('chz-worker-launch.ps1','chz-worker-watchdog-v2.ps1')) {
  $target = Join-Path $stage $script
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $script) -Destination $target
  $manifest += @{ path = $script; sha256 = (Get-FileHash $target -Algorithm SHA256).Hash; previousSha256 = $null }
}
@{ version = '2026.09.28.1'; files = $manifest } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding UTF8
$archive = Join-Path $root 'public\chz-worker-reliability-20260928.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
Get-FileHash -LiteralPath $archive -Algorithm SHA256 | Select-Object Hash,Path
