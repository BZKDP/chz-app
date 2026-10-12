$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
$stage=Join-Path $root ('work\signature-package-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
Copy-Item (Join-Path $root 'src\bridge-worker.js') (Join-Path $stage 'bridge-worker.js')
Copy-Item (Join-Path $root 'src\signer.js') (Join-Path $stage 'signer.js')
$previous=@('backups\async-20261004\src\bridge-worker.js','backups\sign-retry-20261005\bridge-worker.js','backups\signature-ui-20261005\src\bridge-worker.js') | ForEach-Object {(Get-FileHash (Join-Path $root $_)).Hash}
@{version='2026.10.05.2';files=@(
 @{path='bridge-worker.js';sha256=(Get-FileHash (Join-Path $stage 'bridge-worker.js')).Hash;previousSha256=@($previous)},
 @{path='signer.js';sha256=(Get-FileHash (Join-Path $stage 'signer.js')).Hash;previousSha256=@((Get-FileHash (Join-Path $root 'backups\signature-ui-20261005\src\signer.js')).Hash)}
)} | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $stage 'manifest.json') -Encoding UTF8
$zip=Join-Path $root 'public\chz-worker-signature-20261005-r2.zip'
if(Test-Path $zip){throw 'Pinned archive exists'}
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Get-FileHash $zip | Select-Object Hash,Path
