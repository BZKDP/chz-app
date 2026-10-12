$ErrorActionPreference = 'Stop'
$root = 'C:\ProgramData\CHZPortal'
$env:XDG_DATA_HOME = Join-Path $root 'caddy-data'
$env:XDG_CONFIG_HOME = Join-Path $root 'caddy-config'
Set-Location -LiteralPath $root
& (Join-Path $root 'bin\caddy.exe') run --config (Join-Path $root 'Caddyfile') --adapter caddyfile
exit $LASTEXITCODE
