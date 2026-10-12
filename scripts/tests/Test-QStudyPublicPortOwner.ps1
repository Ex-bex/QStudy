# Disposable read-only fixtures. No Docker daemon or real network settings.
param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $workspace 'scripts\production\QStudy.PublicPortOwner.ps1')
$fixturePrefix = Join-Path $workspace '.local\public-port-owner-tests'
$fixture = Join-Path $fixturePrefix ([Guid]::NewGuid().ToString('N'))
$checks = 0
$oldDockerHost = $env:DOCKER_HOST
$oldDockerContext = $env:DOCKER_CONTEXT
$script:portCalls = [Collections.Generic.List[object]]::new()
$script:portScenario = 'own'
$encoding = [Text.UTF8Encoding]::new($true)

function Assert-PortOwner([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Invoke-PortOwnerFixture([string]$Scenario) {
    $script:portScenario = $Scenario
    $script:portCalls.Clear()
    try { Assert-QStudyPublicPortOwner -Root $fixture -Port 8080; return [PSCustomObject]@{ accepted = $true; message = '' } }
    catch { return [PSCustomObject]@{ accepted = $false; message = $_.Exception.Message } }
}

try {
    $env:DOCKER_HOST = ''; $env:DOCKER_CONTEXT = ''
    [IO.Directory]::CreateDirectory((Join-Path $fixture 'deployment')) | Out-Null
    $powershell = (Get-Command powershell.exe -CommandType Application).Source
    $echoProgram = Join-Path $fixture 'echo-argument.ps1'
    [IO.File]::WriteAllText($echoProgram, 'param([string]$Text); ConvertTo-Json -InputObject $Text -Compress', $encoding)
    $literal = 'space & $(not-a-shell-command) "quoted" trailing\'
    $echoed = Invoke-QStudyPublicPortDocker -Executable $powershell -Arguments @('-NoLogo', '-NoProfile', '-File', $echoProgram, '-Text', $literal)
    Assert-PortOwner (($echoed | ConvertFrom-Json) -ceq $literal) 'native process arguments preserve quotes, backslashes, dollar signs and shell characters literally'
    $environmentProgram = Join-Path $fixture 'echo-environment.ps1'
    [IO.File]::WriteAllText($environmentProgram, 'ConvertTo-Json -InputObject @($env:DOCKER_HOST, $env:DOCKER_CONTEXT) -Compress', $encoding)
    $env:DOCKER_HOST = 'tcp://fixture-secret@remote.example:2376'; $env:DOCKER_CONTEXT = 'fixture-context'
    $environmentOutput = Invoke-QStudyPublicPortDocker -Executable $powershell -Arguments @('-NoLogo', '-NoProfile', '-File', $environmentProgram) -Pinned
    $childEnvironment = ConvertFrom-Json -InputObject $environmentOutput
    Assert-PortOwner (-not $childEnvironment[0] -and -not $childEnvironment[1]) 'pinned process removes Docker host/context overrides only in the child'
    Assert-PortOwner ($env:DOCKER_HOST -eq 'tcp://fixture-secret@remote.example:2376' -and $env:DOCKER_CONTEXT -eq 'fixture-context') 'read-only inspection preserves parent environment'
    $env:DOCKER_HOST = ''; $env:DOCKER_CONTEXT = ''
    $sleepProgram = Join-Path $fixture 'bounded-sleep.ps1'
    [IO.File]::WriteAllText($sleepProgram, 'Start-Sleep -Seconds 3', $encoding)
    $timer = [Diagnostics.Stopwatch]::StartNew(); $timedOut = $false
    try { Invoke-QStudyPublicPortDocker -Executable $powershell -Arguments @('-NoLogo', '-NoProfile', '-File', $sleepProgram) -TimeoutMs 150 | Out-Null }
    catch { $timedOut = $_.Exception.Message -like 'QStudy:*timed out*' }
    $timer.Stop()
    Assert-PortOwner ($timedOut -and $timer.ElapsedMilliseconds -lt 2000) 'native inspection stops a slow process within its bounded timeout'

    function Get-NetTCPConnection {
        param([string]$State, $ErrorAction)
        if ($script:portScenario -eq 'listener-error') { throw 'PrivateFixtureError' }
        $port = if ($script:portScenario -eq 'free') { 9090 } else { 8080 }
        return @([PSCustomObject]@{ LocalPort = $port; LocalAddress = '0.0.0.0'; OwningProcess = 4 }, [PSCustomObject]@{ LocalPort = $port; LocalAddress = '::'; OwningProcess = 4 })
    }
    function Get-Command {
        param([string]$Name, $CommandType, $ErrorAction)
        if ($Name -eq 'docker.exe') { return [PSCustomObject]@{ Source = 'fixture-docker.exe' } }
        return Microsoft.PowerShell.Core\Get-Command -Name $Name -ErrorAction SilentlyContinue
    }
    function Invoke-QStudyPublicPortDocker {
        param([string]$Executable, [string[]]$Arguments, [switch]$Pinned, [int]$TimeoutMs = 10000)
        $script:portCalls.Add([PSCustomObject]@{ arguments = $Arguments; pinned = [bool]$Pinned })
        if ($Arguments[0] -eq 'context' -and $Arguments[1] -eq 'show') { return 'desktop-linux' }
        if ($Arguments[0] -eq 'context' -and $Arguments[1] -eq 'inspect') {
            $endpoint = if ($script:portScenario -eq 'remote-context') { 'ssh://fixture-secret@remote.example' } else { 'npipe:////./pipe/dockerDesktopLinuxEngine' }
            return ConvertTo-Json -InputObject $endpoint -Compress
        }
        if (-not $Pinned -or $Arguments[0] -cne '--host' -or -not (Test-QStudyLocalDockerEndpoint $Arguments[1])) { throw 'Fixture command escaped the pinned local daemon.' }
        if ($Arguments -contains 'info') {
            if ($script:portScenario -eq 'engine-failure') { throw 'PrivateFixtureError' }
            return $(if ($script:portScenario -eq 'windows-engine') { 'windows' } else { 'linux' })
        }
        if ($Arguments -contains 'ps') { return $(if ($script:portScenario -eq 'no-caddy') { '' } else { 'aabbccddeeff' }) }
        if ($Arguments -contains 'inspect') {
            $owner = Join-Path $fixture 'deployment'
            $mappedPort = '8080'; $project = 'qstudy'; $service = 'caddy'; $running = $true
            switch ($script:portScenario) {
                'foreign-checkout' { $owner = Join-Path $fixture 'foreign-deployment' }
                'foreign-port' { $mappedPort = '8181' }
                'foreign-project' { $project = 'other-app' }
                'foreign-service' { $service = 'frontend' }
                'stopped-caddy' { $running = $false }
            }
            $bindings = @(@{ HostIp = '0.0.0.0'; HostPort = $mappedPort }, @{ HostIp = '::'; HostPort = $mappedPort })
            if ($script:portScenario -eq 'partial-bindings') { $bindings = @(@{ HostIp = '127.0.0.1'; HostPort = $mappedPort }) }
            if ($script:portScenario -eq 'malformed-metadata') { return '{broken' }
            return ConvertTo-Json -InputObject @{ labels = @{ 'com.docker.compose.project' = $project; 'com.docker.compose.service' = $service; 'com.docker.compose.project.working_dir' = $owner }; ports = @{ '80/tcp' = $bindings }; running = $running } -Depth 8 -Compress
        }
        throw 'Unexpected disposable Docker command.'
    }

    $result = Invoke-PortOwnerFixture 'free'
    Assert-PortOwner ($result.accepted -and $script:portCalls.Count -eq 0) 'a free selected port requires no Docker calls even if other ports listen'
    $result = Invoke-PortOwnerFixture 'own'
    Assert-PortOwner $result.accepted 'running Caddy from this exact checkout owning both IPv4 and IPv6 bindings is accepted'
    Assert-PortOwner (@($script:portCalls | Where-Object { $_.arguments -contains 'inspect' -and $_.arguments -notcontains 'context' -and (($_.arguments -join ' ') -match 'Config\.Env') }).Count -eq 0) 'container inspection never requests environment or a full secret-bearing object'
    Assert-PortOwner (@($script:portCalls | Where-Object { $_.arguments -contains 'info' -or $_.arguments -contains 'ps' -or ($_.arguments -contains 'inspect' -and $_.arguments -notcontains 'context') } | Where-Object { -not $_.pinned }).Count -eq 0) 'every daemon query remains pinned to the verified local endpoint'
    foreach ($scenario in @('foreign-checkout', 'foreign-port', 'foreign-project', 'foreign-service', 'stopped-caddy', 'partial-bindings', 'no-caddy', 'malformed-metadata', 'engine-failure', 'windows-engine', 'listener-error')) {
        $result = Invoke-PortOwnerFixture $scenario
        Assert-PortOwner (-not $result.accepted) ($scenario + ' cannot expose an occupied port')
    }
    $result = Invoke-PortOwnerFixture 'remote-context'
    Assert-PortOwner (-not $result.accepted -and @($script:portCalls | Where-Object { $_.arguments -contains 'info' -or $_.arguments -contains 'inspect' -and $_.arguments -notcontains 'context' }).Count -eq 0) 'remote context is refused before any daemon or container query'
    Assert-PortOwner ($result.message -notmatch 'fixture-secret') 'remote context errors never expose endpoint credentials'
    $env:DOCKER_HOST = 'tcp://fixture-secret@remote.example:2376'
    $result = Invoke-PortOwnerFixture 'own'
    Assert-PortOwner (-not $result.accepted -and $script:portCalls.Count -eq 0 -and $result.message -notmatch 'fixture-secret') 'remote host overrides are refused before CLI calls without exposing credentials'
    Write-Host ('Public port owner checks passed (' + $checks + ' assertions). Read-only fake Docker/listeners and disposable native process only.')
} finally {
    $env:DOCKER_HOST = $oldDockerHost; $env:DOCKER_CONTEXT = $oldDockerContext
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($fixturePrefix) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside port owner fixtures.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
