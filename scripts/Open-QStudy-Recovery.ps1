param([string]$Email = '', [switch]$NoPause)
. (Join-Path $PSScriptRoot 'QStudy.Install.ps1')
$failed = $false
try {
    if (-not $Email) { $Email = Read-Host 'Email аккаунта, запросившего восстановление' }
    $status = Get-QStudyInstallationStatus
    if (-not $status.backendReady) { throw 'Сначала подготовьте окружение через Install-QStudy.cmd.' }
    $qstudyRecoveryArguments = @((Join-Path $PSScriptRoot 'qstudy_recovery.py'), '--project-root', $status.workspace, '--email', $Email.Trim())
    # Capture the sensitive output; the URL is never printed to the console.
    $qstudyRecoveryOutput = @(& $status.runtime.python @qstudyRecoveryArguments 2>$null)
    if ($LASTEXITCODE -ne 0) { throw 'Действующая ссылка не найдена. Запросите восстановление на странице входа.' }
    $qstudyRecoveryData = ($qstudyRecoveryOutput -join '') | ConvertFrom-Json
    $qstudyRecoveryUri = [Uri]$qstudyRecoveryData.url
    if ($qstudyRecoveryUri.Scheme -notin @('http', 'https') -or $qstudyRecoveryUri.AbsolutePath -ne '/reset-password' -or $qstudyRecoveryUri.Fragment -notmatch '^#token=[A-Za-z0-9_-]{40,128}$' -or $qstudyRecoveryUri.UserInfo) { throw 'Некорректная ссылка восстановления.' }
    Start-Process -FilePath $qstudyRecoveryUri.AbsoluteUri | Out-Null
    Write-Host 'Страница смены пароля открыта. Ссылка и пароль не выводятся в консоль.'
} catch {
    $failed = $true
    Write-Host 'Не удалось открыть действующую ссылку. Проверьте запуск QStudy и запросите новое восстановление.' -ForegroundColor Red
}
if ($failed -and -not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }