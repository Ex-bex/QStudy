# Runs the real handover wizard with disposable settings and fake manager/network.
# No real private configuration, DNS, Docker, browser, mail or scheduled tasks.
param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixturePrefix = Join-Path $workspace '.local\host-wizard-tests'
$fixture = Join-Path $fixturePrefix ([Guid]::NewGuid().ToString('N'))
$fixtureScripts = Join-Path $fixture 'scripts\production'
$wrapper = Join-Path $fixture 'invoke-wizard.ps1'
$callLog = Join-Path $fixture 'wizard-calls.jsonl'
$promptLog = Join-Path $fixture 'wizard-prompts.txt'
$powershell = (Get-Command powershell.exe -CommandType Application).Source
$encoding = [Text.UTF8Encoding]::new($true)
$oldScenario = $env:QSTUDY_WIZARD_TEST_SCENARIO
$checks = 0

function Assert-Wizard([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Invoke-FixtureWizard([string[]]$Arguments = @(), [string]$Scenario = 'valid') {
    [IO.File]::WriteAllText($callLog, '', $encoding)
    [IO.File]::WriteAllText($promptLog, '', $encoding)
    $report = Join-Path $fixture '.local\home-network-report.json'
    if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force }
    $env:QSTUDY_WIZARD_TEST_SCENARIO = $Scenario
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper -Domain 'qstudy-fixture.example.org' -Email 'owner@example.org' -SkipPrivateSettings -NoPause @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    return [PSCustomObject]@{ code = $code; output = ($output -join "`n") }
}
function Read-WizardCalls {
    foreach ($line in @(Get-Content -LiteralPath $callLog -Encoding UTF8)) {
        if ($line.Trim()) { Write-Output ($line | ConvertFrom-Json) }
    }
}
function Get-ManagerActions($Calls) {
    return @($Calls | Where-Object source -eq 'manager' | ForEach-Object action) -join ','
}

try {
    [IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $fixture 'deployment')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $fixture '.local')) | Out-Null
    foreach ($name in @('Setup-QStudyHost.ps1', 'QStudy.HostSetup.ps1', 'QStudy.WindowsHost.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $fixtureScripts
    }
    Copy-Item -LiteralPath (Join-Path $workspace 'scripts\QStudy.HomeNetwork.ps1') -Destination (Join-Path $fixture 'scripts')
    Copy-Item -LiteralPath (Join-Path $workspace 'deployment\.env.example') -Destination (Join-Path $fixture 'deployment')

    $fakeManager = @'
param([string]$Action, [string]$Domain = '', [string]$Email = '', [switch]$Offline)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$callPath = Join-Path $fixtureRoot 'wizard-calls.jsonl'
[IO.File]::AppendAllText($callPath, (ConvertTo-Json -InputObject @{ source = 'manager'; action = $Action; offline = [bool]$Offline; domain = $Domain; email = $Email } -Compress) + [Environment]::NewLine)
$scenario = $env:QSTUDY_WIZARD_TEST_SCENARIO
if ($Action -eq 'init') {
    if ($scenario -eq 'init-error') { Write-Host 'Disposable initialization failure'; exit 1 }
    $path = Join-Path $fixtureRoot 'deployment\.env'
    if (-not (Test-Path -LiteralPath $path)) {
        $text = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'deployment\.env.example'))
        $text = $text.Replace("QSTUDY_DOMAIN='qstudy.example.org'", ("QSTUDY_DOMAIN='" + $Domain + "'"))
        $text = $text.Replace("ACME_EMAIL='owner@example.org'", ("ACME_EMAIL='" + $Email + "'"))
        $text = $text.Replace("PUBLIC_BASE_URL='https://qstudy.example.org'", ("PUBLIC_BASE_URL='https://" + $Domain + "'"))
        [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
    }
}
if ($Action -eq 'check' -and $scenario -in @('missing-docker', 'config-check-error')) { Write-Host 'Disposable Docker/configuration check failure'; exit 1 }
if ($Action -eq 'prepare' -and $scenario -eq 'prepare-error') { Write-Host 'Disposable preparation failure'; exit 1 }
if ($Action -eq 'start' -and $scenario -eq 'start-error') { Write-Host 'Disposable startup failure'; exit 1 }
if ($Action -eq 'install-autostart' -and $scenario -eq 'autostart-error') { Write-Host 'Disposable autostart failure'; exit 1 }
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $fixtureScripts 'Manage-QStudy.ps1'), $fakeManager, $encoding)

    $fakeNetwork = @'
