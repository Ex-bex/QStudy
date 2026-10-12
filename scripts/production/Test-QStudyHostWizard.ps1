# Runs the real handover wizard with disposable settings and fake manager/network.
# No real private configuration, DNS, Docker, browser, mail, firewall, router or scheduled tasks.
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
function Invoke-FixtureWizard([string[]]$Arguments = @(), [string]$Scenario = 'valid', [ValidateSet('https', 'http', 'http-auto', 'http-detect')][string]$Mode = 'https', [switch]$WithPrivateSettings) {
    [IO.File]::WriteAllText($callLog, '', $encoding)
    [IO.File]::WriteAllText($promptLog, '', $encoding)
    $report = Join-Path $fixture '.local\home-network-report.json'
    if (Test-Path -LiteralPath $report) { Remove-Item -LiteralPath $report -Force }
    # Every invocation is a fresh disposable installation, so a preceding mode
    # cannot accidentally determine the following wizard's default mode/port.
    $environment = Join-Path $fixture 'deployment\.env'
    if (Test-Path -LiteralPath $environment) { Remove-Item -LiteralPath $environment -Force }
    $env:QSTUDY_WIZARD_TEST_SCENARIO = $Scenario
    $modeArguments = @()
    if ($Mode -eq 'https') { $modeArguments = @('-Domain', 'qstudy-fixture.example.org', '-Email', 'owner@example.org') }
    elseif ($Mode -eq 'http') { $modeArguments = @('-PublicIP', '8.8.8.8', '-Port', '18080') }
    elseif ($Mode -eq 'http-auto') { $modeArguments = @('-PublicIP', '8.8.8.8') }
    $privateArguments = @(); if (-not $WithPrivateSettings) { $privateArguments += '-SkipPrivateSettings' }
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper @modeArguments @privateArguments -NoPause @Arguments 2>&1)
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
param([string]$Action, [string]$Domain = '', [string]$Email = '', [string]$PublicIP = '', [int]$Port = 0, [switch]$Offline)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$callPath = Join-Path $fixtureRoot 'wizard-calls.jsonl'
[IO.File]::AppendAllText($callPath, (ConvertTo-Json -InputObject @{ source = 'manager'; action = $Action; offline = [bool]$Offline; domain = $Domain; email = $Email; publicIP = $PublicIP; port = $Port } -Compress) + [Environment]::NewLine)
$scenario = $env:QSTUDY_WIZARD_TEST_SCENARIO
if ($Action -in @('init', 'init-http')) {
    if ($scenario -eq 'init-error') { Write-Host 'Disposable initialization failure'; exit 1 }
    $path = Join-Path $fixtureRoot 'deployment\.env'
    if (-not (Test-Path -LiteralPath $path)) {
        $text = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'deployment\.env.example'))
        if ($Action -eq 'init-http') {
            $text = $text.Replace("QSTUDY_HOST_MODE='https'", "QSTUDY_HOST_MODE='http'")
            $text = $text.Replace("QSTUDY_PUBLIC_IP=''", ("QSTUDY_PUBLIC_IP='" + $PublicIP + "'"))
            $text = $text.Replace("QSTUDY_HTTP_PORT='8080'", ("QSTUDY_HTTP_PORT='" + $Port + "'"))
            $text = $text.Replace("ALLOW_PUBLIC_HTTP='false'", "ALLOW_PUBLIC_HTTP='true'")
            $text = $text.Replace("PUBLIC_BASE_URL='https://qstudy.example.org'", ("PUBLIC_BASE_URL='http://" + $PublicIP + ':' + $Port + "'"))
        } else {
            $text = $text.Replace("QSTUDY_DOMAIN='qstudy.example.org'", ("QSTUDY_DOMAIN='" + $Domain + "'"))
            $text = $text.Replace("ACME_EMAIL='owner@example.org'", ("ACME_EMAIL='" + $Email + "'"))
            $text = $text.Replace("PUBLIC_BASE_URL='https://qstudy.example.org'", ("PUBLIC_BASE_URL='https://" + $Domain + "'"))
        }
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
param([string]$Domain = '', [string]$RouterWanIPv4 = '', [int]$HttpPort = 0, [switch]$NoPause)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$callPath = Join-Path $fixtureRoot 'wizard-calls.jsonl'
[IO.File]::AppendAllText($callPath, (ConvertTo-Json -InputObject @{ source = 'network'; domain = $Domain; routerWanIPv4 = $RouterWanIPv4; httpPort = $HttpPort; noPause = [bool]$NoPause } -Compress) + [Environment]::NewLine)
$scenario = $env:QSTUDY_WIZARD_TEST_SCENARIO
if ($scenario -eq 'network-error') { Write-Host 'Disposable network failure'; exit 1 }
if ($scenario -eq 'missing-report') { exit 0 }
$report = @{ version = 1; offline = $false; checkedUtc = [DateTime]::UtcNow.ToString('o'); domain = $Domain; dnsAssessment = 'ipv4_matches'; wanAssessment = 'public_wan_matches'; dnsIPv6 = @(); externalReachabilityProven = $false; externalIpStatus = 'observed'; externalIPv4 = '8.8.8.8'; httpPort = $HttpPort }
if ($HttpPort) { $report.dnsAssessment = 'not_requested' }
switch ($scenario) {
    'mismatch' { $report.dnsAssessment = 'ipv4_mismatch' }
    'cgnat' { $report.wanAssessment = 'cgnat' }
    'private-wan' { $report.wanAssessment = 'private_wan' }
    'stale' { $report.checkedUtc = [DateTime]::UtcNow.AddHours(-1).ToString('o') }
    'offline-report' { $report.offline = $true }
    'wrong-domain' { $report.domain = 'other-fixture.example.org' }
    'ip-mismatch' { $report.externalIPv4 = '8.8.4.4' }
    'external-unobserved' { $report.externalIpStatus = 'unavailable'; $report.externalIPv4 = '' }
    'ipv6' { $report.dnsAssessment = 'ipv4_matches_verify_ipv6'; $report.dnsIPv6 = @('2001:db8::1') }
}
[IO.File]::WriteAllText((Join-Path $fixtureRoot '.local\home-network-report.json'), (ConvertTo-Json -InputObject $report -Depth 4), [Text.UTF8Encoding]::new($false))
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\Test-QStudyHomeNetwork.ps1'), $fakeNetwork, $encoding)

    $fakePublicAccess = @'
