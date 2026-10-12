$ErrorActionPreference = 'Stop'
$installer = Join-Path (Split-Path $PSScriptRoot) 'public\upgrade-chz-worker.ps1'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile($installer, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
foreach ($name in @('New-ChzTaskDefinitions','Test-ChzTaskDefinitions')) {
  $functionAst = $ast.Find({ param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $false)
  if (-not $functionAst) { throw "Missing installer function: $name" }
  . ([scriptblock]::Create($functionAst.Extent.Text))
}
$account = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$definitions = @(New-ChzTaskDefinitions -Base 'C:\CHZ-Validation-Only' -App 'C:\CHZ-Validation-Only\app' -Account $account)
if ($definitions.Count -ne 3) { throw 'Expected three task definitions' }
Test-ChzTaskDefinitions $definitions
foreach ($definition in $definitions) {
  $xml = [xml](Export-ScheduledTask -InputObject $definition.Task)
  $events = @($definition.Task.Triggers | Where-Object { $_.CimClass.CimClassName -eq 'MSFT_TaskEventTrigger' })
  if ($definition.Name -ne 'CHZ Office Worker') {
    if ($events.Count -ne 1) { throw 'Missing network/wake trigger' }
    if ($events[0].PSObject.TypeNames -notcontains 'Microsoft.Management.Infrastructure.CimInstance#MSFT_TaskTrigger') { throw 'Missing trigger base type' }
    if ($events[0].Subscription -notmatch 'EventID=10000' -or $events[0].Subscription -notmatch 'Power-Troubleshooter') { throw 'Incomplete event subscription' }
  }
  Write-Output ("PASS: {0}; triggers={1}; Windows XML validation successful" -f $definition.Name, $definition.Task.Triggers.Count)
}
Write-Output 'No scheduled tasks registered, no worker stopped, no production data accessed.'
