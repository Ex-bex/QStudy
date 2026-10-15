# Disposable metadata fixtures only: no application, network or live database operations.
. (Join-Path $PSScriptRoot '..\launcher\Native.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$prefix = Join-Path $workspace '.local\native-launcher-tests'
$fixture = Join-Path $prefix ([Guid]::NewGuid().ToString('N'))
$checks = 0; $script:promptCount = 0
$script:answers = [Collections.Generic.Queue[string]]::new()
function Read-Host([string]$Prompt) {
    $script:promptCount++
    if (-not $script:answers.Count) { throw 'Unexpected fixture prompt.' }
    return $script:answers.Dequeue()
}
function Assert-NativeLauncher([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-NativeLauncherThrows([scriptblock]$Operation, [string]$Message) {
    $thrown = $false
    try { & $Operation | Out-Null } catch { $thrown = $true; Assert-NativeLauncher ($_.Exception.Message -notmatch 'FixtureSecret') 'error contains no account/settings content' }
    Assert-NativeLauncher $thrown $Message
}
function New-NativeFixture([string]$Name) {
    $path = Join-Path $fixture $Name
    foreach ($relative in @('backend', 'deployment\data\backend', 'frontend\app', 'frontend\components', 'frontend\lib', 'frontend\types', 'frontend\public')) { [IO.Directory]::CreateDirectory((Join-Path $path $relative)) | Out-Null }
    Initialize-QStudyNativeStorage $path
    return $path
}
$secretText = "SECRET_KEY=fixture-existing-secret-0123456789abcdef0123456789`r`nSMTP_PASSWORD=FixtureSecretExistingSMTP`r`nGEMINI_API_KEY=FixtureSecretExistingAI`r`n"
$junction = Join-Path $fixture 'linked-host'
try {
    $fresh = New-NativeFixture 'fresh'
    $selected = Get-QStudyNativeDataset $fresh
    Assert-NativeLauncher ($selected.source -ceq 'local' -and $selected.database -ceq (Join-Path $fresh 'backend\studyhub.db')) 'fresh install consistently chooses local paths without creating a database'
    Assert-NativeLauncher (-not (Test-Path -LiteralPath $selected.database) -and -not (Test-Path -LiteralPath $selected.env_file)) 'data selection never imports, initializes or writes a database/settings file'
    $repeat = Get-QStudyNativeDataset $fresh
    Assert-NativeLauncher ($repeat.source -ceq 'local' -and $script:promptCount -eq 0) 'first install can resume dependency installation before its database is initialized'
    Initialize-QStudySecret $fresh
    Assert-NativeLauncher (Test-QStudySecret $fresh) 'new install prepares a strong application secret once'
    $savedSecretFile = [IO.File]::ReadAllText($selected.env_file)
    Initialize-QStudySecret $fresh
    Assert-NativeLauncher ([IO.File]::ReadAllText($selected.env_file) -ceq $savedSecretFile) 'repeat installation preserves its existing secret exactly'

    $legacy = New-NativeFixture 'legacy-production'
    $legacyDB = Join-Path $legacy 'deployment\data\backend\studyhub.db'
    [IO.File]::WriteAllText($legacyDB, 'FixtureSecretOpaqueProductionAccounts')
    $legacyEnv = Join-Path $legacy 'deployment\.env'
    [IO.File]::WriteAllText($legacyEnv, $secretText)
    $selected = Get-QStudyNativeDataset $legacy
    Assert-NativeLauncher ($selected.source -ceq 'deployment' -and $selected.database -ceq $legacyDB -and $selected.env_file -ceq $legacyEnv) 'production-only checkout uses its original data and settings directly'
    Assert-NativeLauncher ((Get-QStudySettingsPath $legacy) -ceq $legacyEnv) 'portable installer validates the selected production settings file'
    Initialize-QStudySecret $legacy
    Assert-NativeLauncher ([IO.File]::ReadAllText($legacyEnv) -ceq $secretText -and -not (Test-Path -LiteralPath (Join-Path $legacy 'backend\.env'))) 'production startup never creates unrelated local settings or rotates production secrets'
    Assert-NativeLauncher ([IO.File]::ReadAllText($legacyDB) -ceq 'FixtureSecretOpaqueProductionAccounts') 'data selection keeps every existing account byte unchanged'
    $envBackup = [IO.File]::ReadAllText($legacyEnv)
    Remove-Item -LiteralPath $legacyEnv -Force
    Assert-NativeLauncherThrows { Initialize-QStudySecret $legacy } 'missing settings for an existing database never cause a new application secret or lost mail settings'
    Assert-NativeLauncher (-not (Test-Path -LiteralPath $legacyEnv) -and -not (Test-Path -LiteralPath (Join-Path $legacy 'backend\.env'))) 'missing production settings are not substituted by a fresh local configuration'
    [IO.File]::WriteAllText($legacyEnv, $envBackup)

    $created = New-NativeFixture 'created-before-failed-start'
    Get-QStudyNativeDataset $created | Out-Null
    [IO.File]::WriteAllText((Join-Path $created 'backend\studyhub.db'), 'FixtureSecretNewlyCreatedAccounts')
    Get-QStudyNativeDataset $created | Out-Null
    Assert-NativeLauncher ([bool](Read-QStudyInstallJson (Join-Path $created '.local\launcher\data-choice.json')).had_database) 'a database created before a failed frontend start is immediately remembered'
    Remove-Item -LiteralPath (Join-Path $created 'backend\studyhub.db') -Force
    Assert-NativeLauncherThrows { Get-QStudyNativeDataset $created } 'a previously created database cannot silently be recreated empty after deletion'

    $both = New-NativeFixture 'both-different'
    $localDB = Join-Path $both 'backend\studyhub.db'
    $productionDB = Join-Path $both 'deployment\data\backend\studyhub.db'
    [IO.File]::WriteAllText($localDB, 'FixtureSecretOpaqueLocalAccounts')
    [IO.File]::WriteAllText($productionDB, 'FixtureSecretOpaqueProductionAccounts')
    $script:answers.Enqueue('2')
    $selected = Get-QStudyNativeDataset $both
    Assert-NativeLauncher ($selected.source -ceq 'deployment' -and $script:promptCount -eq 1) 'different databases require a one-time explicit choice'
    $repeat = Get-QStudyNativeDataset $both
    Assert-NativeLauncher ($repeat.source -ceq 'deployment' -and $script:promptCount -eq 1) 'all subsequent modes reuse the same persisted selection without another question'
    Assert-NativeLauncher ([IO.File]::ReadAllText($localDB) -ceq 'FixtureSecretOpaqueLocalAccounts' -and [IO.File]::ReadAllText($productionDB) -ceq 'FixtureSecretOpaqueProductionAccounts') 'choosing a database never merges, copies, deletes or overwrites either database'
    Remove-Item -LiteralPath $productionDB -Force
    Assert-NativeLauncherThrows { Get-QStudyNativeDataset $both } 'missing selected production database blocks empty or alternate database fallback'
    Assert-NativeLauncher ([IO.File]::ReadAllText($localDB) -ceq 'FixtureSecretOpaqueLocalAccounts' -and -not (Test-Path -LiteralPath $productionDB)) 'failed selection cannot recreate a selected database or replace the local one'

    $cancelled = New-NativeFixture 'cancelled'
    foreach ($relative in @('backend\studyhub.db','deployment\data\backend\studyhub.db')) { [IO.File]::WriteAllText((Join-Path $cancelled $relative), $relative) }
    $script:answers.Enqueue('0')
    Assert-NativeLauncherThrows { Get-QStudyNativeDataset $cancelled } 'cancelling ambiguous data selection stops instead of creating a new account store'
    Assert-NativeLauncher (-not (Test-Path -LiteralPath (Join-Path $cancelled '.local\launcher\data-choice.json'))) 'cancelled choice is not saved as a default'

    $same = New-NativeFixture 'both-identical'
    foreach ($relative in @('backend\studyhub.db','deployment\data\backend\studyhub.db')) { [IO.File]::WriteAllText((Join-Path $same $relative), 'FixtureSecretSameOpaqueAccounts') }
    $beforePrompts = $script:promptCount
    Assert-NativeLauncher ((Get-QStudyNativeDataset $same).source -ceq 'local' -and $script:promptCount -eq $beforePrompts) 'identical copies can use the preferred local store without an ambiguous choice'
    $wal = New-NativeFixture 'same-main-different-wal'
    foreach ($relative in @('backend\studyhub.db','deployment\data\backend\studyhub.db')) { [IO.File]::WriteAllText((Join-Path $wal $relative), 'FixtureSecretSameOpaqueMainFile') }
    [IO.File]::WriteAllText((Join-Path $wal 'backend\studyhub.db-wal'), 'FixtureSecretUncheckpointedAccounts')
    $script:answers.Enqueue('1')
    $previousPrompts = $script:promptCount
    Assert-NativeLauncher ((Get-QStudyNativeDataset $wal).source -ceq 'local' -and $script:promptCount -eq ($previousPrompts + 1)) 'identical main files with uncheckpointed SQLite data still require an explicit choice'
    $choicePath = Join-Path $same '.local\launcher\data-choice.json'
    [IO.File]::WriteAllText($choicePath, '{"source":"unknown"}')
    Assert-NativeLauncherThrows { Get-QStudyNativeDataset $same } 'unknown stored selection never silently falls back'

    $build = New-NativeFixture 'fingerprint'
    [IO.File]::WriteAllText((Join-Path $build 'frontend\app\page.tsx'), 'fixture-source-one')
    $firstHash = Get-QStudyNativeBuildHash $build
    [IO.File]::WriteAllText((Join-Path $build 'backend\.env'), 'FixtureSecretDoesNotAffectBuild')
    Assert-NativeLauncher ((Get-QStudyNativeBuildHash $build) -ceq $firstHash) 'private settings are excluded from production build fingerprints'
    [IO.File]::WriteAllText((Join-Path $build 'frontend\app\page.tsx'), 'fixture-source-two')
    Assert-NativeLauncher ((Get-QStudyNativeBuildHash $build) -cne $firstHash) 'changed frontend source invalidates the production build cache'

    $statePath = Join-Path $fresh '.local\launcher\state.json'
    Write-QStudyInstallJson $statePath @{ version = 3; root = 'C:\foreign-checkout'; owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; computer = (Get-QStudyComputerFingerprint) }
    Assert-NativeLauncher ($null -eq (Read-QStudyNativeState $fresh)) 'copied state from another checkout cannot authorize process termination'
    Write-QStudyInstallJson $statePath @{ version = 3; root = $fresh; owner_sid = 'S-1-5-21-111-222-333-9999'; computer = (Get-QStudyComputerFingerprint) }
    Assert-NativeLauncher ($null -eq (Read-QStudyNativeState $fresh)) 'another Windows user cannot authorize process termination with copied state'
    foreach ($name in @('Install-QStudy.cmd','Start-QStudy.cmd','Start-QStudy-LAN.cmd','Start-QStudy-Internet.cmd')) {
        $text = [IO.File]::ReadAllText((Join-Path $workspace $name))
        Assert-NativeLauncher ($text -match 'scripts\\Start-QStudy\.ps1' -and $text -notmatch 'production|docker') ($name + ' delegates to the same native launcher')
    }
    $acl = (Get-Item -LiteralPath (Join-Path $fresh '.local\managed')).GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544')
    Assert-NativeLauncher ($acl.AreAccessRulesProtected -and @($acl.Access | Where-Object { $_.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow -and $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed }).Count -eq 0) 'managed control and credential exports inherit private Windows access'
    New-Item -ItemType Junction -Path $junction -Target $fresh | Out-Null
    Assert-NativeLauncherThrows { Assert-QStudyNativePath $junction (Join-Path $junction 'backend\studyhub.db') } 'junctions cannot redirect the native data selection to another location'
    Write-Host ('QStudy native launcher: ' + $checks + ' assertions passed.')
} finally {
    if (Test-Path -LiteralPath $junction) {
        $resolvedJunction = [IO.Path]::GetFullPath($junction)
        if (-not $resolvedJunction.StartsWith([IO.Path]::GetFullPath($fixture) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing junction cleanup outside fixture.' }
        if ((Get-Item -LiteralPath $resolvedJunction -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { [IO.Directory]::Delete($resolvedJunction, $false) }
    }
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($prefix) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside fixture.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
