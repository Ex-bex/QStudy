# Windows PowerShell 5.1 fixtures: no application, database service, or network is started.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $workspace 'scripts\launcher\Native.ps1')
. (Join-Path $workspace 'scripts\maintenance\Apply-QBallFix.ps1') -Library
$prefix = Join-Path $workspace '.local\source-fix-tests'
$fixture = Join-Path $prefix ([Guid]::NewGuid().ToString('N'))
$package = Join-Path $fixture '.qstudy-fix'
$checks = 0
function Assert-Fix([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }; $script:checks++
}
function Assert-FixThrows([scriptblock]$Operation, [string]$Message) {
    $failed = $false; try { & $Operation | Out-Null } catch { $failed = $true }
    Assert-Fix $failed $Message
}
function Write-FixtureFile([string]$Path, [string]$Text) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($true))
}
function Write-FixManifest($Files) {
    Write-FixtureFile (Join-Path $package 'manifest.json') (@{ version = 1; id = 'qball-fix-fixture'; target_mode = 'internet'; files = @($Files) } | ConvertTo-Json -Depth 5)
}
try {
    foreach ($name in @('frontend/lib', 'backend', 'scripts', '.qstudy-fix/payload/frontend/lib', '.qstudy-fix/stop/scripts/launcher')) {
        [IO.Directory]::CreateDirectory((Join-Path $fixture $name)) | Out-Null
    }
    Initialize-QStudyNativeStorage $fixture
    $old = Join-Path $fixture 'frontend/lib/game-csp.mjs'
    $database = Join-Path $fixture 'backend/studyhub.db'; $dotenv = Join-Path $fixture 'backend/.env'
    Write-FixtureFile $old 'original source'
    Write-FixtureFile $database 'PRIVATE_FIXTURE_ACCOUNTS'; Write-FixtureFile $dotenv 'PRIVATE_FIXTURE_SETTINGS'
    $databaseHash = (Get-FileHash -LiteralPath $database).Hash; $dotenvHash = (Get-FileHash -LiteralPath $dotenv).Hash
    $paths = @('frontend/lib/game-csp.mjs', 'frontend/lib/lumaball/session-queue.ts', 'scripts/launcher/data.py')
    $entries = @()
    foreach ($relative in $paths) {
        $source = Join-Path $package ('payload/' + $relative)
        Write-FixtureFile $source ('updated fixture source for ' + $relative)
        $entries += @{ path = $relative; sha256 = (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() }
    }
    Write-FixManifest $entries
    $plan = Get-QBallFixFiles $fixture $package
    Assert-Fix ($plan.files.Count -eq 3) 'valid frontend entries and the exact launcher data helper pass SHA256 validation'
    foreach ($relative in @('backend/.env', 'frontend/.env', 'frontend/lib/../../backend/secret.ts', 'frontend/node_modules/file.ts', 'frontend/.next/file.ts', 'frontend/lib/../secret.ts', 'frontend/lib//alias.ts', 'frontend/lib/escape.db', 'C:/outside.ts', 'scripts/launcher/control.py', 'scripts/launcher/data.py.bak')) {
        Write-FixManifest @(@{ path = $relative; sha256 = ('a' * 64) })
        Assert-FixThrows { Get-QBallFixFiles $fixture $package } ('reject private/generated/traversal path: ' + $relative)
    }
    Write-FixManifest @($entries[0], @{ path = 'frontend/lib/GAME-csp.mjs'; sha256 = $entries[0].sha256 })
    Assert-FixThrows { Get-QBallFixFiles $fixture $package } 'case-insensitive duplicate targets are rejected on Windows'
    Write-FixManifest @(@{ path = $paths[0]; sha256 = ('0' * 64) })
    Assert-FixThrows { Get-QBallFixFiles $fixture $package } 'tampered payload is rejected before any stop or source write'
    Write-FixManifest $entries
    $junction = Join-Path $fixture 'frontend/lib/linked'
    New-Item -ItemType Junction -Path $junction -Value (Join-Path $fixture 'backend') | Out-Null
    Assert-FixThrows { Resolve-QBallFixPath $fixture 'frontend/lib/linked/secret.ts' } 'junction ancestors cannot redirect source writes'
    [IO.Directory]::Delete($junction)
    Assert-Fix (-not (Test-Path -LiteralPath (Join-Path $fixture '.local/source-updates'))) 'validation does not create backups or start runtime'

    # Only process ownership lookup is stubbed: actual owner/v3/fingerprint/path
    # validation, the lock, private backup, and atomic replacements remain real.
    $nativeSource = (Join-Path $workspace 'scripts/launcher/Native.ps1').Replace("'", "''")
    Write-FixtureFile (Join-Path $package 'stop/scripts/launcher/Native.ps1') @"
. '$nativeSource'
function Get-QStudyOwnedProcess(`$Identity) {
    if (`$null -ne `$Identity -and (Test-Path -LiteralPath (Join-Path `$script:QStudyRoot '.local/owned.fixture'))) { return [pscustomobject]@{ ExecutablePath = 'fixture-only-never-executed.exe' } }
    return `$null
}
function Get-QStudyProcess([int]`$ProcessId) {
    if (`$ProcessId -eq 987654) { return [pscustomobject]@{ ExecutablePath = 'unrelated-reused-fixture-pid.exe' } }
    return `$null
}
"@
    Write-FixtureFile (Join-Path $package 'stop/scripts/launcher/Stop-Previous.ps1') @'
param([string]$Root, [switch]$NoPause)
$flag = Join-Path $Root '.local/owned.fixture'
if (-not (Test-Path -LiteralPath $flag)) { exit 9 }
Remove-Item -LiteralPath $flag -Force
[IO.File]::WriteAllText((Join-Path $Root '.local/stop-called.fixture'), 'owned fixture stopped')
exit 0
'@
    Write-FixtureFile (Join-Path $fixture 'scripts/Start-QStudy.ps1') @'
param([string]$Mode, [switch]$NoBrowser, [switch]$NoPause)
try {
    $handle = [IO.File]::Open((Join-Path $PSScriptRoot '../.local/launcher.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    $handle.Dispose()
    [IO.File]::WriteAllText((Join-Path $PSScriptRoot '../.local/start-called.fixture'), $Mode)
    exit 0
} catch { exit 8 }
'@
    Copy-Item -LiteralPath (Join-Path $workspace 'scripts/maintenance/Apply-QBallFix.ps1') -Destination (Join-Path $package 'Apply.ps1')
    $state = @{ version = 3; root = $fixture; computer = (Get-QStudyComputerFingerprint); owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; mode = 'internet'; instance = ('1' * 32); supervisor = @{ identity = @{ marker = 'fixture' } }; frontend = $null; backend = $null }
    Write-QStudyInstallJson (Join-Path $fixture '.local/launcher/state.json') $state
    Write-FixtureFile (Join-Path $fixture '.local/owned.fixture') 'fixture marker only'
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'Apply.ps1') -Root $fixture -Mode local -NoPause
    Assert-Fix ($LASTEXITCODE -eq 0) 'packaged helper updates source and invokes stub startup successfully'
    Assert-Fix (Test-Path -LiteralPath (Join-Path $fixture '.local/stop-called.fixture')) 'the owned runtime is stopped through the separate bundled entry'
    Assert-Fix ([IO.File]::ReadAllText((Join-Path $fixture '.local/start-called.fixture')) -ceq 'local') 'explicit local fixture mode is forwarded after releasing launcher.lock'
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $fixture '.local/source-updates') -Directory)
    Assert-Fix ($backups.Count -eq 1 -and [IO.File]::ReadAllText((Join-Path $backups[0].FullName $paths[0])) -ceq 'original source') 'private backup retains original changed source bytes'
    foreach ($entry in $entries) { Assert-Fix ((Get-FileHash -LiteralPath (Join-Path $fixture $entry.path)).Hash.ToLowerInvariant() -ceq $entry.sha256) 'existing and newly created sources match the manifest' }
    Assert-Fix ((Get-FileHash -LiteralPath $database).Hash -ceq $databaseHash -and (Get-FileHash -LiteralPath $dotenv).Hash -ceq $dotenvHash) 'existing database and private environment remain byte-for-byte unchanged'
    Write-QStudyInstallJson (Join-Path $fixture '.local/managed/status.json') @{ state = 'stopped'; root_owner = $fixture; instance = $state.instance; backend_pid = 987654; frontend_pid = 987654 }
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'Apply.ps1') -Root $fixture -NoPause
    Assert-Fix ($LASTEXITCODE -eq 0 -and [IO.File]::ReadAllText((Join-Path $fixture '.local/start-called.fixture')) -ceq 'internet') 'already-stopped rerun preserves the validated previous internet mode'
    $legacyPath = Join-Path $fixture '.local/processes.json'
    Write-QStudyInstallJson $legacyPath @{ version = 2; workspace = $fixture; computer = (Get-QStudyComputerFingerprint); frontend = @{ identity = @{ marker = 'old-frontend' } }; backend = $null }
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'Apply.ps1') -Root $fixture -NoPause
    Assert-Fix ($LASTEXITCODE -ne 0) 'legacy process records cause a safe refusal before source replacement'
    Remove-Item -LiteralPath $legacyPath -Force
    $state.owner_sid = 'S-1-5-21-111-222-333-9999'
    Write-QStudyInstallJson (Join-Path $fixture '.local/launcher/state.json') $state
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'Apply.ps1') -Root $fixture -NoPause
    Assert-Fix ($LASTEXITCODE -ne 0) 'another Windows account runtime fails closed without touching its processes'
    Write-Host ('QBall source-only fix: ' + $checks + ' assertions passed.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($prefix) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the source-fix fixture.' }
    $remainingJunction = Join-Path $resolved 'frontend/lib/linked'
    if (Test-Path -LiteralPath $remainingJunction) { [IO.Directory]::Delete($remainingJunction) }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
