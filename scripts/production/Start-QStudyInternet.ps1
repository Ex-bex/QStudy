param(
    [string]$PublicIP = '',
    [ValidateRange(0, 65535)][int]$Port = 0,
    [string]$RouterWanIPv4 = '',
    [string]$AdminEmail = '',
    [string]$Archive = '',
    [switch]$ManualForwarding,
    [switch]$NewInstallation,
    [switch]$Rebuild,
    [switch]$EnableAutostart,
    [switch]$NoBrowser,
    [switch]$NoPause
)
. (Join-Path $PSScriptRoot 'QStudy.InternetLaunch.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$manager = Join-Path $PSScriptRoot 'Manage-QStudy.ps1'
$failed = $false
$savedPath = $env:PATH
$launchLock = $null
$stage = 'configuration'

function Invoke-QStudyInternetManager([string]$Action, [hashtable]$Options = @{}) {
    & $manager -Action $Action @Options
    if ($LASTEXITCODE -ne 0) { throw ('Этап «' + $stage + '» не завершился. Причина указана выше; данные и настройки не заменены.') }
}

try {
    Write-Host 'QStudy — запуск для интернета'
    Write-Host 'Первый запуск готовит контейнеры и администратора; повторный использует сохранённые настройки.'
    $directory = Assert-QStudyHostPath $root (Join-Path $root '.local\internet-launch')
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    try { $launchLock = [IO.File]::Open((Join-Path $directory 'launch.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'Другой интернет-запуск уже выполняется. Дождитесь его завершения.' }
    if ($Archive -and $NewInstallation) { throw 'Выберите восстановление -Archive либо новую установку -NewInstallation.' }
    if ($Archive) { Assert-QStudyBackupBasename $Archive }
    $existing = Read-QStudyHostEnvironment $root
    try {
        if ($existing.Count) {
            if ($existing['QSTUDY_HOST_MODE'] -cne 'http') { throw 'Эта кнопка предназначена для HTTP IP:порт. Сохранён HTTPS: используйте штатный менеджер; конфигурация не менялась.' }
            if (($PublicIP -and $PublicIP -cne $existing['QSTUDY_PUBLIC_IP']) -or ($Port -and [string]$Port -cne $existing['QSTUDY_HTTP_PORT'])) { throw ('Установка уже настроена на ' + $existing['PUBLIC_BASE_URL'] + '. IP/порт не заменены; порядок их смены описан в docs/friend-hosting.md.') }
            $PublicIP = $existing['QSTUDY_PUBLIC_IP']; $Port = [int]$existing['QSTUDY_HTTP_PORT']
        } else {
            if (-not $PublicIP) { $PublicIP = Get-QStudyInternetObservedIP }
            if ((Get-QStudyIPv4Kind $PublicIP) -ne 'public') { throw 'Нужен публичный IPv4 без CGNAT.' }
            if (-not $Port) { $Port = Get-QStudyAvailableHttpPort }
            Invoke-QStudyInternetManager 'init-http' @{ PublicIP = $PublicIP; Port = $Port }
        }
    } finally { $existing.Clear() }
    $url = 'http://' + $PublicIP + ':' + $Port
    Write-Host ('Адрес этой установки: ' + $url)
    Write-Host 'HTTP передаёт данные без шифрования. Домен и сертификат не используются.'
    $oldDatabase = Assert-QStudyHostPath $root (Join-Path $root 'backend\studyhub.db')
    $newDatabase = Assert-QStudyHostPath $root (Join-Path $root 'deployment\data\backend\studyhub.db')
    if ((Test-Path -LiteralPath $oldDatabase -PathType Leaf) -and -not (Test-Path -LiteralPath $newDatabase -PathType Leaf) -and -not $Archive -and -not $NewInstallation) {
        throw 'Обнаружена база локального режима. Чтобы сохранить аккаунты, создайте штатную копию и запустите эту кнопку с -Archive ИМЯ.zip (из deployment/data/backups). -NewInstallation явно создаёт отдельную пустую установку; локальные файлы сохраняются.'
    }
    $stage = 'Docker Desktop'; Ensure-QStudyInternetDocker
    Invoke-QStudyInternetManager 'check' @{ Offline = $true }
    Invoke-QStudyInternetManager 'stack-status'
    $stack = Read-QStudyInternetReport $root 'host-stack-status.json'
    $fingerprint = Get-QStudyInternetBuildFingerprint $root
    $stage = 'подготовка приложения'
    if ($Rebuild -or -not $stack.images_ready -or -not (Test-QStudyInternetBuildCurrent $root $fingerprint)) {
        if ($stack.caddy_running) { Invoke-QStudyInternetManager 'stop' }
        Invoke-QStudyInternetManager 'prepare'
        Save-QStudyInternetBuildState $root $fingerprint
    } else { Invoke-QStudyInternetManager 'resume-private' }
    if ($Archive) {
        $stage = 'восстановление данных'
        Invoke-QStudyInternetManager 'restore' @{ Archive = $Archive; NoPublish = $true }
    }
    $stage = 'проверка администратора'
    Invoke-QStudyInternetManager 'account-status'
    $accounts = Read-QStudyInternetReport $root 'host-account-status.json'
    if (-not $accounts.active_admin_exists) {
        if (-not $AdminEmail) { $AdminEmail = Read-Host 'Email нового первого администратора (пароль будет скрыт)' }
        if (-not $AdminEmail) { throw 'Первый администратор не создан. Публичный запуск остановлен; повторите эту же кнопку и укажите email.' }
        Invoke-QStudyInternetManager 'first-admin' @{ Email = $AdminEmail }
        Invoke-QStudyInternetManager 'account-status'
        if (-not (Read-QStudyInternetReport $root 'host-account-status.json').active_admin_exists) { throw 'Нет активного администратора. Публичный запуск остановлен.' }
    }
    $stage = 'сеть и проброс порта'
    $options = @{ HttpPort = $Port; NoPause = $true }
    if ($RouterWanIPv4) { $options['RouterWanIPv4'] = $RouterWanIPv4 }
    & (Join-Path $root 'scripts\Test-QStudyHomeNetwork.ps1') @options
    if ($LASTEXITCODE -ne 0) { throw 'Диагностика сети не завершилась; прочитайте её сообщение выше.' }
    $networkPath = Assert-QStudyHostPath $root (Join-Path $root '.local\home-network-report.json')
    $network = [IO.File]::ReadAllText($networkPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    Assert-QStudyHostIpNetworkForStart $network $PublicIP
    $action = if ($ManualForwarding) { 'manual' } else { 'enable' }
    & (Join-Path $PSScriptRoot 'Manage-QStudyPublicAccess.ps1') -Action $action -NoPause
    if ($LASTEXITCODE -ne 0) { throw ('Автоматическая настройка порта не завершилась. В роутере нужен TCP ' + $Port + ' → LAN-IP этого Windows-компьютера:' + $Port + '. После ручного проброса повторите Start-QStudy-Internet.cmd -ManualForwarding. CGNAT решается у провайдера.') }
    $stage = 'запуск сайта'
    Invoke-QStudyInternetManager 'launch' @{ NoBrowser = $NoBrowser }
    if ($EnableAutostart) { Invoke-QStudyInternetManager 'install-autostart' }
    Write-Host ('QStudy работает на хосте. Адрес для посетителей: ' + $url)
    Write-Host 'Откройте этот адрес с телефона с выключенным Wi-Fi. Это подтвердит доступ из интернета.'
} catch {
    $failed = $true
    Write-Host ('QStudy: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Для диагностики: Manage-QStudy-PublicAccess.cmd status и Test-QStudy-HomeNetwork.cmd. Пришлите строки ошибки, без .env и паролей.'
} finally {
    $env:PATH = $savedPath
    if ($null -ne $launchLock) { $launchLock.Dispose() }
}
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
