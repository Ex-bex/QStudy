param([switch]$NoPause)
. (Join-Path $PSScriptRoot 'launcher\Native.ps1')
. (Join-Path $PSScriptRoot 'launcher_network.ps1')
$root = $script:QStudyRoot
$lock = $null
$failed = $false
try {
    # Stopping must not take ownership of another Windows user's live runtime.
    # The lock creates an empty .local only when no runtime exists yet.
    Assert-QStudyNativeStopOwner $root
    $lock = Enter-QStudyLock
    Write-Host 'QStudy — остановка сайта для всех пользователей'
    Write-Host 'Завершаем процессы приложения и сохраняем текущие данные…'
    Stop-QStudySite $root
    Write-Host 'Сайт QStudy и игра остановлены. Аккаунты, материалы и настройки сохранены.' -ForegroundColor Green
    Write-Host 'Чтобы включить сайт снова, дважды щёлкните нужный файл Start-QStudy.'
} catch {
    $failed = $true
    Write-Host ('Ошибка остановки QStudy: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Данные не сбрасывались. Повторите эту же кнопку после исправления причины.'
} finally {
    if ($null -ne $lock) { $lock.Dispose() }
}
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
