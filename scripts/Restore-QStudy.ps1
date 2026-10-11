param(
    [Parameter(Mandatory = $true)][string]$Archive,
    [switch]$VerifyOnly,
    [switch]$NoPause
)
. (Join-Path $PSScriptRoot 'QStudy.Common.ps1')
$lock = $null
$failed = $false
try {
    if (-not (Test-Path -LiteralPath $Archive -PathType Leaf)) { throw 'Укажите существующий ZIP-архив резервной копии QStudy.' }
    $archivePath = [IO.Path]::GetFullPath($Archive)
    $lock = Enter-QStudyLock
    $state = Read-QStudyState
    if (-not $VerifyOnly) {
        foreach ($name in @('frontend', 'backend')) {
            $record = $state.$name
            if ($null -eq $record) { continue }
            foreach ($identity in @($record.identity) + @($record.descendants)) {
                if ($null -ne (Get-QStudyOwnedProcess $identity)) {
                    throw 'Сначала остановите QStudy через Stop-QStudy.cmd. Восстановление работающего сайта запрещено.'
                }
            }
        }
    }
    . (Join-Path $PSScriptRoot 'QStudy.Install.ps1')
    $status = Get-QStudyInstallationStatus
    if (-not $status.backendReady) { throw 'Сначала подготовьте окружение через Install-QStudy.cmd.' }
    $arguments = @((Join-Path $PSScriptRoot 'qstudy_backup.py'), '--project-root', $script:QStudyRoot, '--archive', $archivePath)
    if ($VerifyOnly) { $arguments += '--verify-only' } else { $arguments += '--stopped' }
    & $status.runtime.python @arguments
    if ($LASTEXITCODE -ne 0) { throw 'Проверка или восстановление не завершены. Текущие данные сохранены для восстановления.' }
    if ($VerifyOnly) { Write-Host 'Архив прошёл проверку контрольных сумм.' }
    else { Write-Host 'База и загруженные файлы восстановлены. backend/.env сохранён. Запустите Start-QStudy.cmd.' }
} catch {
    $failed = $true
    Write-Host "Ошибка: $($_.Exception.Message)" -ForegroundColor Red
} finally { if ($null -ne $lock) { $lock.Dispose() } }
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
