# Exercises real Windows ACLs and a disposable manager against a fake Docker CLI.
param()
. (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')
$checks = 0
function Assert-HostCheck([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixture = Join-Path $workspace ('.local\windows-host-tests\' + [Guid]::NewGuid().ToString('N'))
$powershell = (Get-Command powershell.exe -CommandType Application).Source
$pythonCandidates = @((Join-Path $workspace 'backend\.venv\Scripts\python.exe')) + @(Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | ForEach-Object Source)
$python = @($pythonCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf })[0]
if (-not $python) { throw 'Install Python before running this disposable test.' }
$oldEngine = $env:QSTUDY_TEST_DOCKER_ENGINE
$oldFailure = $env:QSTUDY_TEST_DOCKER_FAILURE
$oldOwner = $env:QSTUDY_TEST_DOCKER_OWNER
$oldRunning = $env:QSTUDY_TEST_DOCKER_RUNNING
$oldPublicBase = $env:PUBLIC_BASE_URL
$oldProjectName = $env:COMPOSE_PROJECT_NAME
$oldDockerHost = $env:DOCKER_HOST
$oldDockerContext = $env:DOCKER_CONTEXT
$oldTestEndpoint = $env:QSTUDY_TEST_DOCKER_ENDPOINT
$oldBuilder = $env:BUILDX_BUILDER
$oldSelectedBuilder = $env:QSTUDY_TEST_BUILDX_SELECTED
$oldBuildxConfig = $env:BUILDX_CONFIG
$fixtureDeployment = Join-Path $fixture 'deployment'
$fixtureScripts = Join-Path $fixture 'scripts\production'
$manager = Join-Path $fixtureScripts 'Manage-QStudy.ps1'
$callLog = Join-Path $fixture 'docker-calls.jsonl'
$configurationLog = Join-Path $fixture 'configuration-calls.jsonl'
$browserLog = Join-Path $fixture 'browser-calls.txt'
$junction = Join-Path $fixtureDeployment 'data\linked'

function Invoke-FixtureManager([string[]]$Arguments) {
    $oldPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $output = @(& $powershell -NoProfile -ExecutionPolicy Bypass -File $manager @Arguments 2>&1)
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $oldPreference }
    return [PSCustomObject]@{ code = $code; output = ($output -join "`n") }
}
function Read-DockerCalls {
    if (-not (Test-Path -LiteralPath $callLog)) { return @() }
    foreach ($line in @(Get-Content -LiteralPath $callLog)) {
        $entry = $line | ConvertFrom-Json
        Write-Output -NoEnumerate ([string[]]$entry.arguments)
    }
}
function Read-ConfigurationCalls {
    if (-not (Test-Path -LiteralPath $configurationLog)) { return @() }
    foreach ($line in @(Get-Content -LiteralPath $configurationLog)) {
        $entry = $line | ConvertFrom-Json
        Write-Output -NoEnumerate ([string[]]$entry.arguments)
    }
}
function Reset-DockerCalls {
    [IO.File]::WriteAllText($callLog, '')
    [IO.File]::WriteAllText($configurationLog, '')
    [IO.File]::WriteAllText($browserLog, '')
}

try {
    $env:DOCKER_HOST = ''
    $env:DOCKER_CONTEXT = ''
    $env:QSTUDY_TEST_DOCKER_ENDPOINT = ''
    $env:QSTUDY_TEST_DOCKER_RUNNING = ''
    [IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
    [IO.Directory]::CreateDirectory($fixtureDeployment) | Out-Null
    foreach ($name in @('Manage-QStudy.ps1', 'QStudy.WindowsHost.ps1', 'configure.py')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $fixtureScripts }
    Copy-Item -LiteralPath (Join-Path $workspace 'deployment\.env.example') -Destination $fixtureDeployment
    [IO.File]::WriteAllText((Join-Path $fixtureDeployment 'compose.yml'), 'name: qstudy')
    $fakeDocker = Join-Path $fixture 'fake-docker.ps1'
    $escapedPython = $python.Replace("'", "''")
    $escapedDocker = $fakeDocker.Replace("'", "''")
    $escapedBrowserLog = $browserLog.Replace("'", "''")
    $installer = @'
function Enter-QStudyInstallLock { return [IO.MemoryStream]::new() }
function Find-QStudyBasePython { return [PSCustomObject]@{ path = 'PYTHON_PATH' } }
function global:Get-Command {
    param([string]$Name, $CommandType, $ErrorAction)
    if ($Name -eq 'docker.exe') { return [PSCustomObject]@{ Source = 'DOCKER_PATH' } }
    return Microsoft.PowerShell.Core\Get-Command -Name $Name -ErrorAction SilentlyContinue
}
function global:Start-Process {
    param([string]$FilePath)
    [IO.File]::AppendAllText('BROWSER_LOG_PATH', $FilePath + [Environment]::NewLine)
}
'@
    [IO.File]::WriteAllText((Join-Path $fixture 'scripts\QStudy.Install.ps1'), $installer.Replace('PYTHON_PATH', $escapedPython).Replace('DOCKER_PATH', $escapedDocker).Replace('BROWSER_LOG_PATH', $escapedBrowserLog))
    $fakeProgram = @'
$callPath = Join-Path $PSScriptRoot 'docker-calls.jsonl'
$inheritedSettings = @('QSTUDY_DOMAIN', 'ACME_EMAIL', 'PUBLIC_BASE_URL', 'SECRET_KEY', 'BFF_PROXY_SECRET', 'RECOVERY_DELIVERY') | Where-Object { [Environment]::GetEnvironmentVariable($_, 'Process') }
[IO.File]::AppendAllText($callPath, (ConvertTo-Json -InputObject @{ arguments = [string[]]$args; inheritedProductionSettings = @($inheritedSettings).Count -gt 0; defaultBuilder = $env:BUILDX_BUILDER -eq 'default'; privateBuildxStore = $env:BUILDX_CONFIG -eq (Join-Path $PSScriptRoot '.local\buildx') } -Compress) + [Environment]::NewLine)
$commandArgs = [string[]]$args
if ($commandArgs[0] -eq '--host') { $commandArgs = $commandArgs[2..($commandArgs.Count - 1)] }
$global:LASTEXITCODE = 0
if ($commandArgs[0] -eq 'context' -and $commandArgs -contains 'show') { if ($env:DOCKER_CONTEXT) { Write-Output $env:DOCKER_CONTEXT } else { Write-Output 'desktop-linux' }; return }
if ($commandArgs[0] -eq 'context' -and $commandArgs -contains 'inspect') { $endpoint = if ($env:QSTUDY_TEST_DOCKER_ENDPOINT) { $env:QSTUDY_TEST_DOCKER_ENDPOINT } else { 'npipe:////./pipe/dockerDesktopLinuxEngine' }; Write-Output (ConvertTo-Json -InputObject $endpoint -Compress); return }
if ($commandArgs[0] -eq 'info') { if ($env:QSTUDY_TEST_DOCKER_ENGINE) { Write-Output $env:QSTUDY_TEST_DOCKER_ENGINE } else { Write-Output 'linux' }; return }
if ($commandArgs[0] -eq 'ps') { if ($env:QSTUDY_TEST_DOCKER_OWNER) { Write-Output 'a11b22c33d44' }; return }
if ($commandArgs[0] -eq 'inspect') { Write-Output (ConvertTo-Json -InputObject @{ 'com.docker.compose.project.working_dir' = $env:QSTUDY_TEST_DOCKER_OWNER } -Compress); return }
if ($commandArgs -contains 'version') { Write-Output 'Docker Compose test'; return }
if ($commandArgs -contains 'ps') { if ($commandArgs -contains '--services') { if ($env:QSTUDY_TEST_DOCKER_RUNNING) { foreach ($service in $env:QSTUDY_TEST_DOCKER_RUNNING.Split(',')) { if ($service -ne 'none') { Write-Output $service } } } else { Write-Output 'backend' } }; return }
if ($env:QSTUDY_TEST_DOCKER_FAILURE -and $commandArgs -contains $env:QSTUDY_TEST_DOCKER_FAILURE) { $global:LASTEXITCODE = 1; Write-Output 'Disposable failure'; return }
if ($commandArgs -contains 'build') {
    $builderIndex = [Array]::IndexOf($commandArgs, '--builder')
    $builder = if ($builderIndex -ge 0) { $commandArgs[$builderIndex + 1] } elseif ($env:BUILDX_BUILDER) { $env:BUILDX_BUILDER } else { $env:QSTUDY_TEST_BUILDX_SELECTED }
    if ($builder -ne 'default') { $global:LASTEXITCODE = 91; Write-Output 'A remote fixture builder was selected'; return }
}
if ($commandArgs -contains 'up' -and $commandArgs -notcontains '--no-build') { $global:LASTEXITCODE = 92; Write-Output 'An implicit fixture build was allowed'; return }
'@
    [IO.File]::WriteAllText($fakeDocker, $fakeProgram)
    $result = Invoke-FixtureManager @('init', '-Domain', 'qstudy-ci.example.org', '-Email', 'owner@example.org')
    Assert-HostCheck ($result.code -eq 0) ('initialization works with stdlib Python and no Docker engine: ' + $result.output)
    $privateEnvironment = Join-Path $fixtureDeployment '.env'
    $before = [IO.File]::ReadAllBytes($privateEnvironment)
    $result = Invoke-FixtureManager @('init', '-Domain', 'qstudy-ci.example.org', '-Email', 'owner@example.org')
    Assert-HostCheck ($result.code -eq 0) 'reinitialization succeeds'
    Assert-HostCheck ([Convert]::ToBase64String($before) -eq [Convert]::ToBase64String([IO.File]::ReadAllBytes($privateEnvironment))) 'reinitialization preserves secrets byte for byte'
    Assert-HostCheck ($result.output -notmatch 'SECRET_KEY|BFF_PROXY_SECRET|SMTP_PASSWORD') 'initialization does not print credentials'
    $acl = Get-Acl -LiteralPath $privateEnvironment
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    $unsafeRules = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed })
    Assert-HostCheck ($acl.AreAccessRulesProtected -and $unsafeRules.Count -eq 0) 'private environment ACL allows only owner, system and administrators'
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -eq 0) 'offline configuration and Docker validation works'
    $calls = @(Read-DockerCalls)
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'config' -and $_ -notcontains '--quiet' }).Count -eq 0) 'Docker never prints resolved secret configuration'
    $privateBuildx = Join-Path $fixture '.local\buildx'
    $acl = Get-Acl -LiteralPath $privateBuildx
    $unsafeRules = @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed })
    Assert-HostCheck ($acl.AreAccessRulesProtected -and $unsafeRules.Count -eq 0) 'private Buildx store ACL allows only owner, system and administrators'
    $customDefault = Join-Path $privateBuildx 'instances\default'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $customDefault)) | Out-Null
    [IO.File]::WriteAllText($customDefault, '{"Name":"default","Driver":"remote"}')
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'Custom default Buildx instances are forbidden') 'imported remote default node group is rejected'
    Assert-HostCheck (@((Read-DockerCalls) | Where-Object { $_ -contains 'info' -or $_ -contains 'compose' }).Count -eq 0) 'custom default refusal happens before engine contact or builds'
    Remove-Item -LiteralPath $customDefault -Force
    foreach ($endpoint in @('npipe:////./pipe/dockerDesktopLinuxEngine', 'npipe:////./pipe/docker_engine', 'npipe://./pipe/docker_engine')) {
        Assert-HostCheck (Test-QStudyLocalDockerEndpoint $endpoint) 'standard local Docker named pipe is supported'
    }
    foreach ($endpoint in @('ssh://remote.example', 'tcp://127.0.0.1:2375', 'tcp://remote.example:2376', 'unix:///var/run/docker.sock', 'npipe:////server/pipe/docker_engine', 'npipe:////./pipe/name/extra', 'npipe:////%2e/pipe/docker_engine', '')) {
        Assert-HostCheck (-not (Test-QStudyLocalDockerEndpoint $endpoint)) 'remote, ambiguous and non-Windows endpoints are rejected'
    }
    $env:DOCKER_HOST = 'tcp://owner:PrivateFixture@remote.example:2376'
    $env:DOCKER_CONTEXT = 'local-test-context'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'Remote DOCKER_HOST is unsupported') 'remote DOCKER_HOST is rejected even with a local context override'
    Assert-HostCheck ($result.output -notmatch 'PrivateFixture|remote.example' -and @(Read-DockerCalls).Count -eq 0) 'remote override refuses before Docker contact and never prints URI credentials'
    $env:DOCKER_HOST = ''
    $env:DOCKER_CONTEXT = 'remote-test-context'
    $env:QSTUDY_TEST_DOCKER_ENDPOINT = 'ssh://owner:PrivateFixture@remote.example'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'context is not local Docker Desktop') 'remote selected context is rejected after metadata inspection'
    $calls = @(Read-DockerCalls)
    Assert-HostCheck ($result.output -notmatch 'PrivateFixture|remote.example' -and @($calls | Where-Object { $_ -contains 'info' -or $_ -contains 'compose' }).Count -eq 0) 'remote context never contacts engine or reveals endpoint'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'inspect' -and $_ -contains 'remote-test-context' }).Count -eq 1) 'DOCKER_CONTEXT selects the inspected metadata'
    $env:QSTUDY_TEST_DOCKER_ENDPOINT = ''
    $env:DOCKER_CONTEXT = 'local-test-context'
    $env:DOCKER_HOST = 'npipe:////./pipe/docker_engine'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -eq 0) 'local context and local host override are accepted'
    $calls = @(Read-DockerCalls)
    $wrongEndpoint = @($calls | Where-Object { $_ -contains '--host' -and $_[[Array]::IndexOf($_, '--host') + 1] -ne 'npipe:////./pipe/dockerDesktopLinuxEngine' })
    Assert-HostCheck ($wrongEndpoint.Count -eq 0 -and @($calls | Where-Object { $_ -contains 'info' -and $_ -contains '--host' }).Count -eq 1) 'context precedence is respected and subsequent commands pin its verified local pipe'
    $env:DOCKER_CONTEXT = ''
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('check', '-Offline')
    $calls = @(Read-DockerCalls)
    $wrongEndpoint = @($calls | Where-Object { $_ -contains '--host' -and $_[[Array]::IndexOf($_, '--host') + 1] -ne 'npipe:////./pipe/docker_engine' })
    Assert-HostCheck ($result.code -eq 0 -and $wrongEndpoint.Count -eq 0) 'explicit local DOCKER_HOST is honored when no context override exists'
    $env:DOCKER_HOST = ''
    $env:QSTUDY_TEST_DOCKER_ENGINE = 'windows'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'Linux engine is unavailable') 'Windows-container engine is rejected before compose changes'
    $env:QSTUDY_TEST_DOCKER_ENGINE = ''
    $env:QSTUDY_TEST_DOCKER_OWNER = 'C:\another-project\deployment'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'Another checkout owns Docker project') 'foreign Compose project ownership prevents operating on another checkout'
    Assert-HostCheck (@((Read-DockerCalls) | Where-Object { $_ -contains 'stop' -or $_ -contains 'up' -or $_ -contains 'build' }).Count -eq 0) 'foreign containers are never stopped or replaced'
    $env:QSTUDY_TEST_DOCKER_OWNER = $fixtureDeployment
    $result = Invoke-FixtureManager @('check', '-Offline')
    Assert-HostCheck ($result.code -eq 0) 'containers from the exact checkout are accepted'
    $env:QSTUDY_TEST_DOCKER_OWNER = ''

    # Public probes in manager tests are synthetic. Never contact a domain,
    # launch an actual application, change a real account, or send mail.
    $fakeConfiguration = @'
