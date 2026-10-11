param([switch]$KeepFixtures)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $repository 'scripts\QStudy.Install.ps1')
$parent = Join-Path $repository ('.local\ocr-tests\' + [Guid]::NewGuid().ToString('N'))
$fixture = Join-Path $parent 'Проект OCR с пробелами'
[IO.Directory]::CreateDirectory((Join-Path $fixture 'backend')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $fixture 'frontend')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $fixture 'scripts')) | Out-Null
foreach ($relative in @('backend\requirements.txt', 'frontend\package.json', 'frontend\package-lock.json', 'scripts\qstudy_ocr.ps1')) {
    Copy-Item -LiteralPath (Join-Path $repository $relative) -Destination (Join-Path $fixture $relative)
}
$script:passed = 0
function Assert-Ocr([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAIL: ' + $Message) }
    $script:passed++
    Write-Host ('PASS: ' + $Message)
}
function Write-TestProbe([string]$Body) {
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\qstudy_ocr.ps1'), $Body, [Text.UTF8Encoding]::new($true))
}
function Clear-TestOcrState {
    $state = Join-Path $fixture '.local\ocr-runtime.json'
    if (Test-Path -LiteralPath $state) { Remove-Item -LiteralPath $state -Force }
}
try {
    # Exercise the actual fixed Windows PowerShell / WinRT bridge with no manifest.
    # The current host has Russian installed; a fresh host may report it missing.
    $real = Get-QStudyOcrProbe $fixture
    Assert-Ocr ($real.reason -in @('ready', 'missing_russian_language')) 'Real CheckOnly returns a valid OCR readiness result'
    Assert-Ocr (-not (Test-Path -LiteralPath (Join-Path $fixture '.local'))) 'CheckOnly creates no local marker or manifest'
    if ($real.ok) {
        Assert-Ocr ($real.language -match '^ru(?:-[A-Za-z0-9]+)*$') 'Actual Russian recognizer is detected without installation or UAC'
    }
    $binary = Get-QStudyOcrPowerShell
    Assert-Ocr ($binary -and $binary.EndsWith('\WindowsPowerShell\v1.0\powershell.exe')) 'Probe uses the fixed system Windows PowerShell path'
    Write-TestProbe 'param([switch]$CheckOnly); [Console]::WriteLine(''{"ok":true,"language":"en-US","reason":"ready"}'')'
    Assert-Ocr ((Get-QStudyOcrProbe $fixture).reason -eq 'invalid_probe') 'An English-only recognizer cannot be reported as Russian-ready'
    Write-TestProbe 'param([switch]$CheckOnly); [Console]::WriteLine(''{"ok":"true","language":"ru","reason":"ready"}'')'
    Assert-Ocr ((Get-QStudyOcrProbe $fixture).reason -eq 'invalid_probe') 'Malformed readiness types are rejected'
    Write-TestProbe 'param([switch]$CheckOnly); [Console]::WriteLine(''not-json'')'
    Assert-Ocr (-not (Get-QStudyOcrProbe $fixture).ok) 'Invalid child JSON is a nonfatal unavailable probe'
    Write-TestProbe 'param([switch]$CheckOnly); [Console]::Error.WriteLine(''DO_NOT_EXPOSE_CHILD_ERROR''); exit 7'
    $failedProbe = Get-QStudyOcrProbe $fixture
    Assert-Ocr ($failedProbe.reason -eq 'invalid_probe' -and ($failedProbe | ConvertTo-Json) -notmatch 'DO_NOT_EXPOSE') 'Child errors never leak into readiness responses'
    $readOnlyDism = @'
param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$PSModuleAutoLoadingPreference = 'None'
Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -Force -ErrorAction Stop
$windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
Import-Module -Name ([IO.Path]::Combine($windows, 'System32\WindowsPowerShell\v1.0\Modules\Dism\Dism.psd1')) -Force -ErrorAction Stop
$add = Get-Command 'Dism\Add-WindowsCapability' -ErrorAction Stop
if ($null -ne $add) { [Console]::WriteLine('{"ok":true,"language":"ru","reason":"ready"}') }
'@
    Write-TestProbe $readOnlyDism
    Assert-Ocr ((Get-QStudyOcrProbe $fixture).ok) 'System Utility and DISM import with autoload disabled without running a Windows capability command'
    Remove-Item -LiteralPath (Join-Path $fixture 'scripts\qstudy_ocr.ps1') -Force
    Assert-Ocr ((Get-QStudyOcrProbe $fixture).reason -eq 'helper_missing') 'Copied base fixtures without OCR helpers remain supported'

    # Parse and constrain the elevated entry point; never execute it in this test.
    $tokens = $null; $parseErrors = $null
    $helperPath = Join-Path $repository 'scripts\Install-QStudyOcrCapability.ps1'
    $helperAst = [Management.Automation.Language.Parser]::ParseFile($helperPath, [ref]$tokens, [ref]$parseErrors)
    Assert-Ocr (@($parseErrors).Count -eq 0) 'Fixed elevated helper parses under Windows PowerShell 5.1'
    Assert-Ocr ($helperAst.ParamBlock.Parameters.Count -eq 0) 'Elevated entry point accepts no commands, capability names, URLs, or output paths'
    $helperSource = [IO.File]::ReadAllText($helperPath)
    Assert-Ocr ($helperSource.Contains('Language.Basic~~~ru-RU~0.0.1.0') -and $helperSource.Contains('Language.OCR~~~ru-RU~0.0.1.0')) 'Only the fixed Russian Basic and OCR capabilities are provisioned'
    $commands = @($helperAst.FindAll({ param($node) $node -is [Management.Automation.Language.CommandAst] }, $true) | ForEach-Object { $_.GetCommandName() })
    Assert-Ocr ($commands -notcontains 'Restart-Computer' -and $commands -notcontains 'shutdown' -and $helperSource -notmatch 'File\]::(Open|Write)' -and $commands -notcontains 'ConvertTo-Json') 'Elevated provisioning never reboots or writes any project/result file'
    Assert-Ocr ($helperSource.Contains("`$env:PSModulePath = [IO.Path]::Combine(`$PSHOME, 'Modules')") -and $helperSource.Contains("`$PSModuleAutoLoadingPreference = 'None'")) 'Elevated child disables user module autoload before importing fixed system DISM'
    Assert-Ocr ((ConvertFrom-QStudyOcrExitCode 0).reason -eq 'installed' -and (ConvertFrom-QStudyOcrExitCode 12).reason -eq 'installation_in_progress') 'Fixed success and in-progress exit statuses are decoded'
    $partial = ConvertFrom-QStudyOcrExitCode 14
    Assert-Ocr ($partial.reason -eq 'installation_failed' -and $partial.restartNeeded) 'Partial installation failure remains a failure even when Windows requests a restart'

    # State-machine tests replace every OS provisioning call with fixture mocks.
    $script:probeAvailable = $false
    $script:probeReason = 'missing_russian_language'
    $script:provisionCount = 0
    $script:provisionReason = 'installation_failed'
    $script:provisionRestart = $false
    $script:provisionMakesReady = $false
    function Get-QStudyOcrProbe([string]$RootPath = '') {
        return (New-QStudyOcrProbe $script:probeAvailable $script:probeReason $(if ($script:probeAvailable) { 'ru' } else { '' }))
    }
    function Invoke-QStudyOcrProvision([string]$Root) {
        $script:provisionCount++
        if ($script:provisionMakesReady) { $script:probeAvailable = $true; $script:probeReason = 'ready' }
        return [PSCustomObject]@{ reason = $script:provisionReason; restartNeeded = $script:provisionRestart }
    }
    $script:probeAvailable = $true; $script:probeReason = 'ready'
    $ready = Ensure-QStudyOcr $fixture
    Assert-Ocr ($ready.available -and $script:provisionCount -eq 0) 'Installed Russian OCR is detected without elevation'
    $runtime = Join-Path $fixture '.local\runtime.json'
    [IO.File]::WriteAllText($runtime, 'UNCHANGED_RUNTIME_MARKER')
    $script:probeAvailable = $false; $script:probeReason = 'missing_russian_language'
    $offline = Ensure-QStudyOcr $fixture -Offline
    Assert-Ocr (-not $offline.available -and $offline.reason -eq 'offline' -and $script:provisionCount -eq 0) 'Offline skips Windows installation while reporting unavailable OCR'
    Assert-Ocr ([IO.File]::ReadAllText($runtime) -ceq 'UNCHANGED_RUNTIME_MARKER') 'OCR status does not modify the dependency runtime marker'
    Clear-TestOcrState
    $cancelled = Ensure-QStudyOcr $fixture
    Assert-Ocr (-not $cancelled.available -and $script:provisionCount -eq 1 -and ([DateTime]$cancelled.nextAttemptUtc) -gt [DateTime]::UtcNow.AddHours(23)) 'A failed installation records a bounded retry backoff'
    [void](Ensure-QStudyOcr $fixture)
    Assert-Ocr ($script:provisionCount -eq 1) 'Repeated app launches do not repeat the UAC installation attempt'
    $script:provisionReason = 'elevation_cancelled'
    $cancelled = Ensure-QStudyOcr $fixture -ForceRepair
    Assert-Ocr ($cancelled.reason -eq 'elevation_cancelled' -and $script:provisionCount -eq 2) 'Repair retries cancellation explicitly while keeping the base app usable'
    $script:provisionReason = 'restart_required'; $script:provisionRestart = $true
    $restart = Ensure-QStudyOcr $fixture -ForceRepair
    Assert-Ocr (-not $restart.available -and $restart.restartNeeded -and $restart.reason -eq 'restart_required') 'Restart requirement is reported honestly without rebooting'
    $script:provisionReason = 'installation_failed'; $script:provisionRestart = $true
    $partialFailure = Ensure-QStudyOcr $fixture -ForceRepair
    Assert-Ocr (-not $partialFailure.available -and $partialFailure.restartNeeded -and $partialFailure.reason -eq 'installation_failed') 'Basic installed plus OCR failed never claims OCR was installed'
    $script:provisionReason = 'installed'; $script:provisionRestart = $false
    $unverified = Ensure-QStudyOcr $fixture -ForceRepair
    Assert-Ocr (-not $unverified.available -and $unverified.reason -eq 'installation_failed') 'DISM success alone cannot claim working OCR before the WinRT recheck'
    $script:provisionMakesReady = $true
    $installed = Ensure-QStudyOcr $fixture -ForceRepair
    Assert-Ocr ($installed.available -and $installed.reason -eq 'ready' -and -not $installed.nextAttemptUtc) 'A successful installation is confirmed with a fresh recognizer probe'
    $script:probeAvailable = $false; $script:probeReason = 'missing_russian_language'; $script:provisionMakesReady = $false
    $script:provisionReason = 'provision_pending'
    [void](Ensure-QStudyOcr $fixture -ForceRepair)
    $before = $script:provisionCount
    $pending = Ensure-QStudyOcr $fixture -ForceRepair
    Assert-Ocr ($pending.reason -eq 'provision_pending' -and $script:provisionCount -eq $before) 'Repair cannot immediately duplicate a servicing operation that exceeded the wait limit'
    $pending.machineFingerprint = ('0' * 64)
    Write-QStudyInstallJson (Join-Path $fixture '.local\ocr-runtime.json') $pending
    $script:provisionReason = 'installation_failed'
    [void](Ensure-QStudyOcr $fixture)
    Assert-Ocr ($script:provisionCount -eq $before + 1) 'A copied machine marker cannot suppress OCR installation on a new computer'
    $script:probeReason = 'unavailable'
    $before = $script:provisionCount
    $unavailable = Ensure-QStudyOcr $fixture -ForceRepair
    Assert-Ocr ($unavailable.reason -eq 'unavailable' -and $script:provisionCount -eq $before) 'WinRT platform failure does not blindly mutate Windows capabilities'
    Assert-Ocr ([IO.File]::ReadAllText($runtime) -ceq 'UNCHANGED_RUNTIME_MARKER') 'All availability, failure and repair scenarios preserve runtime.json'
    Write-Host ("OCR checks passed: $script:passed. No Windows capability was installed by these tests.")
} finally {
    if (-not $KeepFixtures) {
        $resolved = [IO.Path]::GetFullPath($parent)
        $expected = [IO.Path]::GetFullPath((Join-Path $repository '.local\ocr-tests')).TrimEnd('\') + '\'
        if (-not $resolved.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path' }
        Remove-Item -LiteralPath $resolved -Recurse -Force -ErrorAction SilentlyContinue
    }
}
