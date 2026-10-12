$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$stage = Join-Path $root ('work\async-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$file = 'bridge-worker.js'
Copy-Item -LiteralPath (Join-Path $root "src\$file") -Destination (Join-Path $stage $file)
@{ version='2026.10.04.1'; sha256=(Get-FileHash (Join-Path $stage $file)).Hash; previousSha256=(Get-FileHash (Join-Path $root "backups\async-20261004\src\$file")).Hash } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'manifest.json') -Encoding UTF8
$archive = Join-Path $root 'public\chz-worker-async-20261004.zip'
if (Test-Path $archive) { throw 'Release archive already exists; do not silently replace a pinned release.' }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive
Get-FileHash -LiteralPath $archive | Select-Object Hash,Path
