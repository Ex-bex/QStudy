param([string]$Root = '', [ValidateSet('local', 'lan', 'internet')][string]$Mode, [switch]$NoPause, [switch]$Library)
# Distributed as .qstudy-fix/Apply.ps1. Source-only update: never import a ZIP or copy private data.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-QBallFixPath([string]$Base, [string]$Relative = '') {
    $basePath = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
    if ($Relative -match '(^|[/\\])\.\.([/\\]|$)|:|[\x00-\x1f]' -or [IO.Path]::IsPathRooted($Relative)) { throw 'Недопустимый путь в пакете исправления.' }
    $candidate = if ($Relative) { [IO.Path]::GetFullPath((Join-Path $basePath $Relative)) } else { $basePath }
    if ($candidate -cne $basePath -and -not $candidate.StartsWith($basePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Путь исправления выходит за пределы проекта.' }
    $current = $candidate
    while ($current.Length -ge $basePath.Length) {
        if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Ссылки и junction в путях исправления запрещены.' }
        if ([string]::Equals($current, $basePath, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
    }
    return $candidate
}

function Get-QBallFixFiles([string]$Root, [string]$Package) {
    $manifestPath = Resolve-QBallFixPath $Package 'manifest.json'
    $manifest = [IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ($manifest.version -ne 1 -or $manifest.id -cnotmatch '^[a-z0-9][a-z0-9-]{1,70}$' -or $manifest.target_mode -cnotin @('local', 'lan', 'internet')) { throw 'Неизвестный формат пакета исправления.' }
    # Keep the preserving updater restricted to the exact reviewed QBall source payload.
    $allowed = @(
        'frontend/package.json',
        'frontend/package-lock.json',
        'frontend/tsconfig.json',
        'frontend/app/api/[...path]/route.ts',
        'frontend/app/qball/qball.css',
        'frontend/components/lumaball/brand.tsx',
        'frontend/components/lumaball/context.tsx',
        'frontend/components/lumaball/admin-panel.tsx',
        'frontend/components/lumaball/game-room.module.css',
        'frontend/components/lumaball/game-room.tsx',
        'frontend/components/lumaball/lobby.tsx',
        'frontend/components/lumaball/map-settings.tsx',
        'frontend/components/lumaball/map-settings.module.css',
        'frontend/components/lumaball/room-settings.tsx',
        'frontend/components/lumaball/original-lobby.css',
        'frontend/components/lumaball/shell.tsx',
        'frontend/lib/lumaball/engine.ts',
        'frontend/lib/lumaball/maps.ts',
        'frontend/lib/lumaball/types.ts',
        'frontend/types/lumaball.ts',
        'frontend/lib/lumaball/room-state.ts',
        'frontend/lib/lumaball/render.ts',
        'frontend/lib/lumaball/snapshot-interpolator.ts',
        'frontend/lib/lumaball-snapshots.test.mjs',
        'frontend/lib/lumaball-render.test.mjs',
        'frontend/lib/lumaball.test.mjs',
        'frontend/lib/lumaball-maps.test.mjs',
        'frontend/lib/lumaball-parity.test.mjs',
        'frontend/lib/lumaball-room-state.test.mjs',
        'frontend/lib/fixtures/lumaball-original/provenance.json',
        'frontend/lib/fixtures/lumaball-original/utils-game.ts.txt',
        'frontend/lib/fixtures/lumaball-original/utils-player.ts.txt',
        'frontend/lib/fixtures/lumaball-original/utils-map.ts.txt',
        'frontend/lib/fixtures/lumaball-original/utils-config_game.ts.txt',
        'frontend/lib/fixtures/lumaball-original/utils-timer.ts.txt',
        'frontend/lib/fixtures/lumaball-original/utils-utils.ts.txt',
        'frontend/lib/fixtures/lumaball-original/types-player.ts.txt',
        'frontend/lib/game-csp.mjs',
        'frontend/lib/game-csp.test.mjs',
        'frontend/lib/lumaball/session-queue.ts',
        'frontend/lib/lumaball-session.test.mjs',
        'frontend/lib/native-server.integration.mjs',
        'frontend/server.mjs',
        'scripts/launcher/data.py',
        'scripts/tests/qball_physics_fixture.mjs',
        'scripts/tests/lumaball_stack.py',
        'backend/app/lumaball_room_models.py',
        'backend/app/main.py',
        'backend/app/routers/lumaball_rooms.py',
        'backend/app/services/lumaball_identity.py',
        'backend/app/services/lumaball_rooms.py',
        'backend/app/services/lumaball_realtime.py',
        'backend/tests/test_lumaball_identity.py',
        'backend/tests/test_lumaball_realtime.py',
        'backend/tests/test_lumaball_relay_performance.py',
        'backend/tests/test_lumaball_rooms.py'
    )
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $files = @(); $size = 0
    foreach ($entry in @($manifest.files)) {
        $relative = [string]$entry.path
        if ($relative.Contains('\') -or $relative.Contains('//') -or $relative -match '(^|/)(\.|\.env[^/]*|\.next|node_modules|uploads|\.git|\.local)(/|$)' -or
            $allowed -cnotcontains $relative -or
            [string]$entry.sha256 -cnotmatch '^[a-f0-9]{64}$' -or -not $seen.Add($relative)) { throw 'Пакет содержит запрещённый или повторный путь. Допускаются только проверенные исходники QBall, закреплённые зависимости, миграция карт и тесты оригинальной физики.' }
        $source = Resolve-QBallFixPath $Package ('payload/' + $relative)
        $target = Resolve-QBallFixPath $Root $relative
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw 'В пакете отсутствует исходник.' }
        $length = (Get-Item -LiteralPath $source).Length; $size += $length
        if ($length -gt 4MB -or $size -gt 32MB -or (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.sha256) { throw 'Проверка SHA256 или размера исходников не пройдена.' }
        if ((Test-Path -LiteralPath $target) -and -not (Test-Path -LiteralPath $target -PathType Leaf)) { throw 'На месте исходника находится каталог.' }
        $files += [pscustomobject]@{ path = $relative; source = $source; target = $target; sha256 = $entry.sha256 }
    }
    if ($files.Count -lt 1 -or $files.Count -gt 128) { throw 'Пакет должен содержать от 1 до 128 исходников.' }
    return [pscustomobject]@{ manifest = $manifest; files = $files }
}

function Assert-QBallNoLegacyRuntime([string]$Root) {
    $path = Resolve-QBallFixPath $Root '.local/processes.json'
    if (-not (Test-Path -LiteralPath $path)) { return }
    $legacy = Read-QStudyInstallJson $path
    if ($null -eq $legacy -or $legacy.version -notin @(1, 2) -or -not [string]::Equals($legacy.workspace, $Root, [StringComparison]::OrdinalIgnoreCase) -or ($legacy.version -eq 2 -and $legacy.computer -cne (Get-QStudyComputerFingerprint))) { throw 'Прежнее состояние запуска не подтверждено. Исходники не заменялись.' }
    foreach ($name in @('frontend', 'backend')) {
        if ($null -ne (Get-QStudyInstallProperty $legacy $name)) { throw 'Обнаружены записи прежнего локального запуска. Остановите его штатно перед исправлением.' }
    }
}

if ($Library) { return }
$lock = $null; $backup = ''; $failed = $false; $pending = ''; $stage = 'проверка пакета'
try {
    if (-not $Root) { throw 'Укажите корень существующего QStudy.' }
    $Root = Resolve-QBallFixPath $Root
    $package = Resolve-QBallFixPath $Root '.qstudy-fix'
    if (-not [string]::Equals($package, $PSScriptRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'Распакуйте пакет исправления прямо в существующую папку QStudy.' }
    foreach ($name in @('frontend', 'backend', 'scripts')) {
        if (-not (Test-Path -LiteralPath (Resolve-QBallFixPath $Root $name) -PathType Container)) { throw 'В выбранной папке нет полного существующего QStudy.' }
    }
    $plan = Get-QBallFixFiles $Root $package
    $native = Resolve-QBallFixPath $package 'stop/scripts/launcher/Native.ps1'
    $stop = Resolve-QBallFixPath $package 'stop/scripts/launcher/Stop-Previous.ps1'
    $start = Resolve-QBallFixPath $Root 'scripts/Start-QStudy.ps1'
    if (-not (Test-Path -LiteralPath $stop -PathType Leaf) -or -not (Test-Path -LiteralPath $start -PathType Leaf)) { throw 'Отсутствует штатный файл остановки или запуска.' }
    . $native
    $script:QStudyRoot = $Root; $script:QStudyLocal = Join-Path $Root '.local'; $script:QStudyStateFile = Join-Path $script:QStudyLocal 'processes.json'
    $stage = 'проверка владельца и действующего запуска'
    Assert-QStudyNativeStopOwner $Root
    Assert-QBallNoLegacyRuntime $Root
    $statePath = Resolve-QBallFixPath $Root '.local/launcher/state.json'
    $state = Read-QStudyNativeState $Root
    if ((Test-Path -LiteralPath $statePath) -and $null -eq $state) { throw 'Состояние запуска повреждено или относится к другой установке. Процессы и исходники сохранены.' }
    if ($null -ne $state -and $state.mode -cnotin @('local', 'lan', 'internet')) { throw 'Режим прежнего запуска не подтверждён.' }
    $chosenMode = if ($Mode) { $Mode } elseif ($null -ne $state) { $state.mode } else { $plan.manifest.target_mode }
    $owned = $false
    if ($null -ne $state) {
        foreach ($name in @('supervisor', 'frontend', 'backend')) {
            $record = Get-QStudyInstallProperty $state $name
            if ($null -ne $record -and $null -ne (Get-QStudyOwnedProcess $record.identity)) { $owned = $true }
        }
    }
    $managedPath = Resolve-QBallFixPath $Root '.local/managed/status.json'
    $managed = Read-QStudyInstallJson $managedPath
    if ($null -ne $managed -and (Get-QStudyInstallProperty $managed 'state' '') -cne 'stopped') {
        foreach ($name in @('backend', 'frontend')) {
            $childId = [int](Get-QStudyInstallProperty $managed ($name + '_pid') 0)
            if ($childId -gt 0 -and $null -ne (Get-QStudyProcess $childId)) {
                if ($null -eq $state -or $managed.root_owner -cne $Root -or $managed.instance -cne $state.instance) { throw 'Нельзя подтвердить владельца работающего сайта. Остановите его через админку.' }
                $owned = $true
            }
        }
    }
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    if ($owned) {
        $stage = 'штатная остановка сайта'
        & $powershell -NoProfile -ExecutionPolicy Bypass -File $stop -Root $Root -NoPause
        if ($LASTEXITCODE -ne 0) { throw 'Штатная остановка не завершена. Исходники не заменялись.' }
    } else { Write-Host 'Подтверждённых работающих процессов штатного запуска не найдено; чужие процессы не останавливаются.' }
    $lock = Enter-QStudyLock
    Assert-QStudyNativeStopOwner $Root
    Assert-QBallNoLegacyRuntime $Root
    $currentState = Read-QStudyNativeState $Root
    if ((Test-Path -LiteralPath $statePath) -and $null -eq $currentState) { throw 'Состояние запуска изменилось после остановки. Исходники не заменялись.' }
    if ($null -ne $currentState) {
        foreach ($name in @('supervisor', 'frontend', 'backend')) {
            $record = Get-QStudyInstallProperty $currentState $name
            if ($null -ne $record -and $null -ne (Get-QStudyOwnedProcess $record.identity)) { throw 'Сайт повторно запущен другим стартером. Исходники не заменялись; повторите исправление.' }
        }
    }
    $stage = 'резервная копия изменяемых исходников'
    $changed = @($plan.files | Where-Object { -not (Test-Path -LiteralPath $_.target) -or (Get-FileHash -LiteralPath $_.target -Algorithm SHA256).Hash.ToLowerInvariant() -cne $_.sha256 })
    $backup = Resolve-QBallFixPath $Root ('.local/source-updates/' + $plan.manifest.id + '-' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($backup) | Out-Null; Protect-QStudyNativePath $backup
    foreach ($file in $changed) {
        $destination = Resolve-QBallFixPath $backup $file.path
        [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
        if (Test-Path -LiteralPath $file.target -PathType Leaf) { [IO.File]::Copy($file.target, $destination, $false) }
    }
    [IO.File]::WriteAllText((Join-Path $backup 'files.json'), (ConvertTo-Json -InputObject @($changed | ForEach-Object { $_.path })), [Text.UTF8Encoding]::new($false))
    $stage = 'замена проверенных исходников'
    foreach ($file in $changed) {
        [void](Resolve-QBallFixPath $Root $file.path); [void](Resolve-QBallFixPath $package ('payload/' + $file.path))
        if ((Get-FileHash -LiteralPath $file.source -Algorithm SHA256).Hash.ToLowerInvariant() -cne $file.sha256) { throw 'Пакет изменился после проверки. Сохранена копия исходников.' }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $file.target)) | Out-Null
        $pending = $file.target + '.qstudy-fix-' + [Guid]::NewGuid().ToString('N') + '.tmp'
        [IO.File]::Copy($file.source, $pending, $false)
        if (Test-Path -LiteralPath $file.target -PathType Leaf) { [IO.File]::Replace($pending, $file.target, [NullString]::Value) } else { [IO.File]::Move($pending, $file.target) }
        $pending = ''
    }
    $lock.Dispose(); $lock = $null
    $stage = 'сборка и повторный запуск'
    & $powershell -NoProfile -ExecutionPolicy Bypass -File $start -Mode $chosenMode -NoBrowser -NoPause
    if ($LASTEXITCODE -ne 0) { throw 'Исходники обновлены, но штатный запуск не завершён. Исправьте указанную стартером причину и повторите Start-QStudy.' }
    Write-Host 'Исправление QBall установлено, штатный запуск завершён. База, аккаунты и настройки не заменялись.' -ForegroundColor Green
} catch {
    $failed = $true
    Write-Host ('QBall: этап «' + $stage + '» не завершён. ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'База и .env не импортировались и не заменялись. Автоматический откат не выполнялся.'
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
    if ($pending -and (Test-Path -LiteralPath $pending -PathType Leaf)) { Remove-Item -LiteralPath $pending -Force }
    if ($backup) { Write-Host ('Копия изменяемых исходников: ' + $backup) }
}
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }; exit 0
