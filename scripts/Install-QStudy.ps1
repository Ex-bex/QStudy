param(
    [switch]$CheckOnly,
    [switch]$ForceRepair,
    [switch]$Offline,
    [switch]$NoPause,
    [string]$RootPath = ''
)
. (Join-Path $PSScriptRoot 'QStudy.Install.ps1')
$failed = $false
$launcherLock = $null
try {
    if ($CheckOnly) {
        $computer = Get-QStudyComputerInfo -RootPath $RootPath
        Write-Host "$($computer.os) $($computer.architecture); $($computer.processor)"
        Write-Host "Оперативная память: $($computer.memoryGB) ГБ; свободно на диске: $($computer.availableDiskGB) ГБ."
        $status = Get-QStudyInstallationStatus -RootPath $RootPath
        if ($status.ready) { Write-Host 'QStudy готов к запуску.' }
        else {
            Write-Host 'QStudy требует настройки:'
            foreach ($reason in $status.reasons) { Write-Host "  $reason" }
            $failed = $true
        }
        # Availability is separate from application readiness. This check does
        # not write markers, provision capabilities, or display a UAC prompt.
        if (Get-Command Get-QStudyOcrProbe -CommandType Function -ErrorAction SilentlyContinue) {
            $ocr = Get-QStudyOcrProbe -RootPath $RootPath
            if ($ocr.ok) { Write-Host ('Русский OCR Windows готов (' + $ocr.language + ').') }
            else { Write-Warning (Get-QStudyOcrWarning $ocr.reason) }
        } else {
            Write-Warning 'Проверка OCR недоступна: скопируйте папку scripts полностью.'
        }
    } else {
        # Match Start's lock order: launcher lock, then installation lock.
        # A standalone repair must not replace dependencies of a running service.
        . (Join-Path $PSScriptRoot 'QStudy.Common.ps1')
        if ($RootPath) {
            $script:QStudyRoot = Get-QStudyInstallRoot $RootPath
            $script:QStudyLocal = Join-Path $script:QStudyRoot '.local'
            $script:QStudyStateFile = Join-Path $script:QStudyLocal 'processes.json'
        }
        $launcherLock = Enter-QStudyLock
        $status = Get-QStudyInstallationStatus -RootPath $RootPath
        if ($ForceRepair -or -not $status.ready) {
            $state = Read-QStudyState
            foreach ($name in @('frontend', 'backend')) {
                $record = $state.$name
                if ($null -eq $record) { continue }
                foreach ($identity in @($record.identity) + @($record.descendants)) {
                    if ($null -ne (Get-QStudyOwnedProcess $identity)) {
                        throw 'Перед установкой или восстановлением остановите QStudy через Stop-QStudy.cmd, затем повторите Install-QStudy.cmd. Данные и процессы сохранены.'
                    }
                }
            }
        }
        [void](Ensure-QStudyInstallation -RootPath $RootPath -ForceRepair:$ForceRepair -Offline:$Offline)
        Write-Host 'Теперь запустите Start-QStudy.cmd.'
    }
} catch {
    $failed = $true
    Write-Host "Ошибка подготовки QStudy: $($_.Exception.Message)" -ForegroundColor Red
} finally { if ($null -ne $launcherLock) { $launcherLock.Dispose() } }
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