param([string]$Domain = '', [string]$RouterWanIPv4 = '', [switch]$NoPause)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$callPath = Join-Path $fixtureRoot 'wizard-calls.jsonl'
[IO.File]::AppendAllText($callPath, (ConvertTo-Json -InputObject @{ source = 'network'; domain = $Domain; routerWanIPv4 = $RouterWanIPv4; noPause = [bool]$NoPause } -Compress) + [Environment]::NewLine)
$scenario = $env:QSTUDY_WIZARD_TEST_SCENARIO
if ($scenario -eq 'network-error') { Write-Host 'Disposable network failure'; exit 1 }
if ($scenario -eq 'missing-report') { exit 0 }
$report = @{ version = 1; offline = $false; checkedUtc = [DateTime]::UtcNow.ToString('o'); domain = $Domain; dnsAssessment = 'ipv4_matches'; wanAssessment = 'public_wan_matches'; dnsIPv6 = @(); externalReachabilityProven = $false }
switch ($scenario) {
    'mismatch' { $report.dnsAssessment = 'ipv4_mismatch' }
    'cgnat' { $report.wanAssessment = 'cgnat' }
    'private-wan' { $report.wanAssessment = 'private_wan' }
    'stale' { $report.checkedUtc = [DateTime]::UtcNow.AddHours(-1).ToString('o') }
    'offline-report' { $report.offline = $true }
    'wrong-domain' { $report.domain = 'other-fixture.example.org' }
    'ipv6' { $report.dnsAssessment = 'ipv4_matches_verify_ipv6'; $report.dnsIPv6 = @('2001:db8::1') }
}
[IO.File]::WriteAllText((Join-Path $fixtureRoot '.local\home-network-report.json'), (ConvertTo-Json -InputObject $report -Depth 4), [Text.UTF8Encoding]::new($false))
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\Test-QStudyHomeNetwork.ps1'), $fakeNetwork, $encoding)

    $wrapperProgram = @'
