# Real Internet launcher/environment/cache helpers with a disposable project and
# fake Docker, network, port mapping and production manager. Never touches the host.
param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixturePrefix = Join-Path $workspace '.local\internet-launch-tests'
$fixture = Join-Path $fixturePrefix ([Guid]::NewGuid().ToString('N'))
$fixtureScripts = Join-Path $fixture 'scripts\production'
$wrapper = Join-Path $fixture 'invoke-launch.ps1'
$callLog = Join-Path $fixture 'launch-calls.jsonl'
$promptLog = Join-Path $fixture 'launch-prompts.txt'
$powershell = (Get-Command powershell.exe -CommandType Application).Source
$encoding = [Text.UTF8Encoding]::new($true)
$oldScenario = $env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO
$checks = 0

function Assert-Launch([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}

function Invoke-FixtureLaunch {
    param([string[]]$Arguments = @(), [string]$Scenario = 'valid', [switch]$KeepInstallation, [switch]$WithoutAdmin, [switch]$LegacyDatabase)
    [IO.File]::WriteAllText($callLog, '', $encoding)
    [IO.File]::WriteAllText($promptLog, '', $encoding)
    if (-not $KeepInstallation) {
        foreach ($relative in @('deployment\.env', '.local\internet-launch\build.json', '.local\internet-launch\last-run.json', '.local\internet-launch\router-instructions.txt', '.local\public-access\state.json', '.local\public-access\last-operation.json', '.local\host-stack-status.json', '.local\host-account-status.json', '.local\home-network-report.json', 'backend\studyhub.db', 'deployment\data\backend\studyhub.db', 'fixture-admin', 'fixture-caddy')) {
            $path = Join-Path $fixture $relative
            if (Test-Path -LiteralPath $path -PathType Leaf) { Remove-Item -LiteralPath $path -Force }
        }
        [IO.File]::WriteAllText((Join-Path $fixture 'backend\app\fixture.py'), 'source-version-one', $encoding)
        if (-not $WithoutAdmin) { [IO.File]::WriteAllText((Join-Path $fixture 'fixture-admin'), 'existing-admin', $encoding) }
    }
    if ($LegacyDatabase) { [IO.File]::WriteAllText((Join-Path $fixture 'backend\studyhub.db'), 'disposable-local-accounts', $encoding) }
    $env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO = $Scenario
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $powershell -NoProfile -ExecutionPolicy Bypass -File $wrapper -NoPause @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    return [PSCustomObject]@{ code = $code; output = ($output -join "`n") }
}

function Read-LaunchCalls {
    foreach ($line in @(Get-Content -LiteralPath $callLog -Encoding UTF8)) {
        if ($line.Trim()) { Write-Output ($line | ConvertFrom-Json) }
    }
}
function Get-LaunchManagerActions($Calls) { return (@($Calls | Where-Object source -eq 'manager' | ForEach-Object action) -join ',') }
function Get-LaunchActions($Calls) { return (@($Calls | Where-Object { $_.source -in @('manager', 'network', 'public-access', 'docker') } | ForEach-Object { $_.source + ':' + $_.action }) -join ',') }
function Assert-NoPublish($Calls, [string]$Message) {
    Assert-Launch (@($Calls | Where-Object { $_.source -eq 'manager' -and $_.action -in @('launch', 'install-autostart') }).Count -eq 0) $Message
}

try {
    foreach ($relative in @('scripts\production', 'deployment\data\backend', 'deployment\data\backups', '.local', 'backend\app', 'frontend\app', 'frontend\components', 'frontend\lib', 'frontend\public', 'frontend\types')) {
        [IO.Directory]::CreateDirectory((Join-Path $fixture $relative)) | Out-Null
    }
    foreach ($name in @('Start-QStudyInternet.ps1', 'QStudy.InternetLaunch.ps1', 'QStudy.InternetConfiguration.ps1', 'QStudy.InternetDataChoice.ps1', 'QStudy.NetworkGuide.ps1', 'QStudy.NetworkOperation.ps1', 'QStudy.HostSetup.ps1', 'QStudy.WindowsHost.ps1', 'QStudy.PublicPortOwner.ps1', 'QStudy.PublicAccess.ps1', 'QStudy.PortMapping.ps1')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $fixtureScripts
    }
    Copy-Item -LiteralPath (Join-Path $workspace 'scripts\QStudy.HomeNetwork.ps1') -Destination (Join-Path $fixture 'scripts')
    Copy-Item -LiteralPath (Join-Path $workspace 'deployment\.env.example') -Destination (Join-Path $fixture 'deployment')
    [IO.File]::WriteAllText((Join-Path $fixture 'frontend\app\fixture.ts'), 'disposable-source', $encoding)
    [IO.File]::WriteAllText((Join-Path $fixture 'deployment\compose.http.yml'), 'disposable-compose', $encoding)
    [IO.File]::WriteAllText((Join-Path $fixture 'deployment\data\backups\qstudy-20261014-120000-abcdef01.zip'), 'disposable-backup-verified-by-fake-manager', $encoding)
    [IO.File]::WriteAllText((Join-Path $fixture 'selected-backup.zip'), 'disposable-dialog-backup-verified-by-fake-manager', $encoding)

    # Replace external/local-port discovery only. The real .env
    # parser, path protections, reports, fingerprint and cache functions remain.
    $helperStubs = @'
function Get-QStudyInternetObservedIP {
    $fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), '{"source":"ipify","action":"detect","mocked":true}' + [Environment]::NewLine)
    if ($env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO -eq 'ip-detection-error') { throw 'Disposable external-IP detection failure.' }
    if ($env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO -eq 'detected-ip-change') { return '8.8.8.8' }
    return '94.125.99.135'
}
function Get-QStudyAvailableHttpPort {
    $fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), '{"source":"port","action":"discover","mocked":true}' + [Environment]::NewLine)
    return 8080
}
function Ensure-QStudyInternetDocker {
    $fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), '{"source":"docker","action":"ready","mocked":true}' + [Environment]::NewLine)
    if ($env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO -eq 'docker-error') { throw 'Disposable Docker readiness failure.' }
}
function Get-QStudyPublicAccessRoute {
    return [PSCustomObject]@{ client_ip = '192.168.1.10'; gateway = '192.168.1.1'; metric = 1 }
}
'@
    [IO.File]::AppendAllText((Join-Path $fixtureScripts 'QStudy.InternetLaunch.ps1'), [Environment]::NewLine + $helperStubs, $encoding)
    $routeStub = @'
