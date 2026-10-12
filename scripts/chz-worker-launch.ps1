$ErrorActionPreference = 'Stop'
$base = $PSScriptRoot
$logs = Join-Path $base 'logs'
New-Item -ItemType Directory -Force -Path $logs | Out-Null
foreach ($file in @('worker.stdout.log', 'worker.stderr.log')) {
  $logPath = Join-Path $logs $file
  if (Test-Path $logPath) { Move-Item -LiteralPath $logPath -Destination ($logPath + '.previous') -Force }
}
$worker = Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList ('"{0}"' -f (Join-Path $base 'app\src\server.js')) -WorkingDirectory (Join-Path $base 'app') -WindowStyle Hidden -RedirectStandardOutput (Join-Path $logs 'worker.stdout.log') -RedirectStandardError (Join-Path $logs 'worker.stderr.log') -PassThru -Wait
exit $worker.ExitCode
