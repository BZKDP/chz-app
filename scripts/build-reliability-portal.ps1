$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$stage = Join-Path $root 'work\portal-reliability-20260928'
New-Item -ItemType Directory -Path (Join-Path $stage 'public') -Force | Out-Null
$entries = @(
  @{ source='remote-site\server.js'; target='server.js'; old='remote-site\server.js' },
  @{ source='remote-site\worker-health.js'; target='worker-health.js' },
  @{ source='public\app.js'; target='public\app.js'; old='public\app.js' },
  @{ source='public\index.html'; target='public\index.html'; old='public\index.html' },
  @{ source='public\upgrade-chz-worker.ps1'; target='public\upgrade-chz-worker.ps1' },
  @{ source='public\chz-worker-reliability-20260928.zip'; target='public\chz-worker-reliability-20260928.zip' }
)
$manifest = @()
foreach ($entry in $entries) {
  $source = Join-Path $root $entry.source
  Copy-Item -LiteralPath $source -Destination (Join-Path $stage $entry.target) -Force
  $oldHash = $null
  if ($entry.old) { $oldHash = (Get-FileHash (Join-Path $root ('backups\reliability-20260928\' + $entry.old))).Hash }
  $manifest += @{path=$entry.target;sha256=(Get-FileHash $source).Hash;previousSha256=$oldHash}
}
@{ files=$manifest } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $stage 'release-manifest.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'deploy-reliability-portal.ps1') -Destination (Join-Path $stage 'deploy.ps1') -Force
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath (Join-Path $root 'work\portal-reliability-20260928.zip') -Force
Get-FileHash (Join-Path $root 'work\portal-reliability-20260928.zip') | Select-Object Hash,Path
