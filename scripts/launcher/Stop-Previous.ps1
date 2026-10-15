param(
    [Parameter(Mandatory = $true)][string]$Root,
    [switch]$NoPause
)
# Compatibility entry point: helpers may live in a separate folder, while process
# identities, signed control and all data continue to belong to the old root.
$ErrorActionPreference = 'Stop'
$lock = $null
$failed = $false
try {
    . (Join-Path $PSScriptRoot 'Native.ps1')
    . (Join-Path $PSScriptRoot '..\launcher_network.ps1')
    $previousRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    if (-not $previousRoot -or $previousRoot -eq [IO.Path]::GetPathRoot($previousRoot).TrimEnd('\', '/')) {
        throw 'Укажите папку проекта QStudy, в которой находятся backend, frontend и scripts.'
    }
    [void](Assert-QStudyNativePath $previousRoot $previousRoot)
    foreach ($name in @('backend', 'frontend', 'scripts')) {
        $required = Assert-QStudyNativePath $previousRoot (Join-Path $previousRoot $name)
        if (-not (Test-Path -LiteralPath $required -PathType Container)) {
            throw 'Файл Stop-QStudy.cmd нужно распаковать в корень прежнего QStudy рядом с backend, frontend и scripts.'
        }
    }
    $script:QStudyRoot = $previousRoot
    $script:QStudyLocal = Join-Path $previousRoot '.local'
    $script:QStudyStateFile = Join-Path $script:QStudyLocal 'processes.json'
    Assert-QStudyNativeStopOwner $previousRoot
    $lock = Enter-QStudyLock
    $nativePath = Assert-QStudyNativePath $previousRoot (Join-Path $previousRoot '.local\launcher\state.json')
    $native = Read-QStudyNativeState $previousRoot
    $owned = $false
    if (Test-Path -LiteralPath $nativePath -PathType Leaf) {
        if ($null -eq $native) {
            throw 'Состояние запуска относится к другому компьютеру, папке или Windows-аккаунту либо повреждено. Чужие процессы не изменены.'
        }
        foreach ($name in @('supervisor', 'frontend', 'backend')) {
            $record = Get-QStudyInstallProperty $native $name
            if ($null -ne $record -and $null -ne (Get-QStudyOwnedProcess $record.identity)) { $owned = $true }
        }
        # An admin restart may have replaced child PIDs before its supervisor
        # exited. Recover only this same instance's ownership-checked children.
        if (-not $owned) {
            $managed = Read-QStudyInstallJson (Join-Path $previousRoot '.local\managed\status.json')
            if ($null -ne $managed -and $managed.root_owner -ceq $previousRoot -and $managed.instance -ceq $native.instance) {
                foreach ($name in @('backend', 'frontend')) {
                    $childId = [int](Get-QStudyInstallProperty $managed ($name + '_pid') 0)
                    if ($childId -gt 0) {
                        try {
                            $bind = if ($name -ceq 'backend') { '127.0.0.1' } else { $native.bind }
                            $hostHeader = if ($name -ceq 'frontend') { ($native.site_url -split '//', 2)[1] } else { '' }
                            $record = New-QStudyNativeChildRecord $name $childId $previousRoot $native.instance ([int]$native.($name + '_port')) $bind $hostHeader
                            if ($null -ne $record) { $owned = $true }
                        } catch { } # Reused or unrelated PIDs never authorize a stop.
                    }
                }
            }
        }
        $supervisor = Get-QStudyInstallProperty $native 'supervisor'
        if ($null -ne $supervisor -and $null -ne (Get-QStudyOwnedProcess $supervisor.identity)) {
            $control = Assert-QStudyNativePath $previousRoot (Join-Path $previousRoot 'scripts\launcher\control.py')
            if (-not (Test-Path -LiteralPath $control -PathType Leaf)) {
                throw 'В прежнем запуске отсутствует scripts/launcher/control.py. Используйте «Остановить сайт» в его админке; процессы и данные сохранены.'
            }
        }
    }
    if (Test-Path -LiteralPath $script:QStudyStateFile -PathType Leaf) {
        # Validate before Read-QStudyState, which archives copied legacy state.
        $legacy = Read-QStudyInstallJson $script:QStudyStateFile
        if ($null -eq $legacy -or $legacy.version -notin @(1, 2) -or
            -not [string]::Equals($legacy.workspace, $previousRoot, [StringComparison]::OrdinalIgnoreCase) -or
            ($legacy.version -eq 2 -and $legacy.computer -cne (Get-QStudyComputerFingerprint))) {
            throw 'Прежнее локальное состояние относится к другой установке или повреждено. Процессы и файлы состояния не изменены.'
        }
        foreach ($name in @('frontend', 'backend')) {
            $record = Get-QStudyInstallProperty $legacy $name
            if ($null -ne $record -and $null -ne (Get-QStudyOwnedProcess $record.identity)) { $owned = $true }
        }
    }
    if (-not $owned) {
        throw 'Не найдены подтверждённые процессы штатного запуска этой папки QStudy. Если сайт работает, откройте в его админке «Работа сайта» → «Остановить сайт». Для Docker откройте Docker Desktop → Containers → проект QStudy → Stop; другие проекты не останавливайте. При ручном запуске завершите его в исходном терминале. Автоматическая остановка не выполнялась.'
    }
    Write-Host 'Завершаем подтверждённый запуск QStudy. Аккаунты, база и настройки сохраняются…'
    Stop-QStudySite $previousRoot
    Write-Host 'Управляемые процессы QStudy остановлены. Данные и исходники сохранены.' -ForegroundColor Green
} catch {
    $failed = $true
    Write-Host ('QStudy: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
