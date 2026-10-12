$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\CHZPortal'
Set-Location -LiteralPath (Join-Path $root 'app')
& 'C:\Program Files\nodejs\node.exe' (Join-Path $root 'app\server.js') *>> (Join-Path $root 'logs\portal.log')
exit $LASTEXITCODE
