$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
$stage=Join-Path $root ('work\async-portal-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
$mapping=@{
  'server.js'='remote-site\server.js'
  'public\app.js'='public\app.js'
  'public\index.html'='public\index.html'
  'public\styles.css'='public\styles.css'
  'public\upgrade-chz-async.ps1'='public\upgrade-chz-async.ps1'
  'public\chz-worker-async-20261004.zip'='public\chz-worker-async-20261004.zip'
}
$files=@()
foreach($dest in $mapping.Keys){
  $target=Join-Path $stage $dest
  New-Item -ItemType Directory -Path (Split-Path $target) -Force | Out-Null
  Copy-Item -LiteralPath (Join-Path $root $mapping[$dest]) -Destination $target
  $old=Join-Path $root ('backups\async-20261004\'+$mapping[$dest])
  $previous=$null
  if(Test-Path $old){$previous=(Get-FileHash $old).Hash}
  $files+=@{path=$dest;sha256=(Get-FileHash $target).Hash;previousSha256=$previous}
}
@{files=$files;version='2026.10.04.1'} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'release-manifest.json') -Encoding UTF8
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'deploy-async-portal.ps1') -Destination (Join-Path $stage 'deploy.ps1')
$archive=Join-Path $root 'work\async-portal-20261004.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $archive -Force
Get-FileHash $archive | Select-Object Hash,Path
