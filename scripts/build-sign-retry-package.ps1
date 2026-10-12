$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
$stage=Join-Path $root ('work\sign-retry-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $root 'src\bridge-worker.js') (Join-Path $stage 'bridge-worker.js')
$previous=@((Get-FileHash (Join-Path $root 'backups\async-20261004\src\bridge-worker.js')).Hash,(Get-FileHash (Join-Path $root 'backups\sign-retry-20261005\bridge-worker.js')).Hash)
@{version='2026.10.05.1';sha256=(Get-FileHash (Join-Path $stage 'bridge-worker.js')).Hash;previousSha256=$previous} | ConvertTo-Json -Depth 3 | Set-Content (Join-Path $stage 'manifest.json') -Encoding UTF8
$zip=Join-Path $root 'public\chz-worker-async-20261005.zip'
if(Test-Path $zip){throw 'Pinned archive exists'}
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Get-FileHash $zip | Select-Object Hash,Path
