param(
    [ValidateSet('enable', 'manual', 'disable', 'status', 'renew')][string]$Action = 'status',
    [ValidatePattern('^S-1-[0-9-]+$')][string]$ExpectedUserSid,
    [switch]$RouterCleanupConfirmed,
    [switch]$NoPause
)
. (Join-Path $PSScriptRoot 'QStudy.PublicAccess.ps1')
. (Join-Path $PSScriptRoot 'QStudy.NetworkOperation.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$code = 1
$operationMessage = ''
$targetSid = ''
$result = $null
try {
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $targetSid = if ($ExpectedUserSid) { $ExpectedUserSid } else { $currentSid }
    if (-not $ExpectedUserSid) { Initialize-QStudyNetworkOperationStore $root $targetSid }
    if ($RouterCleanupConfirmed -and $Action -ne 'disable') { throw 'QStudy: подтверждение очистки роутера применяется только при отключении доступа.' }
    if ($ExpectedUserSid -and $ExpectedUserSid -cne $currentSid) {
        throw 'QStudy: в запросе Windows использован другой аккаунт администратора. Войдите в Windows под нужным администратором и повторите эту же кнопку; запуск и подтверждение UAC должны выполняться одним аккаунтом.'
    }
    if ($Action -in @('enable', 'manual', 'disable')) {
        # Validate the installation before UAC. No secret values are arguments.
        if ($Action -ne 'disable') { Get-QStudyPublicAccessConfiguration $root | Out-Null }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try { $administrator = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
        finally { $identity.Dispose() }
        if (-not $administrator) {
            Write-Host 'Windows запросит разрешение открыть выбранный TCP-порт QStudy. Подтвердите UAC под тем же аккаунтом Windows.'
            $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $Action + ' -ExpectedUserSid ' + $currentSid + ' -NoPause'
            if ($RouterCleanupConfirmed) { $arguments += ' -RouterCleanupConfirmed' }
            $childStarted = [DateTimeOffset]::UtcNow
            $process = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
            $code = $process.ExitCode
            $childReport = Read-QStudyNetworkOperation -Root $root -Action $Action -TargetUserSid $targetSid -MinimumUtc $childStarted
            if ($null -eq $childReport -or $childReport.code -ne $code) {
                $code = 1
                $operationMessage = 'QStudy: Windows не вернула подтверждённый результат настройки сети. Подтвердите разрешение под тем же аккаунтом и повторите эту же кнопку. Старый отчёт не использовался.'
            } else { $operationMessage = $childReport.message }
            # State is useful for the manual-forwarding guide; it is not proof
            # that the hidden elevated operation completed successfully.
            try { $result = Invoke-QStudyPublicAccess $root 'status' } catch { $result = $null }
        } else { $result = Invoke-QStudyPublicAccess $root $Action -RouterCleanupConfirmed:$RouterCleanupConfirmed; $code = $result.code }
    } else { $result = Invoke-QStudyPublicAccess $root $Action; $code = $result.code }
    if ($null -ne $result) {
        if ($null -ne $result.report.PSObject.Properties['status']) { Write-Host ('Состояние сети: ' + $result.report.status) }
        if ($null -ne $result.report.PSObject.Properties['client_ip'] -and $result.report.client_ip) {
            Write-Host ('Правило роутера: TCP ' + $result.report.port + ' -> ' + $result.report.client_ip + ':' + $result.report.port)
        }
    }
    if (-not $operationMessage) {
        $operationMessage = switch ($code) {
            0 { 'QStudy: операция настройки сети завершилась. Доступ из интернета проверьте с телефона при выключенном Wi-Fi.' }
            2 { 'QStudy: автоматическая настройка или очистка порта не завершилась. Следуйте подсказке ручного проброса; CGNAT требует помощи провайдера.' }
            default { 'QStudy: настройка сети не завершилась. Проверьте разрешение Windows и повторите эту же кнопку.' }
        }
    }
    if ($code -eq 1) { Write-Host $operationMessage -ForegroundColor Red }
    elseif ($code -eq 2) { Write-Warning $operationMessage }
    else { Write-Host $operationMessage }
} catch {
    $operationMessage = ConvertTo-QStudyNetworkOperationMessage $_.Exception.Message $_.Exception.GetType().Name
    Write-Host $operationMessage -ForegroundColor Red
    $code = 1
}
if ($targetSid) {
    try { Save-QStudyNetworkOperation -Root $root -Action $Action -Code $code -Message $operationMessage -TargetUserSid $targetSid }
    catch { Write-Host 'QStudy: не удалось сохранить закрытый результат настройки сети. Проверьте права этой папки и повторите кнопку.' -ForegroundColor Red; $code = 1 }
}
if (-not $NoPause -and $Action -ne 'renew') { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
exit $code
