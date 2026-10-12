param(
    [Parameter(Mandatory = $true)]
    [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
    [string]$LocalFile,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 250)]
    [string]$PrinterName,

    [Parameter(Mandatory = $true)]
    [ValidateLength(1, 120)]
    [string]$DocumentName
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$configPath = Join-Path $root 'data\config.local.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$hostName = [string]$config.signerHost
$userName = if ($config.signerUser) { [string]$config.signerUser } else { 'user' }
$keyPath = if ($config.signerKey) { [string]$config.signerKey } else { Join-Path $env:USERPROFILE '.ssh\chz_signer' }

if ([string]::IsNullOrWhiteSpace($hostName)) { throw 'signerHost is not configured.' }
if (-not (Test-Path -LiteralPath $keyPath -PathType Leaf)) { throw 'SSH key is not available.' }

$jobName = 'chz_' + [Guid]::NewGuid().ToString('N') + '.prn'
$remoteDirectory = 'C:/ProgramData/CHZRemotePrint/inbox'
$remoteFile = "$remoteDirectory/$jobName"
$target = "$userName@$hostName"

$setupCommand = "New-Item -ItemType Directory -Path 'C:\ProgramData\CHZRemotePrint\inbox' -Force | Out-Null"
$setupEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($setupCommand))
& ssh.exe -i $keyPath -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 $target "powershell -NoProfile -NonInteractive -EncodedCommand $setupEncoded"
if ($LASTEXITCODE -ne 0) { throw 'Could not prepare the remote print inbox.' }

& scp.exe -i $keyPath -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 -p -- $LocalFile "${target}:$remoteFile"
if ($LASTEXITCODE -ne 0) { throw 'Could not upload the RAW print job.' }

$escapedPrinter = $PrinterName.Replace("'", "''")
$escapedDocument = $DocumentName.Replace("'", "''")
$remoteCommand = "& 'C:\ProgramData\CHZRemotePrint\office-print-raw.ps1' -FilePath 'C:\ProgramData\CHZRemotePrint\inbox\$jobName' -PrinterName '$escapedPrinter' -DocumentName '$escapedDocument'"
$remoteEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($remoteCommand))
& ssh.exe -i $keyPath -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=10 $target "powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $remoteEncoded"
if ($LASTEXITCODE -ne 0) { throw 'The office computer rejected the RAW print job.' }