param([string]$Domain, [string]$Email, [string]$RouterWanIPv4 = '', [switch]$Prepare, [switch]$Start, [switch]$EnableAutostart, [switch]$SkipPrivateSettings, [switch]$NoPause)
$fixtureRoot = $PSScriptRoot
function global:Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'wizard-prompts.txt'), $Prompt + [Environment]::NewLine)
    throw 'Unexpected interactive prompt in disposable noninteractive wizard test.'
}
$options = @{ Domain = $Domain; Email = $Email; RouterWanIPv4 = $RouterWanIPv4; Prepare = $Prepare; Start = $Start; EnableAutostart = $EnableAutostart; SkipPrivateSettings = $SkipPrivateSettings; NoPause = $NoPause }
& (Join-Path $fixtureRoot 'scripts\production\Setup-QStudyHost.ps1') @options
$wizardExitCode = $LASTEXITCODE
[IO.File]::AppendAllText((Join-Path $fixtureRoot 'wizard-calls.jsonl'), (ConvertTo-Json -InputObject @{ source = 'wrapper'; returnedAfterNestedExit = $true; code = $wizardExitCode } -Compress) + [Environment]::NewLine)
exit $wizardExitCode
'@
    [IO.File]::WriteAllText($wrapper, $wrapperProgram, $encoding)

    $result = Invoke-FixtureWizard
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0) ('default wizard succeeds: ' + $result.output)
    Assert-Wizard ((Get-ManagerActions $calls) -ceq 'init,check') 'default wizard initializes/checks but never prepares, publishes or schedules'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'wrapper' -and $_.returnedAfterNestedExit -and $_.code -eq 0 }).Count -eq 1) 'wizard and nested manager/network exit return to the same PowerShell process'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'check' -and $_.offline }).Count -eq 1) 'wizard initially validates configuration with offline check'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'network' -and $_.noPause -and $_.domain -eq 'qstudy-fixture.example.org' }).Count -eq 1) 'default diagnostic receives the domain and cannot pause'
    Assert-Wizard ([IO.File]::ReadAllText($promptLog).Length -eq 0) 'SkipPrivateSettings and NoPause avoid every interactive prompt'
    Assert-Wizard ($result.output -notmatch 'HTTPS проверен с этого компьютера') 'default completion does not claim verified public HTTPS'

    $result = Invoke-FixtureWizard @('-Prepare', '-RouterWanIPv4', '8.8.8.8')
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init,check,prepare') 'Prepare initializes and checks then prepares without public startup'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'network' -and $_.routerWanIPv4 -eq '8.8.8.8' }).Count -eq 1) 'explicit router WAN is forwarded only to diagnostics'
    Assert-Wizard (@($calls | Where-Object source -eq 'wrapper').Count -eq 1 -and [IO.File]::ReadAllText($promptLog).Length -eq 0) 'private preparation exits normally without prompts'

    foreach ($scenario in @('mismatch', 'cgnat', 'private-wan', 'stale', 'offline-report', 'wrong-domain', 'missing-report', 'network-error')) {
        $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') $scenario
        $calls = @(Read-WizardCalls)
        Assert-Wizard ($result.code -ne 0) ('Start refuses ' + $scenario)
        Assert-Wizard ((Get-ManagerActions $calls) -ceq 'init,check') ($scenario + ' cannot publish or install autostart')
        Assert-Wizard (@($calls | Where-Object { $_.source -eq 'wrapper' -and $_.returnedAfterNestedExit -and $_.code -eq 1 }).Count -eq 1) ($scenario + ' returns a failure through the same-process wrapper')
        Assert-Wizard ($result.output -notmatch 'HTTPS проверен с этого компьютера') ($scenario + ' never claims public HTTPS success')
    }

    $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart')
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init,check,start,install-autostart') 'valid Start publishes then installs autostart only after successful startup'
    Assert-Wizard (($calls | ForEach-Object source) -join ',' -ceq 'manager,manager,network,manager,manager,wrapper') 'live report checks occur before startup and autostart'
    Assert-Wizard ($result.output -match 'с выключенным Wi-Fi' -and $result.output -notmatch 'внешний доступ подтверждён') 'successful local HTTPS still requires an independent external test'
    $result = Invoke-FixtureWizard @('-Start')
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions @(Read-WizardCalls)) -ceq 'init,check,start') 'autostart remains opt-in'
    $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') 'start-error'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -ne 0 -and (Get-ManagerActions $calls) -ceq 'init,check,start') 'failed start cannot install autostart'
    Assert-Wizard ($result.output -notmatch 'HTTPS проверен с этого компьютера') 'failed startup never prints verified HTTPS'
    $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') 'autostart-error'
    Assert-Wizard ($result.code -ne 0 -and (Get-ManagerActions @(Read-WizardCalls)) -ceq 'init,check,start,install-autostart') 'autostart failure remains visible after successful startup'

    foreach ($scenario in @('missing-docker', 'config-check-error', 'init-error')) {
        $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') $scenario
        $calls = @(Read-WizardCalls)
        Assert-Wizard ($result.code -ne 0) ($scenario + ' fails the wizard')
        Assert-Wizard (@($calls | Where-Object source -eq 'network').Count -eq 0 -and @($calls | Where-Object { $_.source -eq 'manager' -and $_.action -in @('start', 'install-autostart', 'prepare') }).Count -eq 0) ($scenario + ' stops before network diagnosis or publication')
    }
    $result = Invoke-FixtureWizard @('-Prepare') 'prepare-error'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -ne 0 -and (Get-ManagerActions $calls) -ceq 'init,check,prepare') 'failed private preparation propagates failure'
    Assert-Wizard (@($calls | Where-Object source -eq 'network').Count -eq 0) 'failed preparation stops before subsequent diagnosis'
    foreach ($arguments in @(@('-Prepare', '-Start'), @('-EnableAutostart'))) {
        $result = Invoke-FixtureWizard $arguments
        $calls = @(Read-WizardCalls)
        Assert-Wizard ($result.code -ne 0 -and @($calls | Where-Object source -eq 'manager').Count -eq 0) 'incompatible switches fail before initialization or service changes'
    }
    $result = Invoke-FixtureWizard @('-Start') 'ipv6'
    Assert-Wizard ($result.code -eq 0 -and $result.output -match 'AAAA') 'IPv6 DNS requires an explicit reminder without claiming external reachability'
    Assert-Wizard ([IO.File]::ReadAllText($promptLog).Length -eq 0) 'all final noninteractive paths respect NoPause and SkipPrivateSettings'
    Write-Host ('Host wizard checks passed (' + $checks + ' assertions). Disposable manager/network only; no real services or private settings were touched.')
} finally {
    $env:QSTUDY_WIZARD_TEST_SCENARIO = $oldScenario
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($fixturePrefix) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside wizard test fixtures.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
exit 0