param([string]$Action, [switch]$NoPause)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$callPath = Join-Path $fixtureRoot 'wizard-calls.jsonl'
[IO.File]::AppendAllText($callPath, (ConvertTo-Json -InputObject @{ source = 'public-access'; action = $Action; noPause = [bool]$NoPause } -Compress) + [Environment]::NewLine)
if ($env:QSTUDY_WIZARD_TEST_SCENARIO -eq 'public-access-error') { Write-Host 'Disposable public access failure'; exit 1 }
if ($env:QSTUDY_WIZARD_TEST_SCENARIO -eq 'public-access-manual-required') { Write-Host 'Disposable router requires manual forwarding'; exit 2 }
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $fixtureScripts 'Manage-QStudyPublicAccess.ps1'), $fakePublicAccess, $encoding)

    $wrapperProgram = @'
param([string]$Domain = '', [string]$Email = '', [string]$PublicIP = '', [int]$Port = 0, [string]$RouterWanIPv4 = '', [switch]$Prepare, [switch]$Start, [switch]$EnableAutostart, [switch]$ManualForwarding, [switch]$SkipPrivateSettings, [switch]$NoPause)
$fixtureRoot = $PSScriptRoot
function global:Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'wizard-prompts.txt'), $Prompt + [Environment]::NewLine)
    if ($Prompt -like 'Белый IPv4*') { return '' }
    if ($env:QSTUDY_WIZARD_TEST_SCENARIO -eq 'smtp') {
        if ($AsSecureString) { return ConvertTo-SecureString 'FixtureSmtpSecret$Test' -AsPlainText -Force }
        switch -Wildcard ($Prompt) {
            'Настроить SMTP*' { return 'y' }
            'SMTP сервер' { return 'smtp.fixture.example.org' }
            'SMTP порт*' { return '465' }
            'Шифрование*' { return 'ssl' }
            'SMTP аккаунт' { return 'owner@example.org' }
            'Email отправителя' { return 'owner@example.org' }
            'Указать ключ Gemini*' { return '' }
        }
    }
    throw 'Unexpected interactive prompt in disposable noninteractive wizard test.'
}
function global:Invoke-RestMethod {
    param([string]$Uri, [int]$TimeoutSec)
    if ($Uri -cne 'https://api.ipify.org?format=json') { throw 'Unexpected external request in disposable wizard test.' }
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'wizard-calls.jsonl'), (ConvertTo-Json -InputObject @{ source = 'ipify'; mocked = $true } -Compress) + [Environment]::NewLine)
    return [PSCustomObject]@{ ip = '8.8.8.8' }
}
$options = @{ Domain = $Domain; Email = $Email; PublicIP = $PublicIP; Port = $Port; RouterWanIPv4 = $RouterWanIPv4; Prepare = $Prepare; Start = $Start; EnableAutostart = $EnableAutostart; ManualForwarding = $ManualForwarding; SkipPrivateSettings = $SkipPrivateSettings; NoPause = $NoPause }
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
    Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) 'default HTTPS setup never changes firewall or router forwarding'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'wrapper' -and $_.returnedAfterNestedExit -and $_.code -eq 0 }).Count -eq 1) 'wizard and nested manager/network exit return to the same PowerShell process'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'check' -and $_.offline }).Count -eq 1) 'wizard initially validates configuration with offline check'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'network' -and $_.noPause -and $_.domain -eq 'qstudy-fixture.example.org' }).Count -eq 1) 'default diagnostic receives the domain and cannot pause'
    Assert-Wizard ([IO.File]::ReadAllText($promptLog).Length -eq 0) 'SkipPrivateSettings and NoPause avoid every interactive prompt'
    Assert-Wizard ($result.output -notmatch 'Адрес проверен с этого компьютера') 'default completion does not claim verified public HTTPS'

    $result = Invoke-FixtureWizard @('-Prepare', '-RouterWanIPv4', '8.8.8.8')
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init,check,prepare') 'Prepare initializes and checks then prepares without public startup'
    Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) 'HTTPS preparation never changes firewall or router forwarding'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'network' -and $_.routerWanIPv4 -eq '8.8.8.8' }).Count -eq 1) 'explicit router WAN is forwarded only to diagnostics'
    Assert-Wizard (@($calls | Where-Object source -eq 'wrapper').Count -eq 1 -and [IO.File]::ReadAllText($promptLog).Length -eq 0) 'private preparation exits normally without prompts'

    foreach ($scenario in @('mismatch', 'cgnat', 'private-wan', 'stale', 'offline-report', 'wrong-domain', 'missing-report', 'network-error')) {
        $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') $scenario
        $calls = @(Read-WizardCalls)
        Assert-Wizard ($result.code -ne 0) ('Start refuses ' + $scenario)
        Assert-Wizard ((Get-ManagerActions $calls) -ceq 'init,check') ($scenario + ' cannot publish or install autostart')
        Assert-Wizard (@($calls | Where-Object { $_.source -eq 'wrapper' -and $_.returnedAfterNestedExit -and $_.code -eq 1 }).Count -eq 1) ($scenario + ' returns a failure through the same-process wrapper')
        Assert-Wizard ($result.output -notmatch 'Адрес проверен с этого компьютера') ($scenario + ' never claims public HTTPS success')
    }

    $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart')
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init,check,start,install-autostart') 'valid Start publishes then installs autostart only after successful startup'
    Assert-Wizard (($calls | ForEach-Object source) -join ',' -ceq 'manager,manager,network,manager,manager,wrapper') 'live report checks occur before startup and autostart'
    Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) 'HTTPS Start uses its existing deployment flow without the HTTP mapping helper'
    Assert-Wizard ($result.output -match 'с выключенным Wi-Fi' -and $result.output -notmatch 'внешний доступ подтверждён') 'successful local HTTPS still requires an independent external test'
    $result = Invoke-FixtureWizard @('-Start')
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions @(Read-WizardCalls)) -ceq 'init,check,start') 'autostart remains opt-in'
    $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') 'start-error'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -ne 0 -and (Get-ManagerActions $calls) -ceq 'init,check,start') 'failed start cannot install autostart'
    Assert-Wizard ($result.output -notmatch 'Адрес проверен с этого компьютера') 'failed startup never prints verified HTTPS'
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

    $result = Invoke-FixtureWizard @() 'valid' 'http'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0) ('HTTP wizard succeeds without domain/email: ' + $result.output)
    Assert-Wizard ((Get-ManagerActions $calls) -ceq 'init-http,check') 'HTTP default configures privately without publication or autostart'
    Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) 'default HTTP setup never opens firewall or router ports'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'init-http' -and $_.publicIP -eq '8.8.8.8' -and $_.port -eq 18080 -and -not $_.domain -and -not $_.email }).Count -eq 1) 'HTTP initialization receives public IP and port without domain/email arguments'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'network' -and $_.httpPort -eq 18080 -and -not $_.domain -and $_.noPause }).Count -eq 1) 'HTTP diagnostics receive only the selected public port'
    Assert-Wizard (@($calls | Where-Object source -eq 'ipify').Count -eq 0 -and [IO.File]::ReadAllText($promptLog).Length -eq 0) 'explicit HTTP IP needs no discovery, SMTP or domain/email prompts'
    Assert-Wizard ($result.output -match 'http://8.8.8.8:18080' -and $result.output -notmatch 'Адрес проверен с этого компьютера') 'HTTP output supplies the configured link without claiming publication'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'wrapper' -and $_.returnedAfterNestedExit -and $_.code -eq 0 }).Count -eq 1) 'HTTP nested exits also return through the same PowerShell process'

    $result = Invoke-FixtureWizard @('-Prepare', '-RouterWanIPv4', '8.8.8.8') 'valid' 'http'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init-http,check,prepare') 'HTTP Prepare launches only the private preparation action'
    Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) 'HTTP Prepare does not open public firewall or router access'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'network' -and $_.httpPort -eq 18080 -and $_.routerWanIPv4 -eq '8.8.8.8' }).Count -eq 1) 'HTTP preparation forwards explicit WAN and selected public port'
    $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') 'valid' 'http'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init-http,check,start,install-autostart') 'valid HTTP Start publishes and then installs autostart'
    Assert-Wizard (($calls | ForEach-Object source) -join ',' -ceq 'manager,manager,network,public-access,manager,manager,wrapper') 'HTTP live network report precedes automatic public access, startup and autostart'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'enable' -and $_.noPause }).Count -eq 1) 'HTTP Start automatically configures owned public access once without interactive pause'
    Assert-Wizard ($result.output -match 'Адрес проверен с этого компьютера: http://8.8.8.8:18080' -and $result.output -match 'с выключенным Wi-Fi') 'HTTP success identifies the configured IP endpoint and still requires an external check'
    $result = Invoke-FixtureWizard @('-Start') 'valid' 'http'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init-http,check,start') 'HTTP autostart remains opt-in'
    Assert-Wizard (($calls | ForEach-Object source) -join ',' -ceq 'manager,manager,network,public-access,manager,wrapper') 'HTTP Start configures public access before publication without requiring application autostart'

    $result = Invoke-FixtureWizard @('-Start', '-ManualForwarding', '-EnableAutostart') 'valid' 'http'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init-http,check,start,install-autostart') 'explicit manual forwarding permits normal HTTP publication after host setup'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'manual' -and $_.noPause }).Count -eq 1) 'manual forwarding is explicitly passed as the public access manual action without pause'
    Assert-Wizard (($calls | ForEach-Object source) -join ',' -ceq 'manager,manager,network,public-access,manager,manager,wrapper') 'manual forwarding still prepares host public access before startup or autostart'

    $result = Invoke-FixtureWizard @('-Start', '-ManualForwarding', '-EnableAutostart') 'cgnat' 'http'
    $calls = @(Read-WizardCalls)
    Assert-Wizard ($result.code -ne 0 -and (Get-ManagerActions $calls) -ceq 'init-http,check') 'manual forwarding cannot bypass known CGNAT diagnostics'
    Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) 'known CGNAT refuses manual firewall access before any host/network changes'

    foreach ($scenario in @('public-access-error', 'public-access-manual-required')) {
        $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') $scenario 'http'
        $calls = @(Read-WizardCalls)
        Assert-Wizard ($result.code -ne 0) ('HTTP ' + $scenario + ' blocks publication')
        Assert-Wizard ((Get-ManagerActions $calls) -ceq 'init-http,check') ($scenario + ' cannot start the public proxy or install application autostart')
        Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 1) ($scenario + ' is handled after exactly one public access attempt')
        Assert-Wizard ($result.output -notmatch 'Адрес проверен с этого компьютера') ($scenario + ' never claims a successful public start')
    }

    foreach ($scenario in @('ip-mismatch', 'external-unobserved', 'cgnat', 'private-wan', 'stale', 'offline-report', 'missing-report', 'network-error')) {
        $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') $scenario 'http'
        $calls = @(Read-WizardCalls)
        Assert-Wizard ($result.code -ne 0) ('HTTP Start refuses ' + $scenario)
        Assert-Wizard ((Get-ManagerActions $calls) -ceq 'init-http,check') ('HTTP ' + $scenario + ' cannot publish or schedule autostart')
        Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) ('HTTP ' + $scenario + ' is refused before firewall/router access changes')
        Assert-Wizard ($result.output -notmatch 'Адрес проверен с этого компьютера') ('HTTP ' + $scenario + ' cannot print startup success')
    }
    foreach ($scenario in @('missing-docker', 'config-check-error', 'init-error', 'start-error')) {
        $result = Invoke-FixtureWizard @('-Start', '-EnableAutostart') $scenario 'http'
        $calls = @(Read-WizardCalls)
        Assert-Wizard ($result.code -ne 0) ('HTTP ' + $scenario + ' propagates failure')
        Assert-Wizard (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'install-autostart' }).Count -eq 0) ('HTTP ' + $scenario + ' cannot install autostart')
        if ($scenario -ne 'start-error') {
            Assert-Wizard (@($calls | Where-Object source -eq 'public-access').Count -eq 0) ('HTTP ' + $scenario + ' stops before host firewall/router configuration')
        }
    }

    $result = Invoke-FixtureWizard @() 'valid' 'http-auto'
    $calls = @(Read-WizardCalls)
    $autoInit = @($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'init-http' })[0]
    $autoNetwork = @($calls | Where-Object source -eq 'network')[0]
    Assert-Wizard ($result.code -eq 0 -and $autoInit.port -ge 8080 -and $autoInit.port -le 8179) 'HTTP Port zero chooses a currently bindable port with the real local helper'
    Assert-Wizard ($autoNetwork.httpPort -eq $autoInit.port -and $result.output.Contains('http://8.8.8.8:' + $autoInit.port)) 'auto-selected port is used consistently by configuration, diagnostics and displayed URL'
    Assert-Wizard ([IO.File]::ReadAllText($promptLog).Length -eq 0) 'automatic port discovery does not request domain/email or private settings'

    $result = Invoke-FixtureWizard @() 'valid' 'http-detect'
    $calls = @(Read-WizardCalls)
    $prompts = [IO.File]::ReadAllText($promptLog)
    Assert-Wizard ($result.code -eq 0 -and (Get-ManagerActions $calls) -ceq 'init-http,check') 'fresh wizard defaults to HTTP with no Domain or Email parameters'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'ipify' -and $_.mocked }).Count -eq 1) 'fresh HTTP IP detection uses only the mocked outbound response'
    Assert-Wizard ($prompts -match 'Белый IPv4' -and $prompts -notmatch 'Домен|Email владельца|SMTP|Gemini|Нажмите Enter') 'fresh HTTP setup asks only to confirm the discovered public IPv4'

    $result = Invoke-FixtureWizard @() 'smtp' 'http' -WithPrivateSettings
    $calls = @(Read-WizardCalls)
    $fixtureEnvironment = [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env'))
    Assert-Wizard ($result.code -eq 0) ('HTTP SMTP private setup succeeds: ' + $result.output)
    Assert-Wizard ($fixtureEnvironment -match "(?m)^SMTP_PORT='465'\s*$" -and $fixtureEnvironment -match "(?m)^QSTUDY_HTTP_PORT='18080'\s*$") 'SMTP port is saved independently of the public HTTP port'
    Assert-Wizard (@($calls | Where-Object { $_.source -eq 'network' -and $_.httpPort -eq 18080 }).Count -eq 1 -and $result.output -match 'http://8.8.8.8:18080') 'SMTP input cannot change the displayed/public diagnostic port'
    Assert-Wizard ($result.output -notmatch 'FixtureSmtpSecret' -and [IO.File]::ReadAllText($promptLog) -notmatch 'FixtureSmtpSecret') 'private SMTP input remains absent from wizard output and prompt logs'
    Write-Host ('Host wizard checks passed (' + $checks + ' assertions). Disposable manager/network/public-access only; no real services, firewall/router rules or private settings were touched.')
} finally {
    $env:QSTUDY_WIZARD_TEST_SCENARIO = $oldScenario
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($fixturePrefix) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside wizard test fixtures.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
exit 0
