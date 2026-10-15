# Disposable process-state fixtures. No real process, network, database or .env.
. (Join-Path $PSScriptRoot '..\launcher\Native.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$prefix = Join-Path $workspace '.local\native-stop-tests'
$fixture = Join-Path $prefix ([Guid]::NewGuid().ToString('N'))
$checks = 0
$script:stopped = [Collections.Generic.List[string]]::new()
$script:networkStops = 0
$script:legacyWrites = 0
$script:failChild = $false
$script:liveSupervisor = $false
$script:legacy = [pscustomobject]@{ frontend = $null; backend = $null }
function Assert-Stop([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-StopThrows([scriptblock]$Operation, [string]$Message) {
    $thrown = $false
    try { & $Operation | Out-Null } catch { $thrown = $true }
    Assert-Stop $thrown $Message
}
# All operating-system process/network effects are replaced before any call.
function Get-QStudyOwnedProcess($Identity) {
    if ($script:liveSupervisor -and $null -ne $Identity -and $Identity.marker -ceq 'fixture-supervisor') {
        return [pscustomobject]@{ ExecutablePath = 'never-execute-a-fixture.exe' }
    }
    return $null
}
function Stop-QStudyRecord($Record) {
    if ($script:failChild) { throw 'Fixture owned child is still stopping.' }
    $script:stopped.Add([string]$Record.identity.marker)
}
function Read-QStudyState { return $script:legacy }
function Write-QStudyState($State) { $script:legacy = $State; $script:legacyWrites++ }
function Disable-QStudyNativeNetwork([string]$Root) {
    Assert-Stop ($Root -ceq $fixture) 'network cleanup stays bound to the fixture installation'
    $script:networkStops++
}
function Save-StopState([string]$Root = $fixture) {
    $value = [pscustomobject]@{
        version = 3; root = $Root; instance = '11111111111111111111111111111111'
        computer = (Get-QStudyComputerFingerprint)
        owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        supervisor = [pscustomobject]@{ identity = [pscustomobject]@{ marker = 'fixture-supervisor' } }
        frontend = [pscustomobject]@{ identity = [pscustomobject]@{ marker = 'fixture-frontend' } }
        backend = [pscustomobject]@{ identity = [pscustomobject]@{ marker = 'fixture-backend' } }
    }
    Write-QStudyInstallJson (Join-Path $fixture '.local\launcher\state.json') $value
    return $value
}
try {
    [IO.Directory]::CreateDirectory((Join-Path $fixture '.local\launcher')) | Out-Null
    [IO.Directory]::CreateDirectory((Join-Path $fixture 'backend')) | Out-Null
    $database = Join-Path $fixture 'backend\studyhub.db'
    $settings = Join-Path $fixture 'backend\.env'
    $choice = Join-Path $fixture '.local\launcher\data-choice.json'
    [IO.File]::WriteAllText($database, 'FixtureExistingAccountsAndMaterials')
    [IO.File]::WriteAllText($settings, 'FixtureUnchangedPrivateSettings')
    [IO.File]::WriteAllText($choice, '{"source":"local","had_database":true}')
    $databaseHash = Get-QStudyInstallHash $database
    $settingsHash = Get-QStudyInstallHash $settings
    $choiceHash = Get-QStudyInstallHash $choice
    $statePath = Join-Path $fixture '.local\launcher\state.json'

    $localPath = Join-Path $fixture '.local'
    $localAclBefore = (Get-Item -LiteralPath $localPath).GetAccessControl().Sddl
    Assert-QStudyNativeStopOwner $fixture
    $getOwner = (Get-Item Function:\Get-QStudyNativeStorageOwner).ScriptBlock
    function Get-QStudyNativeStorageOwner([string]$Path) { return 'S-1-5-21-111-222-333-9999' }
    Assert-StopThrows { Assert-QStudyNativeStopOwner $fixture } 'a different Windows administrator cannot take ownership while stopping the site'
    Assert-Stop ((Get-Item -LiteralPath $localPath).GetAccessControl().Sddl -ceq $localAclBefore -and $script:stopped.Count -eq 0 -and $script:networkStops -eq 0) 'rejecting another owner leaves permissions, processes and network untouched'
    Set-Item Function:\Get-QStudyNativeStorageOwner $getOwner

    $foreignOwner = Save-StopState
    $foreignOwner.owner_sid = 'S-1-5-21-111-222-333-9999'
    Write-QStudyInstallJson $statePath $foreignOwner
    Assert-StopThrows { Assert-QStudyNativeStopOwner $fixture } 'the current-machine runtime owner is also checked before acquiring the stop lock'
    Assert-Stop ((Get-Item -LiteralPath $localPath).GetAccessControl().Sddl -ceq $localAclBefore) 'a foreign runtime record cannot rewrite the local storage ACL'

    $state = Save-StopState
    Stop-QStudySite $fixture
    Assert-Stop (($script:stopped -join ',') -ceq 'fixture-frontend,fixture-backend') 'an orphaned runtime stops only its verified child records'
    Assert-Stop (-not (Test-Path -LiteralPath $statePath)) 'successful stop clears process state so the next start creates one runtime'
    Assert-Stop ($script:networkStops -eq 1) 'stop cleans up only installation-owned network access'
    Stop-QStudySite $fixture
    Assert-Stop ($script:stopped.Count -eq 2 -and $script:networkStops -eq 2) 'repeating stop is safe without installing dependencies or starting an application'

    $copied = Save-StopState 'C:\a-different-qstudy-checkout'
    Stop-QStudySite $fixture
    Assert-Stop ($script:stopped.Count -eq 2 -and (Test-Path -LiteralPath $statePath)) 'a copied state never authorizes process termination or state deletion'

    $state = Save-StopState
    Write-QStudyInstallJson (Join-Path $fixture '.local\launcher\launch.json') @{ root = $fixture; owner_sid = $state.owner_sid; instance = '22222222222222222222222222222222' }
    $script:liveSupervisor = $true
    Assert-StopThrows { Stop-QStudyNativeState $fixture $state $null } 'a live supervisor never receives a command signed for another launch instance'
    Assert-Stop ((Test-Path -LiteralPath $statePath) -and $script:stopped.Count -eq 2) 'rejected control preserves retry state and children'
    $script:liveSupervisor = $false

    $script:failChild = $true
    Assert-StopThrows { Stop-QStudySite $fixture } 'a child still stopping is reported instead of declaring success'
    Assert-Stop (Test-Path -LiteralPath $statePath) 'failed stop retains the process records for a retry'
    $script:failChild = $false
    Stop-QStudySite $fixture

    $script:legacy = [pscustomobject]@{
        frontend = [pscustomobject]@{ identity = [pscustomobject]@{ marker = 'fixture-old-frontend' } }
        backend = [pscustomobject]@{ identity = [pscustomobject]@{ marker = 'fixture-old-backend' } }
    }
    Stop-QStudySite $fixture
    Assert-Stop (($script:stopped -join ',').EndsWith('fixture-old-frontend,fixture-old-backend')) 'the previous ownership-checked local launcher is also supported'
    Assert-Stop ($null -eq $script:legacy.frontend -and $null -eq $script:legacy.backend -and $script:legacyWrites -eq 2) 'legacy records are cleared only after each successful stop'
    Assert-Stop ((Get-QStudyInstallHash $database) -ceq $databaseHash -and (Get-QStudyInstallHash $settings) -ceq $settingsHash -and (Get-QStudyInstallHash $choice) -ceq $choiceHash) 'stop preserves database bytes, private settings and selected data source'
    $button = [IO.File]::ReadAllText((Join-Path $workspace 'Stop-QStudy.cmd'))
    Assert-Stop ($button -match 'scripts\\Stop-QStudy\.ps1' -and $button -notmatch 'docker|taskkill|Stop-Process') 'the root stop button delegates to the owned native runtime'
    Write-Host ('QStudy native stop: ' + $checks + ' assertions passed.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($prefix) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the stop fixture.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
