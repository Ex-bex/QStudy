param([switch]$NoPause)
. (Join-Path $PSScriptRoot 'QStudy.Common.ps1')
$lock = $null
$failed = $false
try {
    $lock = Enter-QStudyLock
    $state = Read-QStudyState
    foreach ($name in @('frontend', 'backend')) {
        if ($null -ne $state.$name) {
            Stop-QStudyRecord $state.$name
            $state.$name = $null
            Write-QStudyState $state
        }
    }
    # Preserve the previous-workspace marker even when a copied state had no
    # local processes, so the next start can repair verified upload references.
    Write-QStudyState $state
    Write-Host 'Собственные процессы QStudy остановлены. Данные сохранены.'
} catch {
    $failed = $true
    Write-Host "Ошибка остановки QStudy: $($_.Exception.Message)" -ForegroundColor Red
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
if ($failed) {
    if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
    exit 1
}
exit 0