import json
import sys
from pathlib import Path
with (Path(__file__).resolve().parents[2] / "configuration-calls.jsonl").open("a", encoding="utf-8") as call_log:
    call_log.write(json.dumps({"arguments": sys.argv[1:]}) + "\n")
print(json.dumps({"status": "disposable", "public_url": "https://qstudy-ci.example.org"}))
'@
    [IO.File]::WriteAllText((Join-Path $fixtureScripts 'configure.py'), $fakeConfiguration)
    $env:PUBLIC_BASE_URL = 'http://127.0.0.1:3333'
    $env:COMPOSE_PROJECT_NAME = 'foreign-fixture-do-not-touch'
    $env:BUILDX_BUILDER = 'remote-fixture-do-not-contact'
    $env:QSTUDY_TEST_BUILDX_SELECTED = 'selected-remote-fixture-do-not-contact'
    $env:BUILDX_CONFIG = 'C:\untrusted-remote-buildx-fixture'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('start', '-NoBrowser')
    Assert-HostCheck ($result.code -eq 0) 'start completes verified orchestration with synthetic probes'
    $calls = @(Read-DockerCalls)
    $unsafeExports = @(Get-Content -LiteralPath $callLog | ConvertFrom-Json | Where-Object inheritedProductionSettings)
    Assert-HostCheck ($unsafeExports.Count -eq 0) 'stale shell settings cannot override validated production dotenv settings'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'compose' -and $_ -notcontains '--project-name' }).Count -eq 1) 'managed Compose operations pin project name; standalone version query does not need it'
    $wrongProject = @($calls | Where-Object { $_ -contains '--project-name' -and $_[[Array]::IndexOf($_, '--project-name') + 1] -ne 'qstudy' })
    Assert-HostCheck ($wrongProject.Count -eq 0 -and $env:COMPOSE_PROJECT_NAME -eq 'foreign-fixture-do-not-touch') 'hostile COMPOSE_PROJECT_NAME cannot switch managed project or mutate parent settings'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'build' -and $_ -contains '--pull' }).Count -eq 1) 'start builds production images'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'build' -and $_ -contains '--builder' -and $_[[Array]::IndexOf($_, '--builder') + 1] -eq 'default' }).Count -eq 1) 'explicit default builder overrides hostile remote builder preferences'
    $unsafeBuilders = @(Get-Content -LiteralPath $callLog | ConvertFrom-Json | Where-Object { $_.arguments -contains '--host' -and -not $_.defaultBuilder })
    Assert-HostCheck ($unsafeBuilders.Count -eq 0 -and $env:BUILDX_BUILDER -eq 'remote-fixture-do-not-contact') 'daemon calls pin default builder process environment without changing parent preferences'
    $unsafeStores = @(Get-Content -LiteralPath $callLog | ConvertFrom-Json | Where-Object { $_.arguments -contains '--host' -and -not $_.privateBuildxStore })
    Assert-HostCheck ($unsafeStores.Count -eq 0 -and $env:BUILDX_CONFIG -eq 'C:\untrusted-remote-buildx-fixture') 'all daemon calls use isolated Buildx store and preserve hostile parent configuration'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'validate' -and $_ -contains 'caddyfile' }).Count -eq 1) 'Caddy validation runs before publication'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'mail-check-if-enabled' }).Count -eq 1) 'SMTP authentication preflight runs before full stack startup'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' -and $_ -contains '--wait' }).Count -eq 2) 'backend readiness precedes full stack readiness'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' -and $_ -notcontains '--no-build' }).Count -eq 0) 'every start up operation disables implicit builds'
    $env:QSTUDY_TEST_DOCKER_FAILURE = 'validate'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('start', '-NoBrowser')
    Assert-HostCheck ($result.code -ne 0) 'bad Caddy configuration fails launch'
    Assert-HostCheck (@((Read-DockerCalls) | Where-Object { $_ -contains 'up' }).Count -eq 0) 'bad Caddy configuration cannot expose the application'
    $env:QSTUDY_TEST_DOCKER_FAILURE = ''
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('resume', '-Offline', '-NoBrowser')
    Assert-HostCheck ($result.code -eq 0) 'sign-in resume succeeds without a rebuild'
    $calls = @(Read-DockerCalls)
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'build' -or $_ -contains 'pull' }).Count -eq 0) 'resume never fetches images or builds app dependencies'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' -and $_ -contains '--no-build' -and $_ -contains '--pull' -and $_ -contains 'never' }).Count -eq 1) 'resume disables implicit Docker builds and image pulls'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('update', '-NoBrowser')
    Assert-HostCheck ($result.code -eq 0) 'update completes'
    $calls = @(Read-DockerCalls)
    $backupIndex = -1; $buildIndex = -1
    for ($i = 0; $i -lt $calls.Count; $i++) { if ($calls[$i] -contains 'backup') { $backupIndex = $i }; if ($calls[$i] -contains 'build') { $buildIndex = $i } }
    Assert-HostCheck ($backupIndex -ge 0 -and $backupIndex -lt $buildIndex) 'update creates backup before replacing containers'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'build' -and $_ -notcontains '--builder' }).Count -eq 0 -and @($calls | Where-Object { $_ -contains 'up' -and $_ -notcontains '--no-build' }).Count -eq 0) 'update stays on default builder and never implicitly rebuilds'

    Reset-DockerCalls
    $result = Invoke-FixtureManager @('prepare')
    Assert-HostCheck ($result.code -eq 0 -and $result.output -match 'no public ports were published') 'prepare completes privately without publishing'
    $calls = @(Read-DockerCalls)
    $configurationCalls = @(Read-ConfigurationCalls)
    Assert-HostCheck ($configurationCalls.Count -eq 1 -and $configurationCalls[0] -contains 'check' -and $configurationCalls[0] -contains '--offline') 'prepare validates configuration without requiring public DNS or invoking HTTPS probes'
    Assert-HostCheck ([IO.File]::ReadAllText($browserLog).Length -eq 0) 'prepare does not launch a browser even without NoBrowser'
    $backupIndex = -1; $buildIndex = -1; $validateIndex = -1; $backendIndex = -1; $mailIndex = -1; $privateIndex = -1
    for ($i = 0; $i -lt $calls.Count; $i++) {
        if ($calls[$i] -contains 'backup') { $backupIndex = $i }
        if ($calls[$i] -contains 'build') { $buildIndex = $i }
        if ($calls[$i] -contains 'validate') { $validateIndex = $i }
        if ($calls[$i] -contains 'up' -and $calls[$i] -contains 'backend' -and $calls[$i] -notcontains 'frontend') { $backendIndex = $i }
        if ($calls[$i] -contains 'mail-check-if-enabled') { $mailIndex = $i }
        if ($calls[$i] -contains 'up' -and $calls[$i] -contains 'backend' -and $calls[$i] -contains 'frontend') { $privateIndex = $i }
    }
    Assert-HostCheck ($backupIndex -ge 0 -and $backupIndex -lt $buildIndex) 'prepare backs up a running backend before changing images or containers'
    Assert-HostCheck ($buildIndex -lt $validateIndex -and $validateIndex -lt $backendIndex -and $backendIndex -lt $mailIndex -and $mailIndex -lt $privateIndex) 'prepare validates Caddy, waits for backend, checks SMTP then waits for private frontend'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'build' -and $_ -contains '--pull' -and $_ -contains '--builder' -and $_[[Array]::IndexOf($_, '--builder') + 1] -eq 'default' }).Count -eq 1) 'prepare uses verified local default builder and downloads current base images'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'pull' -and $_ -contains 'caddy' }).Count -eq 1) 'prepare pulls Caddy for isolated validation'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'validate' -and $_ -contains 'run' -and $_ -contains '--no-deps' -and $_ -notcontains '--service-ports' }).Count -eq 1) 'prepare validates Caddy without dependencies or host port publication'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' -and ($_ -contains 'caddy' -or $_ -notcontains 'backend' -or $_ -notcontains '--no-build' -or $_ -notcontains '--wait') }).Count -eq 0) 'prepare starts only named private services with health waits and no implicit builds'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'stop' -or $_ -contains 'down' }).Count -eq 0) 'prepare never stops an existing stack'
    $unsafeBuilders = @(Get-Content -LiteralPath $callLog | ConvertFrom-Json | Where-Object { $_.arguments -contains '--host' -and (-not $_.defaultBuilder -or -not $_.privateBuildxStore) })
    Assert-HostCheck ($unsafeBuilders.Count -eq 0) 'prepare retains the isolated local Docker and Buildx safeguards'

    Reset-DockerCalls
    $result = Invoke-FixtureManager @('prepare', '-Offline')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'prepare requires Internet access') 'prepare rejects Offline because image downloads require Internet'
    Assert-HostCheck (@(Read-DockerCalls).Count -eq 0 -and @(Read-ConfigurationCalls).Count -eq 0) 'offline prepare rejection happens before Docker contact or configuration changes'

    $env:QSTUDY_TEST_DOCKER_RUNNING = 'backend,frontend,caddy'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('prepare')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'Caddy service is already running') 'prepare refuses an already published checkout'
    Assert-HostCheck (@((Read-DockerCalls) | Where-Object { $_ -contains 'backup' -or $_ -contains 'build' -or $_ -contains 'pull' -or $_ -contains 'run' -or $_ -contains 'up' -or $_ -contains 'stop' }).Count -eq 0) 'published checkout refusal happens before backups, builds or service mutations'
    $env:QSTUDY_TEST_DOCKER_RUNNING = 'none'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('prepare')
    Assert-HostCheck ($result.code -eq 0 -and @((Read-DockerCalls) | Where-Object { $_ -contains 'backup' }).Count -eq 0) 'first preparation with no running backend does not invoke an unavailable backup service'
    $env:QSTUDY_TEST_DOCKER_RUNNING = ''
    foreach ($failure in @('backup', 'validate', 'mail-check-if-enabled')) {
        $env:QSTUDY_TEST_DOCKER_FAILURE = $failure
        Reset-DockerCalls
        $result = Invoke-FixtureManager @('prepare')
        $calls = @(Read-DockerCalls)
        Assert-HostCheck ($result.code -ne 0) ('prepare stops on failed ' + $failure)
        Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' -and $_ -contains 'frontend' }).Count -eq 0) ('failed ' + $failure + ' cannot start private frontend or public Caddy')
        Assert-HostCheck (@((Read-ConfigurationCalls) | Where-Object { $_ -contains 'probe' }).Count -eq 0) ('failed ' + $failure + ' cannot invoke a public HTTPS probe')
    }
    $env:QSTUDY_TEST_DOCKER_FAILURE = ''
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('start', '-NoPublish')
    Assert-HostCheck ($result.code -ne 0 -and $result.output -match 'supported only with restore') 'NoPublish is rejected for actions other than restore'
    Assert-HostCheck (@(Read-DockerCalls).Count -eq 0 -and @(Read-ConfigurationCalls).Count -eq 0) 'invalid NoPublish cannot contact Docker or change configuration'
    foreach ($badArchive in @('../private.zip', '..', '-option.zip', 'C:\secret.zip', 'nested/backup.zip')) {
        $rejected = $false
        try { Assert-QStudyBackupBasename $badArchive } catch { $rejected = $true }
        Assert-HostCheck $rejected 'archive arguments cannot traverse paths or become CLI options'
    }
    $env:QSTUDY_TEST_DOCKER_FAILURE = 'restore'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('restore', '-Archive', 'backup-fixture.zip', '-NoBrowser')
    Assert-HostCheck ($result.code -ne 0) 'failed restore returns failure'
    $calls = @(Read-DockerCalls)
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'stop' -and $_ -contains 'caddy' -and $_ -contains 'frontend' -and $_ -contains 'backend' }).Count -eq 1) 'restore stops the entire stack'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'restore' -and $_ -contains '--stopped' }).Count -eq 1) 'restore passes stopped-services guard'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' }).Count -eq 0) 'failed restore leaves services stopped'
    $env:QSTUDY_TEST_DOCKER_FAILURE = ''
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('restore', '-Archive', 'backup-fixture.zip', '-NoBrowser')
    $calls = @(Read-DockerCalls)
    Assert-HostCheck ($result.code -eq 0 -and @($calls | Where-Object { $_ -contains 'up' -and $_ -contains '--no-build' }).Count -eq 1) 'successful restore resumes existing images without implicit builds'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' -and ($_ -contains 'backend' -or $_ -contains 'frontend') }).Count -eq 0 -and @((Read-ConfigurationCalls) | Where-Object { $_ -contains 'probe' }).Count -eq 1) 'normal restore still resumes the full stack and verifies public HTTPS'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('restore', '-Archive', 'backup-fixture.zip', '-NoPublish')
    $calls = @(Read-DockerCalls)
    Assert-HostCheck ($result.code -eq 0 -and $result.output -match 'Caddy remains stopped') 'private restore succeeds without publishing'
    $verifyIndex = -1; $stopIndex = -1; $restoreIndex = -1; $privateIndex = -1
    for ($i = 0; $i -lt $calls.Count; $i++) {
        if ($calls[$i] -contains 'verify') { $verifyIndex = $i }
        if ($calls[$i] -contains 'stop') { $stopIndex = $i }
        if ($calls[$i] -contains 'restore') { $restoreIndex = $i }
        if ($calls[$i] -contains 'up') { $privateIndex = $i }
    }
    Assert-HostCheck ($verifyIndex -ge 0 -and $verifyIndex -lt $stopIndex -and $stopIndex -lt $restoreIndex -and $restoreIndex -lt $privateIndex) 'private restore preserves archive verification, complete stop and guarded restore order'
    Assert-HostCheck (@($calls | Where-Object { $_ -contains 'up' -and $_ -contains 'backend' -and $_ -contains 'frontend' -and $_ -notcontains 'caddy' -and $_ -contains '--no-build' -and $_ -contains '--wait' }).Count -eq 1) 'private restore resumes only backend/frontend and waits for health'
    Assert-HostCheck (@((Read-ConfigurationCalls) | Where-Object { $_ -contains 'probe' }).Count -eq 0 -and [IO.File]::ReadAllText($browserLog).Length -eq 0) 'private restore performs no public HTTPS probe and launches no browser'
    $env:QSTUDY_TEST_DOCKER_FAILURE = 'restore'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('restore', '-Archive', 'backup-fixture.zip', '-NoPublish')
    Assert-HostCheck ($result.code -ne 0 -and @((Read-DockerCalls) | Where-Object { $_ -contains 'up' }).Count -eq 0) 'failed private restore leaves all services stopped'
    $env:QSTUDY_TEST_DOCKER_FAILURE = 'verify'
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('restore', '-Archive', 'backup-fixture.zip', '-NoPublish')
    Assert-HostCheck ($result.code -ne 0 -and @((Read-DockerCalls) | Where-Object { $_ -contains 'stop' -or $_ -contains 'restore' -or $_ -contains 'up' }).Count -eq 0) 'invalid backup prevents private restore from stopping or replacing running services'
    $env:QSTUDY_TEST_DOCKER_FAILURE = ''
    Reset-DockerCalls
    $result = Invoke-FixtureManager @('BACKUP')
    Assert-HostCheck ($result.code -eq 0 -and @((Read-DockerCalls) | Where-Object { $_ -contains 'production_runtime.py' -and $_ -ccontains 'backup' }).Count -eq 1) 'Windows command names normalize before Python operational arguments'

    $spec = Get-QStudyHostTaskSpec $fixture
    $ownedTask = [PSCustomObject]@{ Description = $spec.description; Principal = [PSCustomObject]@{ UserId = $spec.userSid }; Actions = @([PSCustomObject]@{ Execute = $spec.executable; Arguments = $spec.arguments }) }
    Assert-HostCheck (Test-QStudyHostTaskOwned $ownedTask $spec) 'owned sign-in task matches exact script and arguments'
    Assert-HostCheck ($spec.arguments -match '-WindowStyle Hidden') 'background sign-in task does not create a visible console'
    $ownedTask.Principal.UserId = 'S-1-5-18'
    Assert-HostCheck (-not (Test-QStudyHostTaskOwned $ownedTask $spec)) 'same-script task of another principal cannot be overwritten or removed'
    $ownedTask.Principal.UserId = $spec.userSid
    $ownedTask.Actions[0].Arguments = '-File C:\another-project\start.ps1'
    Assert-HostCheck (-not (Test-QStudyHostTaskOwned $ownedTask $spec)) 'unrelated scheduled task cannot be overwritten or removed'
    Assert-HostCheck ((Get-QStudyHostTaskName $fixture) -ne (Get-QStudyHostTaskName (Join-Path $fixture 'other'))) 'different checkouts use different task names'
    $outsideRejected = $false
    try { Assert-QStudyHostPath $fixture (Join-Path $fixture '..\outside') | Out-Null } catch { $outsideRejected = $true }
    Assert-HostCheck $outsideRejected 'ACL operations reject paths outside the intended root'
    $target = Join-Path $fixture 'junction-target'
    [IO.Directory]::CreateDirectory($target) | Out-Null
    New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
    $linkRejected = $false
    try { Protect-QStudyHostStorage $fixture } catch { $linkRejected = $true }
    Assert-HostCheck $linkRejected 'ACL recursion rejects filesystem junctions without following them'
    Remove-Item -LiteralPath $junction -Force
    $storeJunction = Join-Path $privateBuildx 'linked-store-entry'
    New-Item -ItemType Junction -Path $storeJunction -Target $target | Out-Null
    $storeLinkRejected = $false
    try { Initialize-QStudyPrivateBuildx $fixture | Out-Null } catch { $storeLinkRejected = $true }
    Assert-HostCheck $storeLinkRejected 'private Buildx recursion rejects junctions before modifying external targets'
    Remove-Item -LiteralPath $storeJunction -Force
    Write-Host ('Windows host checks passed (' + $checks + ' assertions). No real Docker services or scheduled tasks were changed.')
} finally {
    $env:QSTUDY_TEST_DOCKER_ENGINE = $oldEngine
    $env:QSTUDY_TEST_DOCKER_FAILURE = $oldFailure
    $env:QSTUDY_TEST_DOCKER_OWNER = $oldOwner
    $env:QSTUDY_TEST_DOCKER_RUNNING = $oldRunning
    $env:PUBLIC_BASE_URL = $oldPublicBase
    $env:COMPOSE_PROJECT_NAME = $oldProjectName
    $env:DOCKER_HOST = $oldDockerHost
    $env:DOCKER_CONTEXT = $oldDockerContext
    $env:QSTUDY_TEST_DOCKER_ENDPOINT = $oldTestEndpoint
    $env:BUILDX_BUILDER = $oldBuilder
    $env:QSTUDY_TEST_BUILDX_SELECTED = $oldSelectedBuilder
    $env:BUILDX_CONFIG = $oldBuildxConfig
    if (Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction -Force }
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    $allowedPrefix = [IO.Path]::GetFullPath((Join-Path $workspace '.local\windows-host-tests')) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedFixture.StartsWith($allowedPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing fixture cleanup outside the test directory.' }
    if (Test-Path -LiteralPath $resolvedFixture) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
exit 0
