param()
. (Join-Path $PSScriptRoot 'QStudy.Common.ps1')
$checks = 0
function Assert-Launcher([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
$realRoot = $script:QStudyRoot
$fixture = Join-Path $realRoot ('.local\launcher-tests\' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$script:QStudyRoot = $fixture
$script:QStudyLocal = Join-Path $fixture '.local'
$script:QStudyStateFile = Join-Path $script:QStudyLocal 'processes.json'
[IO.Directory]::CreateDirectory($script:QStudyLocal) | Out-Null
$held = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$held.Server.ExclusiveAddressUse = $true
try {
    $held.Start()
    $busy = [int]$held.LocalEndpoint.Port
    Assert-Launcher (-not (Test-QStudyPortUsable $busy)) 'bound socket is unavailable'
    $free = Find-QStudyFreePort $busy '127.0.0.1'
    Assert-Launcher ($free -ne $busy) 'busy preferred port is skipped'
    Assert-Launcher (Test-QStudyPortUsable $free) 'selected alternative can be bound'
    Assert-Launcher ($held.Server.IsBound) 'foreign socket remains running'
    $excluded = Find-QStudyFreePort $free '127.0.0.1' @($free)
    Assert-Launcher ($excluded -ne $free) 'backend and frontend cannot choose same port'

    $state = New-QStudyState
    Set-QStudyAddresses $state $free $false
    Assert-Launcher ($state.browserUrl -eq ('http://127.0.0.1:' + $free)) 'actual port is in browser URL'
    Assert-Launcher ($state.bind -eq '127.0.0.1' -and @($state.lanUrls).Count -eq 0) 'local mode remains private'
    function Get-QStudyLanAddresses { return @('192.168.42.15', '10.10.0.2') }
    Set-QStudyAddresses $state $free $true
    Assert-Launcher ($state.browserUrl -eq ('http://192.168.42.15:' + $free)) 'LAN browser URL uses current interface'
    Assert-Launcher ($state.bind -eq '0.0.0.0' -and @($state.lanUrls).Count -eq 2) 'LAN state records bind and all URLs'
    function Get-QStudyLanAddresses { return @() }
    Set-QStudyAddresses $state $free $true
    Assert-Launcher ($state.browserUrl -eq $state.localUrl) 'LAN with no interface falls back to loopback'

    $foreignWorkspace = Join-Path $fixture 'old-workspace'
    $state = New-QStudyState
    $state.workspace = $foreignWorkspace
    # Deliberately copy a live current PID: reading stale state must never stop it.
    $current = Get-QStudyProcess $PID
    $state.backend = [PSCustomObject]@{ identity = (New-QStudyProcessIdentity $current); name = 'backend'; port = $busy; descendants = @() }
    Write-QStudyState $state
    $moved = Read-QStudyState
    Assert-Launcher ($moved.workspace -eq $fixture -and $null -eq $moved.backend) 'moved folder resets process identities'
    Assert-Launcher ($moved.previousWorkspace -eq $foreignWorkspace) 'previous workspace is retained for data repair'
    Assert-Launcher ($null -ne (Get-QStudyProcess $PID)) 'copied live PID is not terminated'
    Assert-Launcher (@(Get-ChildItem -LiteralPath (Join-Path $script:QStudyLocal 'stale-state') -File).Count -eq 1) 'old state is archived'
    $state = New-QStudyState
    $state.computer = 'another-computer'
    Write-QStudyState $state
    $copied = Read-QStudyState
    Assert-Launcher ($null -eq $copied.backend -and $copied.computer -ne 'another-computer') 'same-path different computer resets copied identities'

    $legacy = [PSCustomObject]@{ version = 1; workspace = $fixture; backend = $null; frontend = $null }
    Write-QStudyState $legacy
    $upgraded = Read-QStudyState
    Assert-Launcher ($upgraded.version -eq 2 -and $upgraded.mode -eq 'local') 'legacy launcher state upgrades safely'
    $identity = New-QStudyProcessIdentity $current
    $identity.createdUtc = [DateTime]::UtcNow.AddYears(-1).ToString('o')
    Assert-Launcher ($null -eq (Get-QStudyOwnedProcess $identity)) 'reused PID fails creation-time identity check'
    [IO.File]::WriteAllText($script:QStudyStateFile, '{broken')
    $corruptRejected = $false
    try { [void](Read-QStudyState) } catch { $corruptRejected = $true }
    Assert-Launcher $corruptRejected 'corrupt state cannot cause process termination'
    Write-Host ("PASS: $checks launcher checks; live QStudy servers were not changed.")
} finally { $held.Stop() }
