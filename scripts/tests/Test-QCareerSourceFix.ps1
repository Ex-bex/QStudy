# Windows PowerShell 5.1 fixtures: no application, database service, or network is started.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $workspace 'scripts\launcher\Native.ps1')
. (Join-Path $workspace 'scripts\maintenance\Apply-QCareerFix.ps1') -Library
$prefix = Join-Path $workspace '.local\career-source-fix-tests'
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
    Write-FixtureFile (Join-Path $package 'manifest.json') (@{ version = 1; id = 'qcareer-fix-fixture'; target_mode = 'internet'; files = @($Files) } | ConvertTo-Json -Depth 5)
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
    $builder = [IO.File]::ReadAllText((Join-Path $workspace 'scripts/maintenance/Build-CareerFix.py'))
    $payloadBlock = [regex]::Match($builder, '(?ms)^PAYLOAD = \(\r?\n(?<paths>.*?)^\)')
    Assert-Fix $payloadBlock.Success 'source updater builder declares an explicit payload'
    $paths = @([regex]::Matches($payloadBlock.Groups['paths'].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    Assert-Fix ($paths.Count -le 256 -and @($paths | Select-Object -Unique).Count -eq $paths.Count) 'reviewed source count fits the preserving helper and has no duplicate paths'
    $helperBytes = [IO.File]::ReadAllBytes((Join-Path $workspace 'scripts/maintenance/Apply-QCareerFix.ps1'))
    Assert-Fix ($helperBytes.Length -gt 3 -and $helperBytes[0] -eq 239 -and $helperBytes[1] -eq 187 -and $helperBytes[2] -eq 191) 'Windows PowerShell helper keeps a UTF-8 BOM for Russian messages'
    $helperText = [Text.Encoding]::UTF8.GetString($helperBytes)
    Assert-Fix (-not [regex]::IsMatch($helperText, '(?<!\r)\n')) 'distributed Windows helper has CRLF line endings'
    foreach ($required in @('frontend/lib/game-csp.mjs', 'frontend/lib/lumaball/engine.ts', 'frontend/lib/lumaball/room-state.ts', 'frontend/next.config.ts',
        'frontend/package.json', 'frontend/package-lock.json', 'frontend/tsconfig.json', 'frontend/components/lumaball/map-settings.tsx', 'frontend/components/lumaball/map-settings.module.css', 'frontend/components/lumaball/room-settings.tsx', 'frontend/components/lumaball/admin-panel.tsx', 'frontend/lib/lumaball/maps.ts', 'frontend/lib/lumaball/types.ts', 'frontend/types/lumaball.ts', 'frontend/lib/lumaball-maps.test.mjs', 'backend/app/lumaball_room_models.py', 'backend/app/main.py', 'backend/app/routers/lumaball_rooms.py', 'backend/app/services/lumaball_identity.py', 'backend/app/services/lumaball_rooms.py', 'backend/app/services/lumaball_realtime.py')) {
        Assert-Fix ($paths -ccontains $required) ('complete original physics, map migration and runtime dependency included: ' + $required)
    }
    foreach ($required in @(
        'README.md',
        'docs/qcareer-api.md',
        'docs/qcareer.md',
        'docs/accounts.md',
        'backend/app/routers/auth_routes.py',
        'backend/app/routers/academic.py',
        'backend/tests/test_registration_groups.py',
        'backend/tests/test_security.py',
        'backend/tests/smoke_bff.py',
        'frontend/components/auth-form.tsx',
        'frontend/components/identity-shell.tsx',
        'frontend/components/identity.module.css',
        'frontend/lib/identity-brand.ts',
        'frontend/public/brand/qid-placeholder.svg',
        'frontend/components/recovery-form.tsx',
        'frontend/app/login/page.tsx',
        'frontend/app/register/page.tsx',
        'frontend/app/forgot-password/page.tsx',
        'frontend/app/reset-password/page.tsx',
        'docs/host-update.md',
        'frontend/app/dashboard/modules/page.tsx',
        'frontend/app/dashboard/syllabi/page.tsx',
        'frontend/app/dashboard/profile/page.tsx',
        'backend/app/career_models.py',
        'backend/app/routers/career.py',
        'backend/app/services/career.py',
        'backend/app/routers/branding.py',
        'backend/app/services/branding.py',
        'backend/tests/test_branding.py',
        'backend/tests/test_career.py',
        'frontend/app/dashboard/admin/page.tsx',
        'frontend/app/dashboard/layout.tsx',
        'frontend/app/dashboard/tests/page.tsx',
        'frontend/app/design.css',
        'frontend/app/developers/page.tsx',
        'frontend/app/page.tsx',
        'frontend/components/academic.tsx',
        'frontend/components/branding-provider.tsx',
        'frontend/lib/auth-return.test.mjs',
        'frontend/lib/auth-return.ts',
        'frontend/lib/auth.tsx',
        'frontend/lib/assessment-link.test.mjs',
        'frontend/lib/assessment-link.ts',
        'frontend/lib/career.test.mjs',
        'frontend/lib/career.ts',
        'frontend/public/brand/qcareer-placeholder.svg',
        'frontend/public/brand/qforcelogo_qcareer.png',
        'assets/brand/source/qforcelogo_qcareer.png',
        'frontend/types/career.ts',
        'scripts/tests/career_stack.py',
        'frontend/app/qcareer/layout.tsx',
        'frontend/app/qcareer/page.tsx',
        'frontend/app/qcareer/workspace/page.tsx',
        'frontend/app/dashboard/admin/career/page.tsx',
        'frontend/components/career/workspace.tsx',
        'frontend/components/career/shell.tsx',
        'frontend/components/career/nav-link.tsx',
        'frontend/components/career/nav-link.module.css',
        'frontend/components/career/context.tsx',
        'frontend/components/career/career.module.css',
        'frontend/components/career/brand.tsx',
        'frontend/components/career/admin.module.css',
        'frontend/components/career/admin-panel.tsx'
    )) { Assert-Fix ($paths -ccontains $required) ('QCareer/shared runtime dependency included: ' + $required) }
    foreach ($required in @(
        'frontend/app/qcontrol/layout.tsx',
        'frontend/app/qcontrol/page.tsx',
        'frontend/app/qcontrol/accounts/page.tsx',
        'frontend/app/qcontrol/branding/page.tsx',
        'frontend/app/qcontrol/operations/page.tsx',
        'frontend/app/qcontrol/qball/page.tsx',
        'frontend/app/qcontrol/qcareer/page.tsx',
        'frontend/app/qcontrol/qstudy/page.tsx',
        'frontend/app/qcontrol/qstudy/study.module.css',
        'frontend/app/qcontrol/system/page.tsx',
        'frontend/app/qcontrol/qstudy/groups/page.tsx',
        'frontend/app/qcontrol/qstudy/modules/page.tsx',
        'frontend/app/qcontrol/qstudy/subjects/page.tsx',
        'frontend/app/qcontrol/qstudy/syllabi/page.tsx',
        'frontend/app/qcontrol/qstudy/groups/[groupId]/page.tsx',
        'frontend/app/qcontrol/qstudy/groups/[groupId]/courses/[courseId]/page.tsx',
        'frontend/components/control/accounts.tsx',
        'frontend/components/control/control.module.css',
        'frontend/components/control/ecosystem-branding-admin.tsx',
        'frontend/components/control/operations.module.css',
        'frontend/components/control/OperationsPanel.tsx',
        'frontend/components/control/ServerSettingsForm.tsx',
        'frontend/components/control/shell.tsx',
        'frontend/components/control/system.module.css',
        'frontend/components/control/SystemPanel.tsx',
        'frontend/lib/control-session.ts',
        'frontend/lib/ecosystem-branding.ts',
        'frontend/lib/ecosystem-branding.test.mjs',
        'frontend/lib/study-management.ts',
        'frontend/lib/study-routing.ts',
        'frontend/lib/study-routing.test.mjs',
        'frontend/components/ecosystem-branding.tsx',
        'frontend/components/branding-admin.tsx',
        'assets/brand/source/qforcelogo_q-id.png',
        'assets/brand/source/qforcelogo_qcontrol.png',
        'frontend/public/brand/qforcelogo_q-id.png',
        'frontend/public/brand/qforcelogo_qcontrol.png',
        'docs/qcontrol.md',
        'frontend/app/dashboard/admin/qball/page.tsx',
        'frontend/app/dashboard/groups/[groupId]/courses/[courseId]/page.tsx',
        'frontend/app/dashboard/groups/[groupId]/page.tsx',
        'frontend/app/dashboard/groups/page.tsx',
        'frontend/app/dashboard/subjects/page.tsx',
        'frontend/components/syllabus-document.tsx',
        'frontend/components/work-card.tsx',
        'frontend/lib/branding.ts'
    )) { Assert-Fix ($paths -ccontains $required) ('QControl ecosystem runtime dependency included: ' + $required) }
    foreach ($required in @(
        'backend/app/qtests_models.py',
        'backend/app/routers/admin.py',
        'backend/app/routers/qtests.py',
        'backend/app/services/qtests_import.py',
        'backend/tests/test_qtests.py',
        'backend/tests/test_qtests_import.py',
        'docs/qtests.md',
        'frontend/app/dashboard/jobs/page.tsx',
        'frontend/app/qcontrol/qtests/page.tsx',
        'frontend/app/qtests/attempts/[id]/page.tsx',
        'frontend/app/qtests/banks/[id]/page.tsx',
        'frontend/app/qtests/layout.tsx',
        'frontend/app/qtests/library/page.tsx',
        'frontend/app/qtests/page.tsx',
        'frontend/components/qtests-brand.tsx',
        'frontend/components/qtests/attempt.tsx',
        'frontend/components/qtests/bank.tsx',
        'frontend/components/qtests/library.tsx',
        'frontend/components/qtests/qtests.module.css',
        'frontend/components/qtests/question-editor.tsx',
        'frontend/components/qtests/shell.tsx',
        'frontend/components/qtests/workspace-frame.tsx',
        'frontend/lib/qtests.ts',
        'frontend/public/brand/qtests-prototype.svg',
        'scripts/tests/qtests_stack.py'
    )) { Assert-Fix ($paths -ccontains $required) ('QTests runtime dependency included: ' + $required) }
    foreach ($required in @(
        'backend/tests/test_qtests_lessons.py',
        'frontend/components/control/qtests-lessons.tsx'
    )) { Assert-Fix ($paths -ccontains $required) ('Saved QTests lessons dependency included: ' + $required) }
    $allowedBlock = [regex]::Match($helperText, '(?ms)^    \$allowed = @\(\r?\n(?<paths>.*?)^    \)')
    Assert-Fix $allowedBlock.Success 'preserving helper declares its exact reviewed path allowlist'
    $allowedPaths = @([regex]::Matches($allowedBlock.Groups['paths'].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    Assert-Fix ($allowedPaths.Count -eq $paths.Count -and @($allowedPaths | Where-Object { $paths -cnotcontains $_ }).Count -eq 0) 'builder and helper have the same exact reviewed paths without broader write access'
    $entries = @()
    foreach ($relative in $paths) {
        $source = Join-Path $package ('payload/' + $relative)
        Write-FixtureFile $source ('updated fixture source for ' + $relative)
        $entries += @{ path = $relative; sha256 = (Get-FileHash -LiteralPath $source).Hash.ToLowerInvariant() }
    }
    Write-FixManifest $entries
    $plan = Get-QCareerFixFiles $fixture $package
    Assert-Fix ($plan.files.Count -eq $paths.Count) 'all exact QCareer integration paths pass SHA256 validation, including shared auth, curriculum links, branding and original physics'
    foreach ($relative in @('backend/.env', 'frontend/.env', 'frontend/lib/../../backend/secret.ts', 'frontend/node_modules/file.ts', 'frontend/.next/file.ts', 'frontend/lib/../secret.ts', 'frontend/lib//alias.ts', 'frontend/lib/escape.db', 'C:/outside.ts', 'scripts/launcher/control.py', 'scripts/launcher/data.py.bak', 'backend/app/config.py', 'backend/app/auth.py', 'backend/app/services/lumaball_realtime.py.bak', 'backend/app/services/academic_service.py', 'backend/app/routers/auth.py', 'backend/tests/test_auth.py', 'frontend/lib/unreviewed.ts', 'frontend/package.json.bak', 'frontend/package-lock.json/extra.ts')) {
        Write-FixManifest @(@{ path = $relative; sha256 = ('a' * 64) })
        Assert-FixThrows { Get-QCareerFixFiles $fixture $package } ('reject private/generated/traversal path: ' + $relative)
    }
    Write-FixManifest @($entries[0], @{ path = $entries[0].path; sha256 = $entries[0].sha256 })
    Assert-FixThrows { Get-QCareerFixFiles $fixture $package } 'case-insensitive duplicate targets are rejected on Windows'
    Write-FixManifest @(@{ path = $paths[0]; sha256 = ('0' * 64) })
    Assert-FixThrows { Get-QCareerFixFiles $fixture $package } 'tampered payload is rejected before any stop or source write'
    Write-FixManifest @(@{ path = $paths[0].ToUpperInvariant(); sha256 = $entries[0].sha256 })
    Assert-FixThrows { Get-QCareerFixFiles $fixture $package } 'case-aliased paths cannot bypass the exact reviewed allowlist'
    $oversizeSource = Join-Path $package ('payload/' + $paths[0])
    $originalPayload = [IO.File]::ReadAllBytes($oversizeSource)
    [IO.File]::WriteAllBytes($oversizeSource, [byte[]]::new((4MB + 1)))
    Write-FixManifest @(@{ path = $paths[0]; sha256 = (Get-FileHash -LiteralPath $oversizeSource).Hash.ToLowerInvariant() })
    Assert-FixThrows { Get-QCareerFixFiles $fixture $package } 'a hash-correct source larger than four MiB is still rejected'
    [IO.File]::WriteAllBytes($oversizeSource, $originalPayload)
    Write-FixManifest $entries
    $junction = Join-Path $fixture 'frontend/lib/linked'
    New-Item -ItemType Junction -Path $junction -Value (Join-Path $fixture 'backend') | Out-Null
    Assert-FixThrows { Resolve-QCareerFixPath $fixture 'frontend/lib/linked/secret.ts' } 'junction ancestors cannot redirect source writes'
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
    Copy-Item -LiteralPath (Join-Path $workspace 'scripts/maintenance/Apply-QCareerFix.ps1') -Destination (Join-Path $package 'Apply.ps1')
    $state = @{ version = 3; root = $fixture; computer = (Get-QStudyComputerFingerprint); owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; mode = 'internet'; instance = ('1' * 32); supervisor = @{ identity = @{ marker = 'fixture' } }; frontend = $null; backend = $null }
    Write-QStudyInstallJson (Join-Path $fixture '.local/launcher/state.json') $state
    Write-FixtureFile (Join-Path $fixture '.local/owned.fixture') 'fixture marker only'
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    & $powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $package 'Apply.ps1') -Root $fixture -Mode local -NoPause
    Assert-Fix ($LASTEXITCODE -eq 0) 'packaged helper updates source and invokes stub startup successfully'
    Assert-Fix (Test-Path -LiteralPath (Join-Path $fixture '.local/stop-called.fixture')) 'the owned runtime is stopped through the separate bundled entry'
    Assert-Fix ([IO.File]::ReadAllText((Join-Path $fixture '.local/start-called.fixture')) -ceq 'local') 'explicit local fixture mode is forwarded after releasing launcher.lock'
    $backups = @(Get-ChildItem -LiteralPath (Join-Path $fixture '.local/source-updates') -Directory)
    Assert-Fix ($backups.Count -eq 1 -and [IO.File]::ReadAllText((Join-Path $backups[0].FullName 'frontend/lib/game-csp.mjs')) -ceq 'original source') 'private backup retains original changed source bytes'
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
    Assert-Fix ((Get-FileHash -LiteralPath $database).Hash -ceq $databaseHash -and (Get-FileHash -LiteralPath $dotenv).Hash -ceq $dotenvHash) 'private database and environment also remain unchanged after reruns and rejected ownership checks'
    Write-Host ('QCareer source-only integration: ' + $checks + ' assertions passed.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($prefix) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the source-fix fixture.' }
    $remainingJunction = Join-Path $resolved 'frontend/lib/linked'
    if (Test-Path -LiteralPath $remainingJunction) { [IO.Directory]::Delete($remainingJunction) }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
