$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$logDir = Join-Path $projectRoot 'logs'
$logFile = Join-Path $logDir 'chz-app.log'
$node = (Get-Command node.exe -ErrorAction Stop).Source

New-Item -ItemType Directory -Force -Path $logDir | Out-Null
Set-Location -LiteralPath $projectRoot

"[$(Get-Date -Format o)] Starting chz-app" | Out-File -FilePath $logFile -Append -Encoding utf8
& $node (Join-Path $projectRoot 'src\server.js') *>> $logFile