function Get-QStudyPublicAccessRoute {
    return [PSCustomObject]@{ client_ip = '192.168.1.10'; gateway = '192.168.1.1'; metric = 1 }
}
'@
    [IO.File]::AppendAllText((Join-Path $fixtureScripts 'QStudy.PublicAccess.ps1'), [Environment]::NewLine + $routeStub, $encoding)
    $ownerStub = @'
function Assert-QStudyPublicPortOwner {
    param([string]$Root, [int]$Port)
    [IO.File]::AppendAllText((Join-Path $Root 'launch-calls.jsonl'), (ConvertTo-Json -InputObject @{ source = 'port-owner'; action = 'check'; port = $Port; mocked = $true } -Compress) + [Environment]::NewLine)
    if ($env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO -eq 'port-occupied') { throw 'QStudy: disposable port occupied by another application.' }
}
'@
    [IO.File]::AppendAllText((Join-Path $fixtureScripts 'QStudy.PublicPortOwner.ps1'), [Environment]::NewLine + $ownerStub, $encoding)
    $dialogStub = @'
function Select-QStudyInternetBackupFile {
    $fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), '{"source":"data-dialog","action":"select","mocked":true}' + [Environment]::NewLine)
    if ($env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO -eq 'data-dialog-cancelled') { return '' }
    return (Join-Path $fixtureRoot 'selected-backup.zip')
}
'@
    [IO.File]::AppendAllText((Join-Path $fixtureScripts 'QStudy.InternetDataChoice.ps1'), [Environment]::NewLine + $dialogStub, $encoding)

    $fakeManager = @'
param([string]$Action, [string]$PublicIP = '', [int]$Port = 0, [string]$Email = '', [string]$Archive = '', [switch]$Offline, [switch]$NoPublish, [switch]$NoBrowser)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$scenario = $env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO
$admin = Join-Path $fixtureRoot 'fixture-admin'
$caddy = Join-Path $fixtureRoot 'fixture-caddy'
$call = @{ source = 'manager'; action = $Action; publicIP = $PublicIP; port = $Port; email = $Email; archive = $Archive; offline = [bool]$Offline; noPublish = [bool]$NoPublish; noBrowser = [bool]$NoBrowser }
[IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), (ConvertTo-Json -InputObject $call -Compress) + [Environment]::NewLine)
if ($Action -eq 'init-http') {
    if ($scenario -eq 'init-error') { Write-Host 'Disposable initialization failure'; exit 1 }
    $path = Join-Path $fixtureRoot 'deployment\.env'
    if (Test-Path -LiteralPath $path) { throw 'Fixture refuses to overwrite a saved configuration.' }
    $text = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'deployment\.env.example'))
    $text = $text.Replace("QSTUDY_HOST_MODE='https'", "QSTUDY_HOST_MODE='http'")
    $text = $text.Replace("QSTUDY_PUBLIC_IP=''", ("QSTUDY_PUBLIC_IP='" + $PublicIP + "'"))
    $text = $text.Replace("QSTUDY_HTTP_PORT='8080'", ("QSTUDY_HTTP_PORT='" + $Port + "'"))
    $text = $text.Replace("ALLOW_PUBLIC_HTTP='false'", "ALLOW_PUBLIC_HTTP='true'")
    $text = $text.Replace("PUBLIC_BASE_URL='https://qstudy.example.org'", ("PUBLIC_BASE_URL='http://" + $PublicIP + ':' + $Port + "'"))
    $text = $text.Replace("SECRET_KEY=''", "SECRET_KEY='synthetic-private-secret-keep-exactly'")
    $text = $text.Replace("SMTP_PASSWORD=''", "SMTP_PASSWORD='synthetic-smtp-secret-keep-exactly'")
    [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($false))
}
if ($Action -eq 'check' -and $scenario -eq 'check-error') { Write-Host 'Disposable configuration check failure'; exit 1 }
if ($Action -eq 'verify' -and $scenario -eq 'verify-error') { Write-Host 'Disposable backup verification failure'; exit 1 }
if ($Action -eq 'stack-status') {
    $report = @{ checked_utc = [DateTime]::UtcNow.ToString('o'); backend_running = $true; frontend_running = $true; caddy_running = [bool](Test-Path -LiteralPath $caddy); images_ready = ($scenario -ne 'missing-images') }
    if ($scenario -eq 'stale-stack') { $report.checked_utc = [DateTime]::UtcNow.AddHours(-1).ToString('o') }
    if ($scenario -eq 'invalid-stack') { $report.images_ready = 'true' }
    [IO.File]::WriteAllText((Join-Path $fixtureRoot '.local\host-stack-status.json'), ($report | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
if ($Action -eq 'stop') { if (Test-Path -LiteralPath $caddy) { Remove-Item -LiteralPath $caddy -Force } }
if ($Action -eq 'prepare') {
    if (Test-Path -LiteralPath $caddy) { throw 'Fixture refuses to prepare while publicly running.' }
    if ($scenario -eq 'prepare-error') { Write-Host 'Disposable preparation failure'; exit 1 }
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'deployment\data\backend\studyhub.db'), 'disposable-production-accounts')
}
if ($Action -eq 'restore') {
    if (-not $NoPublish) { throw 'Fixture restoration must never publish.' }
    if ($scenario -eq 'restore-error') { Write-Host 'Disposable restore failure'; exit 1 }
    [IO.File]::WriteAllText($admin, 'restored-admin')
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'deployment\data\backend\studyhub.db'), 'restored-production-accounts')
}
if ($Action -eq 'first-admin') {
    if ($scenario -eq 'first-admin-error') { Write-Host 'Disposable first-admin failure'; exit 1 }
    if ($scenario -ne 'first-admin-inactive') { [IO.File]::WriteAllText($admin, 'first-admin') }
}
if ($Action -eq 'account-status') {
    $exists = [bool](Test-Path -LiteralPath $admin)
    $report = @{ checked_utc = [DateTime]::UtcNow.ToString('o'); active_admin_exists = $exists; account_count = $(if ($exists) { 1 } else { 0 }) }
    if ($scenario -eq 'stale-account') { $report.checked_utc = [DateTime]::UtcNow.AddHours(-1).ToString('o') }
    if ($scenario -eq 'invalid-account') { $report.active_admin_exists = 'true' }
    if ($scenario -eq 'negative-account-count') { $report.account_count = -1 }
    [IO.File]::WriteAllText((Join-Path $fixtureRoot '.local\host-account-status.json'), ($report | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
}
if ($Action -eq 'launch') {
    if ($scenario -eq 'launch-error') { Write-Host 'Disposable launch failure'; exit 1 }
    [IO.File]::WriteAllText($caddy, 'owned-QStudy-proxy')
}
if ($Action -eq 'install-autostart' -and $scenario -eq 'autostart-error') { Write-Host 'Disposable autostart failure'; exit 1 }
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $fixtureScripts 'Manage-QStudy.ps1'), $fakeManager, $encoding)

    $fakeNetwork = @'
