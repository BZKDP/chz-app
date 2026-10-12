# chz_sign.ps1 — подпись данных сертификатом УКЭП через CryptoPro csptest.
# Разворачивается на офисном ноутбуке (C:\crpt-suz\chz_sign.ps1).
# Вызов приложением по SSH:
#   powershell -ExecutionPolicy Bypass -File C:\crpt-suz\chz_sign.ps1 -Mode auth     -In C:\crpt-suz\<f>  -Thumb <thumbprint>
#   powershell -ExecutionPolicy Bypass -File C:\crpt-suz\chz_sign.ps1 -Mode detached -In C:\crpt-suz\<f>  -Thumb <thumbprint>
# Mode auth     -> присоединённая подпись (для /auth/simpleSignIn — получение clientToken)
# Mode detached -> открепленная CMS-подпись (X-Signature для order/utilisation/dropout)
# На stdout печатается ТОЛЬКО итоговая base64-подпись без пробелов/переносов. Код возврата 0 = успех.
param(
  [Parameter(Mandatory=$true)][ValidateSet('auth','detached')] [string]$Mode,
  [Parameter(Mandatory=$true)] [string]$In,
  [Parameter(Mandatory=$true)] [string]$Thumb,
  [string]$Csptest = 'C:\Program Files\Crypto Pro\CSP\csptest.exe'
)
$ErrorActionPreference = 'Stop'
try {
  if (-not (Test-Path $Csptest)) { throw "csptest not found: $Csptest" }
  if (-not (Test-Path $In))      { throw "input file not found: $In" }
  $out = "$In.sig"
  if (Test-Path $out) { Remove-Item $out -Force }

  $args = @('-sfsign','-sign')
  if ($Mode -eq 'detached') { $args += '-detached' }
  $args += @('-in', $In, '-out', $out, '-my', $Thumb, '-base64', '-add')

  $log = & $Csptest @args 2>&1
  if ($LASTEXITCODE -ne 0) { throw "csptest exit $LASTEXITCODE`n$log" }
  if (-not (Test-Path $out)) { throw "signature file not produced`n$log" }

  $sig = (Get-Content $out -Raw) -replace '\s',''
  if ($sig.Length -lt 100) { throw "signature suspiciously short ($($sig.Length))`n$log" }
  [Console]::Out.Write($sig)
  exit 0
} catch {
  [Console]::Error.Write($_.Exception.Message)
  exit 1
}
