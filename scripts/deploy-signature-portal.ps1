$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$app='C:\ProgramData\CHZPortal\app'
$stage='C:\ProgramData\CHZPortal\releases\signature-ui-20261005'
$manifest=Get-Content (Join-Path $stage 'manifest.json') -Raw | ConvertFrom-Json
foreach($file in $manifest.files){
  if((Get-FileHash (Join-Path $stage $file.path)).Hash -ne $file.sha256){throw "Release checksum mismatch: $($file.path)"}
  if($file.previousSha256 -and (Get-FileHash (Join-Path $app $file.path)).Hash -ne $file.previousSha256){throw "Live file changed: $($file.path)"}
  if($file.path.EndsWith('.js')){& 'C:\Program Files\nodejs\node.exe' --check (Join-Path $stage $file.path);if($LASTEXITCODE -ne 0){throw 'Syntax error'}}
}
$backup='C:\ProgramData\CHZPortal\backups\signature-'+(Get-Date -Format 'yyyyMMdd-HHmmss')
New-Item -ItemType Directory -Path $backup | Out-Null
foreach($file in $manifest.files){$target=Join-Path $app $file.path;if(Test-Path $target){$copy=Join-Path $backup $file.path;New-Item -ItemType Directory -Path (Split-Path $copy) -Force | Out-Null;Copy-Item -LiteralPath $target -Destination $copy}}
function Stop-Portal {
 Stop-ScheduledTask -TaskName 'CHZ Employee Portal'
 $entry=Join-Path $app 'server.js'
 Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.CommandLine -and $_.CommandLine.Contains($entry)} | ForEach-Object {Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}
 Start-Sleep -Seconds 2
}
try{
 Stop-Portal
 Copy-Item -LiteralPath (Join-Path $app 'data\portal-db.json') -Destination (Join-Path $backup 'portal-db.json')
 foreach($file in $manifest.files){Copy-Item -LiteralPath (Join-Path $stage $file.path) -Destination (Join-Path $app $file.path) -Force}
 Start-ScheduledTask -TaskName 'CHZ Employee Portal'
 $ok=$false
 for($i=0;$i -lt 10;$i++){Start-Sleep -Seconds 2;try{$health=Invoke-RestMethod 'http://127.0.0.1:3040/health' -TimeoutSec 3;if($health.version -eq '2026.10.05.2'){$ok=$true;break}}catch{}}
 if(-not $ok){throw 'Health check failed'}
 [pscustomobject]@{backup=$backup;health=$health}|ConvertTo-Json -Depth 3
}catch{
 $failure=$_.Exception.Message;Stop-Portal
 foreach($file in $manifest.files){$old=Join-Path $backup $file.path;if(Test-Path $old){Copy-Item -LiteralPath $old -Destination (Join-Path $app $file.path) -Force}}
 Start-ScheduledTask -TaskName 'CHZ Employee Portal'
 throw "Source rolled back: $failure. Backup: $backup"
}