param([string]$RouterWanIPv4 = '', [int]$HttpPort = 0, [switch]$NoPause)
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$scenario = $env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO
[IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), (ConvertTo-Json -InputObject @{ source = 'network'; action = 'check'; httpPort = $HttpPort; routerWanIPv4 = $RouterWanIPv4; noPause = [bool]$NoPause } -Compress) + [Environment]::NewLine)
if ($scenario -eq 'network-error') { Write-Host 'Disposable network failure'; exit 1 }
$text = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'deployment\.env'))
$public = [regex]::Match($text, "(?m)^QSTUDY_PUBLIC_IP='([^']*)'").Groups[1].Value
$report = @{ version = 1; checkedUtc = [DateTime]::UtcNow.ToString('o'); offline = $false; externalIPv4 = $public; externalIpStatus = 'observed'; wanAssessment = 'public_wan_matches'; externalReachabilityProven = $false; publicHttpPort = $HttpPort }
switch ($scenario) {
    'cgnat' { $report.wanAssessment = 'cgnat' }
    'private-wan' { $report.wanAssessment = 'private_wan' }
    'invalid-wan' { $report.wanAssessment = 'invalid_wan' }
    'wan-mismatch' { $report.wanAssessment = 'wan_mismatch' }
    'ip-mismatch' { $report.externalIPv4 = '8.8.8.8' }
    'external-unavailable' { $report.externalIpStatus = 'unavailable'; $report.externalIPv4 = '' }
    'stale-network' { $report.checkedUtc = [DateTime]::UtcNow.AddHours(-1).ToString('o') }
    'offline-network' { $report.offline = $true }
}
[IO.File]::WriteAllText((Join-Path $fixtureRoot '.local\home-network-report.json'), ($report | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\Test-QStudyHomeNetwork.ps1'), $fakeNetwork, $encoding)

    $fakePublicAccess = @'
param([string]$Action, [switch]$NoPause, [switch]$RouterCleanupConfirmed)
. (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')
. (Join-Path $PSScriptRoot 'QStudy.NetworkOperation.ps1')
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Initialize-QStudyNetworkOperationStore $fixtureRoot $userSid
[IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), (ConvertTo-Json -InputObject @{ source = 'public-access'; action = $Action; noPause = [bool]$NoPause } -Compress) + [Environment]::NewLine)
$scenario = $env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO
if ($scenario -eq 'public-access-error') {
    Save-QStudyNetworkOperation -Root $fixtureRoot -Action $Action -Code 1 -Message 'QStudy: disposable public access failure.' -TargetUserSid $userSid
    Write-Host 'Disposable public access failure'; exit 1
}
$text = [IO.File]::ReadAllText((Join-Path $fixtureRoot 'deployment\.env'))
$public = [regex]::Match($text, "(?m)^QSTUDY_PUBLIC_IP='([^']*)'").Groups[1].Value
$port = [int][regex]::Match($text, "(?m)^QSTUDY_HTTP_PORT='([^']*)'").Groups[1].Value
$state = @{ version = 1; owner = ('QStudy public access: ' + $fixtureRoot); owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; enabled = $true; public_ip = $public; public_url = ('http://' + $public + ':' + $port); port = $port; client_ip = '192.168.1.10'; gateway = '192.168.1.1'; method = $(if ($Action -eq 'manual') { 'manual' } else { 'upnp' }); record = $null; status = 'mapping_configured'; checked_utc = [DateTime]::UtcNow.ToString('o'); external_reachability_proven = $false; mapping_status = 'ready'; provider_action_required = $false; router_public_ip = $public }
$code = 0
if ($Action -eq 'disable') {
    $state.enabled = $false; $state.method = 'none'; $state.status = 'disabled'
    if ($scenario -in @('cleanup-cancelled', 'cleanup-confirmed') -and -not $RouterCleanupConfirmed) {
        $state.method = 'upnp'; $state.status = 'router_cleanup_pending'; $state.record = @{ method = 'upnp'; marker = 'original-fixture-rule' }; $code = 2
    }
} elseif ($Action -eq 'enable' -and $scenario -in @('port-mapping-unsupported', 'port-mapping-manual-confirmed', 'port-mapping-conflict', 'port-mapping-conflict-confirmed', 'port-mapping-conflict-enter', 'router-wan-private')) {
    $state.method = 'none'; $state.status = 'manual_required'; $state.mapping_status = 'unsupported'; $code = 2
    if ($scenario -in @('port-mapping-conflict', 'port-mapping-conflict-confirmed', 'port-mapping-conflict-enter')) { $state.mapping_status = 'conflict' }
    if ($scenario -eq 'router-wan-private') { $state.status = 'provider_action_required'; $state.mapping_status = 'wan_mismatch'; $state.provider_action_required = $true; $state.router_public_ip = '100.64.1.1' }
} elseif ($Action -eq 'manual') { $state.status = 'manual_forwarding_selected' }
$directory = Join-Path $fixtureRoot '.local\public-access'
[IO.Directory]::CreateDirectory($directory) | Out-Null
[IO.File]::WriteAllText((Join-Path $directory 'state.json'), ($state | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
Save-QStudyNetworkOperation -Root $fixtureRoot -Action $Action -Code $code -Message 'QStudy: disposable network operation report.' -TargetUserSid $userSid
exit $code
'@
    [IO.File]::WriteAllText((Join-Path $fixtureScripts 'Manage-QStudyPublicAccess.ps1'), $fakePublicAccess, $encoding)

    $wrapperProgram = @'
param([string]$PublicIP = '', [int]$Port = 0, [string]$RouterWanIPv4 = '', [string]$AdminEmail = '', [string]$Archive = '', [switch]$ManualForwarding, [switch]$NewInstallation, [switch]$Rebuild, [switch]$EnableAutostart, [switch]$NoBrowser, [switch]$NoPause)
$fixtureRoot = $PSScriptRoot
function global:Start-Process {
    param([string]$FilePath, [object]$ArgumentList, [string]$WindowStyle, [switch]$PassThru, [switch]$Wait, [object]$ErrorAction)
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), (ConvertTo-Json -InputObject @{ source = 'browser'; action = 'open'; target = $FilePath; mocked = $true } -Compress) + [Environment]::NewLine)
}
function global:Read-Host {
    param([string]$Prompt, [switch]$AsSecureString)
    [IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-prompts.txt'), $Prompt + [Environment]::NewLine)
    if ($Prompt -like 'Email нового первого администратора*') {
        if ($env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO -eq 'admin-email-cancelled') { return '' }
        return 'first-admin@example.org'
    }
    $scenario = $env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO
    if ($Prompt -ceq 'Выберите 1, 2 или 0') {
        if ($scenario -eq 'data-cancelled') { return '0' }
        if ($scenario -eq 'data-empty') { return '' }
        if ($scenario -in @('data-archive', 'data-dialog-cancelled')) { return '1' }
        return '2'
    }
    if ($Prompt -match '0|1|2|Enter|проброс|правил|копи|данн|архив') {
        if ($scenario -eq 'port-mapping-manual-confirmed') { return '' }
        if ($scenario -eq 'port-mapping-conflict-confirmed') { return '1' }
        if ($scenario -eq 'port-mapping-conflict-enter') { return '' }
        if ($scenario -eq 'cleanup-confirmed') { return '' }
        return '0'
    }
    throw 'Unexpected interactive prompt in a disposable Internet launcher test.'
}
$options = @{ PublicIP = $PublicIP; Port = $Port; RouterWanIPv4 = $RouterWanIPv4; AdminEmail = $AdminEmail; Archive = $Archive; ManualForwarding = $ManualForwarding; NewInstallation = $NewInstallation; Rebuild = $Rebuild; EnableAutostart = $EnableAutostart; NoBrowser = $NoBrowser; NoPause = $NoPause }
& (Join-Path $fixtureRoot 'scripts\production\Start-QStudyInternet.ps1') @options
$launcherExitCode = $LASTEXITCODE
[IO.File]::AppendAllText((Join-Path $fixtureRoot 'launch-calls.jsonl'), (ConvertTo-Json -InputObject @{ source = 'wrapper'; returnedAfterNestedExit = $true; code = $launcherExitCode } -Compress) + [Environment]::NewLine)
exit $launcherExitCode
'@
    [IO.File]::WriteAllText($wrapper, $wrapperProgram, $encoding)

    $result = Invoke-FixtureLaunch -WithoutAdmin -Arguments @('-NoBrowser', '-EnableAutostart')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('fresh automatic launch succeeds: ' + $result.output)
    Assert-Launch ((Get-LaunchManagerActions $calls) -ceq 'init-http,check,stack-status,prepare,account-status,first-admin,account-status,launch,install-autostart') 'fresh installation initializes, prepares and creates only the first administrator before launch/autostart'
    Assert-Launch ((Get-LaunchActions $calls) -ceq 'docker:ready,manager:init-http,manager:check,manager:stack-status,manager:prepare,manager:account-status,manager:first-admin,manager:account-status,network:check,public-access:enable,manager:launch,manager:install-autostart') 'engine, account and network gates precede every public launch and scheduled task'
    Assert-Launch (@($calls | Where-Object source -eq 'ipify').Count -eq 1 -and @($calls | Where-Object source -eq 'port').Count -eq 0) 'fresh launch discovers IPv4 once and keeps fixed 8080 without selecting another port'
    $initialized = @($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'init-http' })[0]
    Assert-Launch ($initialized.publicIP -ceq '94.125.99.135' -and $initialized.port -eq 8080) 'automatic IP and fixed requested 8080 reach the initializer'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'network' -and $_.httpPort -eq 8080 -and $_.noPause }).Count -eq 1) 'network diagnostic receives the saved port without pausing'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'check' -and $_.offline }).Count -eq 1) 'offline configuration validation precedes stack work'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'launch' -and $_.noBrowser }).Count -eq 1) 'NoBrowser reaches the real launch contract'
    Assert-Launch (@(Get-Content -LiteralPath $promptLog).Count -eq 2 -and @(Get-Content -LiteralPath $promptLog | Where-Object { $_ -ceq 'Выберите 1, 2 или 0' }).Count -eq 1 -and @(Get-Content -LiteralPath $promptLog | Where-Object { $_ -like 'Email нового первого администратора*' }).Count -eq 1) 'fresh administrator asks for a deliberate data choice and an email once'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'first-admin' -and $_.email -ceq 'first-admin@example.org' }).Count -eq 1) 'first-admin receives the chosen email'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'wrapper' -and $_.returnedAfterNestedExit -and $_.code -eq 0 }).Count -eq 1) 'nested launcher exits return to the fixture wrapper'
    Assert-Launch ($result.output -match 'http://94.125.99.135:8080' -and $result.output -match 'выключенным Wi-Fi') 'completion displays the configured URL and requires an independent Internet check'
    $runPath = Join-Path $fixture '.local\internet-launch\last-run.json'
    $run = [IO.File]::ReadAllText($runPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-Launch ($run.version -eq 1 -and $run.status -ceq 'complete' -and $run.public_url -ceq 'http://94.125.99.135:8080' -and -not $run.external_reachability_proven) 'successful run saves exact origin without claiming external reachability'
    Assert-Launch ((Get-Acl -LiteralPath $runPath).AreAccessRulesProtected) 'saved launcher outcome uses private Windows ACL'
    Assert-Launch ([IO.File]::ReadAllText($runPath) -notmatch 'synthetic-private-secret|synthetic-smtp-secret') 'saved launcher outcome contains no credentials'

    $savedEnvironment = [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env'))
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('unchanged repeat succeeds: ' + $result.output)
    Assert-Launch ((Get-LaunchManagerActions $calls) -ceq 'check,stack-status,resume-private,account-status,launch') 'unchanged repeat skips initialization and rebuilding'
    Assert-Launch (@($calls | Where-Object source -eq 'ipify').Count -eq 1 -and @($calls | Where-Object source -eq 'port').Count -eq 0) 'repeat redetects IPv4 without assigning a different port'
    Assert-Launch ([IO.File]::ReadAllText($promptLog).Length -eq 0 -and @($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'first-admin' }).Count -eq 0) 'repeat preserves the first administrator without requesting or resetting a password'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env')) -ceq $savedEnvironment) 'repeat leaves saved configuration byte-for-byte unchanged'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'port-owner' -and $_.port -eq 8080 }).Count -ge 1) 'repeat verifies ownership of the same public port'

    $result = Invoke-FixtureLaunch -KeepInstallation -Scenario 'detected-ip-change'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('changed detected IPv4 is refreshed without commands: ' + $result.output)
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'disable' }).Count -eq 1) 'changed IPv4 first disables the owned old network setup'
    Assert-Launch ((Get-LaunchActions $calls).IndexOf('public-access:disable') -lt (Get-LaunchActions $calls).IndexOf('public-access:enable')) 'old forwarding cleanup precedes new forwarding'
    $updated = [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env'))
    Assert-Launch ($updated.Contains("QSTUDY_PUBLIC_IP='8.8.8.8'") -and $updated.Contains("QSTUDY_HTTP_PORT='8080'") -and $updated.Contains("PUBLIC_BASE_URL='http://8.8.8.8:8080'")) 'all three origin settings follow the actual detected IPv4'
    Assert-Launch ($updated.Contains("SECRET_KEY='synthetic-private-secret-keep-exactly'") -and $updated.Contains("SMTP_PASSWORD='synthetic-smtp-secret-keep-exactly'")) 'address refresh preserves passwords and signing secrets'
    Assert-Launch ($result.output -notmatch 'synthetic-private-secret|synthetic-smtp-secret') 'address refresh does not print credentials'
    Assert-Launch ([IO.File]::ReadAllText($promptLog).Length -eq 0) 'address-only refresh asks for no IP, port, email or password'

    $result = Invoke-FixtureLaunch -Arguments @('-PublicIP', '8.8.8.8')
    Assert-Launch ($result.code -eq 0) 'create old owned state before already-correct environment repair test'
    $alreadyCorrect = [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env'))
    $alreadyCorrect = $alreadyCorrect.Replace("QSTUDY_PUBLIC_IP='8.8.8.8'", "QSTUDY_PUBLIC_IP='94.125.99.135'").Replace("PUBLIC_BASE_URL='http://8.8.8.8:8080'", "PUBLIC_BASE_URL='http://94.125.99.135:8080'")
    [IO.File]::WriteAllText((Join-Path $fixture 'deployment\.env'), $alreadyCorrect, [Text.UTF8Encoding]::new($false))
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('stale state cleans up even when env already points at detectedIP: ' + $result.output)
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'disable' }).Count -eq 1 -and @($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'enable' }).Count -eq 1) 'state address mismatch independently triggers old ownership cleanup'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env')) -ceq $alreadyCorrect) 'already correct environment remains byte-for-byte unchanged while stale mapping is cleaned'
    Assert-Launch ($result.output -notmatch 'synthetic-private-secret|synthetic-smtp-secret') 'stale mapping cleanup reveals no credentials'

    $result = Invoke-FixtureLaunch -Arguments @('-PublicIP', '94.125.99.135', '-Port', '3000', '-RouterWanIPv4', '94.125.99.135', '-ManualForwarding')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('explicit user IP and port 3000 supported: ' + $result.output)
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'init-http' -and $_.port -eq 3000 -and $_.publicIP -ceq '94.125.99.135' }).Count -eq 1) 'explicit port 3000 reaches the saved HTTP configuration'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'network' -and $_.httpPort -eq 3000 -and $_.routerWanIPv4 -ceq '94.125.99.135' }).Count -eq 1) 'explicit WAN and port reach the network gate'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -ceq 'manual' }).Count -eq 1) 'ManualForwarding calls only the manual public-access action'
    Assert-Launch ($result.output -match 'http://94.125.99.135:3000' -and @($calls | Where-Object { $_.source -in @('ipify', 'port') }).Count -eq 0) 'explicit address is displayed without IP/port discovery'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'install-autostart' }).Count -eq 0) 'autostart is opt-in'

    $statePath = Join-Path $fixture '.local\public-access\state.json'
    $result = Invoke-FixtureLaunch -KeepInstallation -Arguments @('-Port', '3000')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and @($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'manual' }).Count -eq 1) 'explicit same port can reuse the enabled manual setup'
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('old 3000 installation automatically follows requested 8080: ' + $result.output)
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'disable' }).Count -eq 1) 'old 3000 forwarding is disabled before switching port'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env')).Contains("QSTUDY_HTTP_PORT='8080'") -and $result.output -match 'http://94.125.99.135:8080') 'default double click fixes earlier port3000 settings to8080'
    $result = Invoke-FixtureLaunch -KeepInstallation -Arguments @('-ManualForwarding')
    Assert-Launch ($result.code -eq 0) 'select existing manually configured8080 forwarding for repeat tests'
    $savedManualState = [IO.File]::ReadAllText($statePath)
    Assert-Launch (($savedManualState | ConvertFrom-Json).method -ceq 'manual') 'manual configuration saves its selected forwarding method'
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and (Get-LaunchManagerActions $calls) -ceq 'check,stack-status,resume-private,account-status,launch') 'repeat of a manual installation uses the current images and existing administrator'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -ceq 'manual' }).Count -eq 1 -and @($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -ceq 'enable' }).Count -eq 0) 'repeat automatically preserves the owned enabled manual forwarding method without another flag'
    Assert-Launch ([IO.File]::ReadAllText($promptLog).Length -eq 0) 'manual repeat never requests administrator credentials again'

    $disabledManualState = $savedManualState | ConvertFrom-Json
    $disabledManualState.enabled = $false
    [IO.File]::WriteAllText($statePath, ($disabledManualState | ConvertTo-Json -Depth 5), $encoding)
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and @($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -ceq 'enable' }).Count -eq 1) 'disabled manual state does not silently reuse forwarding as already enabled'

    foreach ($variant in @('other-owner', 'other-root', 'invalid-state', 'other-owner-explicit-manual')) {
        $state = $savedManualState | ConvertFrom-Json
        if ($variant -in @('other-owner', 'other-owner-explicit-manual')) { $state.owner_sid = 'S-1-5-21-0-0-0-1234' }
        if ($variant -eq 'other-root') { $state.owner = 'QStudy public access: ' + $workspace }
        $stateText = if ($variant -eq 'invalid-state') { '{invalid-json' } else { $state | ConvertTo-Json -Depth 5 }
        [IO.File]::WriteAllText($statePath, $stateText, $encoding)
        $arguments = if ($variant -eq 'other-owner-explicit-manual') { @('-ManualForwarding') } else { @() }
        $result = Invoke-FixtureLaunch -KeepInstallation -Arguments $arguments
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -ne 0) ($variant + ' public-access state refuses reuse')
        Assert-Launch (@($calls | Where-Object source -eq 'public-access').Count -eq 0) ($variant + ' cannot execute firewall/router configuration')
        Assert-NoPublish $calls ($variant + ' cannot publish or install autostart')
        Assert-Launch ([IO.File]::ReadAllText($statePath) -ceq $stateText) ($variant + ' state is not replaced by a guessed network mode')
    }
    [IO.File]::WriteAllText($statePath, $savedManualState, $encoding)

    $savedEnvironment = [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env'))
    foreach ($arguments in @(@('-PublicIP', '8.8.8.8'), @('-Port', '3000'))) {
        $result = Invoke-FixtureLaunch -KeepInstallation -Arguments $arguments
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -ne 0 -and $result.output -match 'явные параметры не совпадают') 'conflicting explicit IP or port is rejected without overwriting the installation'
        Assert-Launch ((Get-LaunchManagerActions $calls) -ceq '') 'conflicting explicit address is rejected before configuration or manager mutations'
        Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env')) -ceq $savedEnvironment) 'conflicting IP/port cannot change saved values'
    }
    $httpsEnvironment = $savedEnvironment.Replace("QSTUDY_HOST_MODE='http'", "QSTUDY_HOST_MODE='https'")
    [IO.File]::WriteAllText((Join-Path $fixture 'deployment\.env'), $httpsEnvironment, $encoding)
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -ne 0 -and $result.output -match 'сохранена установка HTTPS') 'HTTP button refuses a saved HTTPS configuration'
    Assert-Launch ((Get-LaunchManagerActions $calls) -ceq '' -and [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env')) -ceq $httpsEnvironment) 'HTTPS configuration and host are untouched'

    foreach ($scenario in @('data-cancelled', 'data-empty')) {
        $result = Invoke-FixtureLaunch -WithoutAdmin -Scenario $scenario
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -ne 0) ($scenario + ' first installation requires an explicit choice before creating an empty database')
        Assert-Launch ([IO.File]::ReadAllText($promptLog).Contains('Выберите 1, 2 или 0') -and $result.output -match 'перв|Перв') ($scenario + ' first-run backup choice is visible even without a local legacy database')
        Assert-Launch ((Get-LaunchManagerActions $calls) -ceq '' -and @($calls | Where-Object source -eq 'docker').Count -eq 0 -and @($calls | Where-Object source -eq 'public-access').Count -eq 0) ($scenario + ' cancellation happens before initialization, Docker or public network changes')
        Assert-Launch (-not (Test-Path -LiteralPath (Join-Path $fixture 'deployment\.env')) -and -not (Test-Path -LiteralPath (Join-Path $fixture 'backend\studyhub.db')) -and -not (Test-Path -LiteralPath (Join-Path $fixture 'deployment\data\backend\studyhub.db'))) ($scenario + ' leaves a fresh installation without a new configuration or database')
        Assert-Launch (@($calls | Where-Object source -eq 'data-dialog').Count -eq 0) ($scenario + ' does not open the archive dialog implicitly')
        Assert-NoPublish $calls ($scenario + ' cannot publish or install autostart')
    }
    $result = Invoke-FixtureLaunch -WithoutAdmin -Scenario 'data-archive'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('fresh host backup dialog restores the existing project: ' + $result.output)
    Assert-Launch (-not (Test-Path -LiteralPath (Join-Path $fixture 'backend\studyhub.db')) -and @($calls | Where-Object source -eq 'data-dialog').Count -eq 1) 'first installation without a legacy database can select a backup through the file dialog'
    Assert-Launch ((Get-LaunchManagerActions $calls) -ceq 'init-http,check,stack-status,prepare,verify,restore,account-status,launch') 'fresh backup is verified and restored before account checks and publication'
    $ordered = Get-LaunchActions $calls
    Assert-Launch ($ordered.IndexOf('manager:verify') -lt $ordered.IndexOf('manager:restore') -and $ordered.IndexOf('manager:restore') -lt $ordered.IndexOf('public-access:enable') -and $ordered.IndexOf('public-access:enable') -lt $ordered.IndexOf('manager:launch')) 'fresh backup verification and restoration precede every public network action and launch'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'restore' -and $_.noPublish -and $_.archive -match '^qstudy-\d{8}-\d{6}-[a-f0-9]{8}\.zip$' }).Count -eq 1) 'fresh dialog selection imports under a safe basename and restores with NoPublish'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'fixture-admin')) -ceq 'restored-admin' -and @($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'first-admin' }).Count -eq 0) 'fresh backup retains its existing administrator instead of creating or resetting one'
    Assert-Launch (@(Get-Content -LiteralPath $promptLog).Count -eq 1 -and [IO.File]::ReadAllText($promptLog).Contains('Выберите 1, 2 или 0')) 'fresh restore asks only for the data choice without administrator credentials'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'deployment\data\backend\studyhub.db')) -ceq 'restored-production-accounts') 'fresh backup restores the intended production data'

    $result = Invoke-FixtureLaunch -LegacyDatabase -Scenario 'data-cancelled'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -ne 0 -and [IO.File]::ReadAllText($promptLog) -match '0|1|2') 'copied local data offers a command-free choice and cancellation blocks empty production'
    Assert-Launch ((Get-LaunchManagerActions $calls) -ceq '' -and @($calls | Where-Object source -eq 'docker').Count -eq 0) 'legacy data cancellation runs before initialization, Docker or preparation'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'backend\studyhub.db')) -ceq 'disposable-local-accounts' -and -not (Test-Path -LiteralPath (Join-Path $fixture 'deployment\data\backend\studyhub.db'))) 'legacy guard preserves original accounts and avoids an empty production database'

    $result = Invoke-FixtureLaunch -LegacyDatabase -Arguments @('-NewInstallation')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and (Get-LaunchManagerActions $calls) -match 'prepare,account-status,launch') 'NewInstallation explicitly permits a separate production installation'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'backend\studyhub.db')) -ceq 'disposable-local-accounts') 'NewInstallation never deletes or modifies copied local data'

    $result = Invoke-FixtureLaunch -LegacyDatabase -Scenario 'data-new-isolated'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and (Get-LaunchManagerActions $calls) -match 'prepare,account-status,launch') 'numeric option2 selects isolated new installation with no command flags'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'backend\studyhub.db')) -ceq 'disposable-local-accounts') 'numeric isolated setup preserves local database'
    $result = Invoke-FixtureLaunch -LegacyDatabase -WithoutAdmin -Scenario 'data-archive'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('numeric archive dialog migration succeeds: ' + $result.output)
    Assert-Launch (@($calls | Where-Object source -eq 'data-dialog').Count -eq 1 -and (Get-LaunchManagerActions $calls) -match 'verify,restore,account-status,launch') 'numeric option1 selects a file, verifies and restores before launch'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'restore' -and $_.noPublish -and $_.archive -match '^qstudy-[a-zA-Z0-9-]+\.zip$' }).Count -eq 1) 'selected external archive is imported under safe basename and privately restored'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'backend\studyhub.db')) -ceq 'disposable-local-accounts') 'dialog import leaves local accounts untouched'
    $result = Invoke-FixtureLaunch -LegacyDatabase -Scenario 'data-dialog-cancelled'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -ne 0 -and @($calls | Where-Object source -eq 'data-dialog').Count -eq 1) 'cancelled backup dialog stops publication without requiring command arguments'
    Assert-NoPublish $calls 'cancelled data dialog cannot publish'

    $result = Invoke-FixtureLaunch -LegacyDatabase -WithoutAdmin -Arguments @('-Archive', 'qstudy-20261014-120000-abcdef01.zip')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('valid archive migration succeeds: ' + $result.output)
    Assert-Launch ((Get-LaunchManagerActions $calls) -ceq 'init-http,check,stack-status,prepare,verify,restore,account-status,launch') 'archive is verified/restored after private preparation and before account checks/publication'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'restore' -and $_.archive -ceq 'qstudy-20261014-120000-abcdef01.zip' -and $_.noPublish }).Count -eq 1) 'archive restore explicitly uses NoPublish'
    Assert-Launch ([IO.File]::ReadAllText($promptLog).Length -eq 0 -and [IO.File]::ReadAllText((Join-Path $fixture 'fixture-admin')) -ceq 'restored-admin') 'restored administrator is preserved without first-admin prompts'
    foreach ($arguments in @(@('-Archive', '..\outside.zip'), @('-Archive', 'C:\outside.zip'), @('-Archive', '-archive.zip'), @('-Archive', 'qstudy-20261014-120000-abcdef01.zip', '-NewInstallation'))) {
        $result = Invoke-FixtureLaunch -Arguments $arguments
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -ne 0) ('invalid/traversing/conflicting archive is rejected: ' + ($arguments -join ' '))
        Assert-Launch ((Get-LaunchManagerActions $calls) -ceq '' -and @($calls | Where-Object source -eq 'docker').Count -eq 0) 'invalid archive is rejected before configuration or host actions'
    }

    $result = Invoke-FixtureLaunch
    Assert-Launch ($result.code -eq 0) 'create current source cache before repeat/rebuild tests'
    [IO.File]::WriteAllText((Join-Path $fixture 'backend\app\fixture.py'), 'source-version-two', $encoding)
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and (Get-LaunchManagerActions $calls) -ceq 'check,stack-status,stop,prepare,account-status,launch') 'source changes stop the owned public proxy and rebuild before relaunch'
    $result = Invoke-FixtureLaunch -KeepInstallation -Arguments @('-Rebuild')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and (Get-LaunchManagerActions $calls) -ceq 'check,stack-status,stop,prepare,account-status,launch') 'Rebuild explicitly stops a running owned stack before preparation'
    $result = Invoke-FixtureLaunch -KeepInstallation -Scenario 'missing-images'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and (Get-LaunchManagerActions $calls) -match 'stop,prepare') 'missing images force rebuilding even with a current source cache'
    foreach ($variant in @('wrong-root', 'wrong-computer', 'wrong-owner', 'invalid-json')) {
        $cachePath = Join-Path $fixture '.local\internet-launch\build.json'
        $cache = [IO.File]::ReadAllText($cachePath) | ConvertFrom-Json
        if ($variant -eq 'wrong-root') { $cache.root = $workspace }
        if ($variant -eq 'wrong-computer') { $cache.computer = 'OTHER-HOST-FIXTURE' }
        if ($variant -eq 'wrong-owner') { $cache.owner_sid = 'S-1-5-21-0-0-0-1234' }
        $text = if ($variant -eq 'invalid-json') { '{invalid-json' } else { $cache | ConvertTo-Json }
        [IO.File]::WriteAllText($cachePath, $text, $encoding)
        $result = Invoke-FixtureLaunch -KeepInstallation
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -eq 0 -and (Get-LaunchManagerActions $calls) -match 'stop,prepare') ($variant + ' cache cannot skip the build on a copied/different host')
    }

    foreach ($scenario in @('docker-error', 'check-error', 'prepare-error', 'verify-error', 'restore-error', 'stale-stack', 'invalid-stack', 'stale-account', 'invalid-account', 'negative-account-count', 'network-error', 'cgnat', 'private-wan', 'invalid-wan', 'wan-mismatch', 'ip-mismatch', 'external-unavailable', 'stale-network', 'offline-network', 'port-mapping-unsupported', 'port-mapping-conflict', 'port-mapping-conflict-enter', 'router-wan-private', 'public-access-error', 'port-occupied')) {
        $arguments = @('-EnableAutostart')
        if ($scenario -in @('verify-error', 'restore-error')) { $arguments += @('-Archive', 'qstudy-20261014-120000-abcdef01.zip') }
        $result = Invoke-FixtureLaunch -Arguments $arguments -Scenario $scenario
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -ne 0) ($scenario + ' propagates a failed launch')
        Assert-NoPublish $calls ($scenario + ' cannot publish or install autostart')
        Assert-Launch ($result.output -notmatch 'QStudy работает на хосте') ($scenario + ' cannot print startup success')
        $run = [IO.File]::ReadAllText((Join-Path $fixture '.local\internet-launch\last-run.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-Launch ($run.status -ceq 'failed' -and [string]$run.stage -and -not $run.external_reachability_proven) ($scenario + ' saves a meaningful failed-stage report')
        Assert-Launch (($run | ConvertTo-Json -Compress) -notmatch 'synthetic-private-secret|synthetic-smtp-secret') ($scenario + ' report never includes private settings')
        if ($scenario -in @('docker-error', 'check-error', 'prepare-error', 'verify-error', 'restore-error', 'stale-stack', 'invalid-stack', 'stale-account', 'invalid-account', 'negative-account-count', 'network-error', 'cgnat', 'private-wan', 'invalid-wan', 'wan-mismatch', 'ip-mismatch', 'external-unavailable', 'stale-network', 'offline-network', 'port-occupied')) {
            Assert-Launch (@($calls | Where-Object source -eq 'public-access').Count -eq 0) ($scenario + ' cannot change firewall/router forwarding')
        }
        if ($scenario -eq 'docker-error') { Assert-Launch ((Get-LaunchManagerActions $calls) -ceq '') 'Docker failure performs no initialization or later manager actions' }
        if ($scenario -eq 'prepare-error') { Assert-Launch (-not (Test-Path -LiteralPath (Join-Path $fixture '.local\internet-launch\build.json'))) 'failed preparation never marks source as successfully built' }
        if ($scenario -eq 'verify-error') { Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'restore' }).Count -eq 0) 'invalid archive is never restored' }
        if ($scenario -eq 'port-occupied') { Assert-Launch (@($calls | Where-Object source -eq 'port').Count -eq 0 -and (Get-LaunchManagerActions $calls) -ceq '') 'busy8080 never selects another port or initializes an unrelated configuration' }
        if ($scenario -eq 'port-mapping-unsupported') {
            Assert-Launch ($result.output -notmatch '\-ManualForwarding' -and $result.output -match '8080' -and $result.output -match '192.168.1.10') 'unsupported router shows actual TCP target and no fallback command'
            $guide = [IO.File]::ReadAllText((Join-Path $fixture '.local\internet-launch\router-instructions.txt'))
            Assert-Launch ($guide.Contains('External / WAN port: 8080') -and $guide.Contains('Server IP: 192.168.1.10') -and $guide.Contains('http://192.168.1.1')) 'manual guide persists exact external/internal port and router address'
        }
        if ($scenario -in @('router-wan-private', 'port-mapping-conflict', 'port-mapping-conflict-enter')) { Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'manual' }).Count -eq 0) 'known WAN/conflict cannot be bypassed as manual success without deliberate proof of own rule' }
    }

    $result = Invoke-FixtureLaunch -Scenario 'port-mapping-manual-confirmed'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('manual rule Enter-confirmation continues in same window: ' + $result.output)
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'enable' }).Count -eq 1 -and @($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'manual' }).Count -eq 1) 'unavailable automatic mapping transitions to deliberate manual action once'
    Assert-Launch ([IO.File]::ReadAllText($promptLog) -match 'Enter|0') 'manual transition needs only Enter after router instructions'
    $result = Invoke-FixtureLaunch -KeepInstallation
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and @($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'manual' }).Count -eq 1) 'next double-click retains manually confirmed forwarding without flags'
    Assert-Launch ([IO.File]::ReadAllText($promptLog).Length -eq 0) 'saved manual forwarding adds no repeat prompt'
    $result = Invoke-FixtureLaunch -Scenario 'port-mapping-conflict-confirmed'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('own existing forwarding rule can be deliberately confirmed with1: ' + $result.output)
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'manual' }).Count -eq 1 -and [IO.File]::ReadAllText($promptLog) -match '1') 'only explicit numeric ownership confirmation permits readonly manual mode'

    $result = Invoke-FixtureLaunch -Arguments @('-PublicIP', '8.8.8.8')
    Assert-Launch ($result.code -eq 0) 'create owned old IPv4 setup for cleanup UI tests'
    $oldAddressEnvironment = [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env'))
    $result = Invoke-FixtureLaunch -KeepInstallation -Scenario 'cleanup-cancelled'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -ne 0 -and @($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'disable' }).Count -eq 1) 'uncertain old mapping cleanup prompts and can be cancelled'
    Assert-Launch ([IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env')) -ceq $oldAddressEnvironment) 'cancelled cleanup keeps old environment and credentials intact'
    Assert-NoPublish $calls 'cancelled old mapping cleanup cannot publish'
    $result = Invoke-FixtureLaunch -KeepInstallation -Scenario 'cleanup-confirmed'
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0) ('explicit UI confirmation of manual old-rule cleanup succeeds: ' + $result.output)
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'public-access' -and $_.action -eq 'disable' }).Count -ge 1 -and [IO.File]::ReadAllText((Join-Path $fixture 'deployment\.env')).Contains("QSTUDY_PUBLIC_IP='94.125.99.135'")) 'confirmed old cleanup allows actual detected address refresh'

    foreach ($scenario in @('admin-email-cancelled', 'first-admin-error', 'first-admin-inactive')) {
        $result = Invoke-FixtureLaunch -WithoutAdmin -Scenario $scenario -Arguments @('-EnableAutostart')
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -ne 0) ($scenario + ' stops until there is an active administrator')
        Assert-NoPublish $calls ($scenario + ' cannot publish or install autostart')
        Assert-Launch (@($calls | Where-Object { $_.source -in @('network', 'public-access') }).Count -eq 0) ($scenario + ' cannot alter the network before an active administrator exists')
    }
    $result = Invoke-FixtureLaunch -WithoutAdmin -Arguments @('-AdminEmail', 'chosen-admin@example.org')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -eq 0 -and @(Get-Content -LiteralPath $promptLog).Count -eq 1 -and [IO.File]::ReadAllText($promptLog).Contains('Выберите 1, 2 или 0')) 'explicit AdminEmail avoids a separate email prompt while first-run data choice stays deliberate'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'first-admin' -and $_.email -ceq 'chosen-admin@example.org' }).Count -eq 1) 'explicit AdminEmail is used only to create the missing first administrator'

    $result = Invoke-FixtureLaunch -Scenario 'launch-error' -Arguments @('-EnableAutostart')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -ne 0 -and @($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'launch' }).Count -eq 1) 'manager launch failure propagates after the successful safety gates'
    Assert-Launch (@($calls | Where-Object { $_.source -eq 'manager' -and $_.action -eq 'install-autostart' }).Count -eq 0) 'failed public launch cannot install autostart'
    foreach ($scenario in @('init-error', 'ip-detection-error')) {
        $result = Invoke-FixtureLaunch -Scenario $scenario
        $calls = @(Read-LaunchCalls)
        Assert-Launch ($result.code -ne 0) ($scenario + ' stops startup')
        if ($scenario -eq 'ip-detection-error') { Assert-Launch (@($calls | Where-Object source -eq 'docker').Count -eq 0 -and (Get-LaunchManagerActions $calls) -ceq '') 'IP detection failure stops before Docker or initialization' }
        else { Assert-Launch ((Get-LaunchManagerActions $calls) -ceq 'init-http') 'initialization failure prevents every later manager action' }
        Assert-NoPublish $calls ($scenario + ' cannot publish')
    }
    $result = Invoke-FixtureLaunch -Arguments @('-PublicIP', '100.64.1.2')
    $calls = @(Read-LaunchCalls)
    Assert-Launch ($result.code -ne 0 -and (Get-LaunchManagerActions $calls) -ceq '') 'CGNAT address is rejected before initialization'

    Write-Host ('Internet launcher checks passed (' + $checks + ' assertions). Real launcher/environment/cache guards; disposable fake host only. No Docker, browser, firewall, router, mail, account or scheduled-task changes were made.')
} finally {
    $env:QSTUDY_INTERNET_LAUNCH_TEST_SCENARIO = $oldScenario
    $resolved = [IO.Path]::GetFullPath($fixture)
    $expectedPrefix = [IO.Path]::GetFullPath($fixturePrefix).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($expectedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside Internet launcher test fixtures.' }
    if (Test-Path -LiteralPath $resolved) {
        if (((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing cleanup of a linked Internet launcher fixture.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
exit 0
