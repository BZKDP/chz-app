$ErrorActionPreference = 'Stop'
$base = 'C:\ProgramData\CHZPortal'
$log = Join-Path $base 'logs\watchdog.log'
$statePath = Join-Path $base 'logs\watchdog-state.json'
function Log([string]$message) {
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 2MB) { Move-Item -LiteralPath $log -Destination ($log + '.previous') -Force }
  Add-Content -LiteralPath $log -Encoding UTF8 -Value ('{0:o} {1}' -f (Get-Date), $message)
}
$state = @{ portal = 0; gateway = 0 }
if (Test-Path $statePath) { try { $state = Get-Content $statePath -Raw | ConvertFrom-Json } catch {} }
$portalOk = $false
try { $reply = Invoke-RestMethod 'http://127.0.0.1:3040/health' -TimeoutSec 5; $portalOk = $reply.ok -eq $true } catch {}
if ($portalOk) { $state.portal = 0 } else { $state.portal = [int]$state.portal + 1; Log 'Portal HTTP check failed' }
$gatewayOk = $false
if ($portalOk) {
  try {
    $text = & curl.exe --noproxy '*' --silent --show-error --fail --max-time 8 --resolve 'chz.example.com:443:127.0.0.1' 'https://chz.example.com/health' 2>$null
    if ($LASTEXITCODE -eq 0) { $gatewayOk = ($text | ConvertFrom-Json).ok -eq $true }
  } catch {}
  if ($gatewayOk) { $state.gateway = 0 } else { $state.gateway = [int]$state.gateway + 1; Log 'Local HTTPS gateway check failed' }
} else { $state.gateway = 0 }
if ($state.portal -ge 2) {
  Log 'Restarting only CHZ Employee Portal'
  Stop-ScheduledTask -TaskName 'CHZ Employee Portal'
  $entry = Join-Path $base 'app\server.js'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($entry) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName 'CHZ Employee Portal'
  $state.portal = 0
}
if ($state.gateway -ge 2) {
  Log 'Restarting only CHZ HTTPS Gateway'
  Stop-ScheduledTask -TaskName 'CHZ HTTPS Gateway'
  $binary = Join-Path $base 'bin\caddy.exe'
  Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" | Where-Object { $_.ExecutablePath -eq $binary } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName 'CHZ HTTPS Gateway'
  $state.gateway = 0
}
$state | ConvertTo-Json | Set-Content -LiteralPath $statePath -Encoding UTF8
