$ErrorActionPreference='Stop'
$root=Split-Path $PSScriptRoot
$stage=Join-Path $root ('work\signature-portal-'+[guid]::NewGuid().ToString('N'))
$map=@{'server.js'='remote-site\server.js';'worker-health.js'='remote-site\worker-health.js';'public\app.js'='public\app.js';'public\index.html'='public\index.html';'public\styles.css'='public\styles.css';'public\upgrade-chz-async.ps1'='public\upgrade-chz-async.ps1';'public\chz-worker-signature-20261005-r2.zip'='public\chz-worker-signature-20261005-r2.zip'}
$files=@()
foreach($dest in $map.Keys){
 $target=Join-Path $stage $dest;New-Item -ItemType Directory -Path (Split-Path $target) -Force|Out-Null
 Copy-Item -LiteralPath (Join-Path $root $map[$dest]) -Destination $target
 $old=Join-Path $root ('backups\signature-ui-20261005\'+$map[$dest]);$previous=$null
 if(Test-Path $old){$previous=(Get-FileHash $old).Hash}
 $files+=@{path=$dest;sha256=(Get-FileHash $target).Hash;previousSha256=$previous}
}
@{version='2026.10.05.2';files=$files}|ConvertTo-Json -Depth 4|Set-Content (Join-Path $stage 'manifest.json') -Encoding UTF8
Copy-Item (Join-Path $PSScriptRoot 'deploy-signature-portal.ps1') (Join-Path $stage 'deploy.ps1')
$zip=Join-Path $root 'work\signature-portal-20261005.zip'
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -Force
Get-FileHash $zip | Select-Object Hash,Path
