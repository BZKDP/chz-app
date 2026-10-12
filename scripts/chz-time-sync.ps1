$ErrorActionPreference = 'Stop'
# Runs under SYSTEM; keeps the existing time source, timezone and domain policy.
Start-Service -Name W32Time
& "$env:WINDIR\System32\w32tm.exe" /resync /force
exit $LASTEXITCODE
