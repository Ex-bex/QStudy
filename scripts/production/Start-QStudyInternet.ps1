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
. (Join-Path $PSScriptRoot 'QStudy.InternetConfiguration.ps1')
. (Join-Path $PSScriptRoot 'QStudy.NetworkGuide.ps1')
. (Join-Path $PSScriptRoot 'QStudy.NetworkOperation.ps1')
. (Join-Path $PSScriptRoot 'QStudy.InternetDataChoice.ps1')
. (Join-Path $PSScriptRoot 'QStudy.InternetLaunch.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$manager = Join-Path $PSScriptRoot 'Manage-QStudy.ps1'
$failed = $false
$savedPath = $env:PATH
$launchLock = $null
$stage = 'configuration'
$url = ''
$directory = $null
$addressChanged = $false

function Invoke-QStudyInternetManager([string]$Action, [hashtable]$Options = @{}) {
    & $manager -Action $Action @Options
    if ($LASTEXITCODE -ne 0) { throw ('QStudy: этап «' + $stage + '» не завершился. Причина указана выше. Исправьте её и повторите эту же кнопку запуска.') }
}

function Invoke-QStudyInternetAccess([string]$Action, [switch]$CleanupConfirmed) {
    & (Join-Path $PSScriptRoot 'Manage-QStudyPublicAccess.ps1') -Action $Action -RouterCleanupConfirmed:$CleanupConfirmed -NoPause
    return [int]$LASTEXITCODE
}

function Save-QStudyInternetLaunchResult([string]$Status, [string]$Message) {
    if (-not $directory) { return }
    $path = Assert-QStudyHostPath $root (Join-Path $directory 'last-run.json')
    $safeIP = if ((Get-QStudyIPv4Kind $PublicIP) -eq 'public') { $PublicIP } else { '' }
    $report = @{ version = 1; checked_utc = [DateTime]::UtcNow.ToString('o'); stage = $stage; status = $Status;
        message = $Message; public_ip = $safeIP; port = $Port; public_url = $url; external_reachability_proven = $false }
    $temporary = Assert-QStudyHostPath $root (Join-Path $directory ('result-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    try {
        [IO.File]::WriteAllText($temporary, ($report | ConvertTo-Json), [Text.UTF8Encoding]::new($true))
        (Get-Item -LiteralPath $temporary).SetAccessControl((New-QStudyPrivateAcl $false $temporary))
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Disable-QStudyInternetPreviousAccess($State) {
    $stageBeforeCleanup = $stage
    $script:stage = 'очистка прежнего проброса'
    if ($State.method -ceq 'manual') {
        Write-Host ('Прежнее ручное правило: TCP ' + $State.port + ' -> ' + $State.client_ip + ':' + $State.port + ' на роутере http://' + $State.gateway + '/.')
        Write-Host 'Если LAN-адрес или порт изменился, обновите своё правило QStudy в роутере либо удалите старое. Скрипт не удаляет ручные правила; новый проброс нужно подтвердить заново.'
    }
    $code = Invoke-QStudyInternetAccess 'disable'
    if ($code -eq 2) {
        $pending = Read-QStudyPublicAccessState $root (Get-QStudyPublicAccessSpec $root)
        if ($null -eq $pending -or $pending.enabled -or $pending.status -cne 'router_cleanup_pending') {
            throw 'QStudy: прежняя настройка сети не отключена безопасно. Повторите кнопку после исправления причины выше.'
        }
        Write-Host 'Windows-доступ отключён, но удаление прежнего правила роутера не подтверждено.'
        Write-Host ('Проверьте прежний роутер http://' + $State.gateway + '/. Правило QStudy: TCP ' + $State.port + ' -> ' + $State.client_ip + ':' + $State.port + '.')
        Write-Host ('Удалите только своё прежнее правило «' + (Get-QStudyPublicAccessSpec $root).mappingDescription + '», либо подтвердите, что его аренда уже истекла. Чужие правила не меняйте.')
        $answer = Read-Host 'Удалили прежнее правило / подтвердили истечение его аренды? Enter — подтвердить; 0 — остановить'
        if ($answer -cne '') { throw 'QStudy: очистка прежнего правила не подтверждена. Настройки адреса не заменены; повторите эту же кнопку после очистки.' }
        $code = Invoke-QStudyInternetAccess 'disable' -CleanupConfirmed
    }
    $clean = Read-QStudyPublicAccessState $root (Get-QStudyPublicAccessSpec $root)
    if ($code -ne 0 -or ($null -ne $clean -and ($clean.enabled -or $clean.method -cne 'none' -or $null -ne $clean.record))) {
        throw 'QStudy: прежний проброс не очищен. Новый адрес не применяется; исправьте причину выше и повторите кнопку.'
    }
    $script:stage = $stageBeforeCleanup
}

try {
    Write-Host 'QStudy — запуск для интернета'
    Write-Host 'IP определяется автоматически при каждом запуске. Порт по умолчанию — 8080; команды вводить не нужно.'
    $directory = Assert-QStudyHostPath $root (Join-Path $root '.local\internet-launch')
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    (Get-Item -LiteralPath $directory).SetAccessControl((New-QStudyPrivateAcl $true $directory))
    try { $launchLock = [IO.File]::Open((Join-Path $directory 'launch.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch { throw 'QStudy: другой интернет-запуск уже выполняется. Дождитесь его завершения.' }
    $stage = 'выбор переноса данных'
    $dataChoice = Resolve-QStudyInternetDataChoice -Root $root -Archive $Archive -NewInstallation:$NewInstallation
    $Archive = $dataChoice.archive
    $stage = 'проверка IP и порта'
    $requestedIP = $PublicIP; $requestedPort = $Port
    if (-not $Port) { $Port = 8080 }
    if (-not $PublicIP) { $PublicIP = Get-QStudyInternetObservedIP }
    if ((Get-QStudyIPv4Kind $PublicIP) -ne 'public') { throw 'QStudy: нужен публичный IPv4. Проверьте подключение и VPN, затем повторите эту же кнопку.' }
    $url = 'http://' + $PublicIP + ':' + $Port
    $stage = 'Docker Desktop'; Ensure-QStudyInternetDocker
    $stage = 'проверка порта'
    try { Assert-QStudyPublicPortOwner -Root $root -Port $Port }
    catch { throw ('QStudy: порт TCP ' + $Port + ' занят другим приложением или его владелец не подтверждён. Закройте приложение, занимающее этот порт, или запустите Docker Desktop и повторите эту же кнопку. Порт не заменён другим автоматически.') }
    $route = Get-QStudyPublicAccessRoute
    $networkAction = Get-QStudyInternetNetworkAction -Root $root -ManualRequested:$ManualForwarding
    $stage = 'настройка адреса'
    $existing = Read-QStudyHostEnvironment $root
    try {
        if ($existing.Count) {
            if ($existing['QSTUDY_HOST_MODE'] -cne 'http') { throw 'QStudy: здесь сохранена установка HTTPS. Эта кнопка предназначена для HTTP IP:порт; настройки HTTPS не изменены.' }
            if (($requestedIP -and $requestedIP -cne $existing['QSTUDY_PUBLIC_IP']) -or ($requestedPort -and [string]$requestedPort -cne $existing['QSTUDY_HTTP_PORT'])) {
                throw 'QStudy: явные параметры не совпадают с сохранённой установкой. Запустите эту же кнопку без параметров: IP определится автоматически, порт будет 8080.'
            }
            $addressChanged = $existing['QSTUDY_PUBLIC_IP'] -cne $PublicIP -or $existing['QSTUDY_HTTP_PORT'] -cne [string]$Port -or $existing['PUBLIC_BASE_URL'] -cne $url
            $state = Read-QStudyPublicAccessState $root (Get-QStudyPublicAccessSpec $root)
            $routeChanged = $null -ne $state -and ($state.client_ip -cne $route.client_ip -or $state.gateway -cne $route.gateway)
            $stateAddressChanged = $null -ne $state -and ($state.public_ip -cne $PublicIP -or $state.port -ne $Port)
            if ($null -ne $state -and ($state.enabled -or $state.method -cne 'none' -or $null -ne $state.record) -and ($addressChanged -or $stateAddressChanged -or $routeChanged -or $state.status -ceq 'router_cleanup_pending')) {
                Disable-QStudyInternetPreviousAccess $state
                # A saved manual rule may point at the old LAN IP/port. Obtain a
                # fresh deliberate choice rather than assume it was updated.
                if (-not $ManualForwarding) { $networkAction = 'enable' }
            }
            $refreshed = Set-QStudyInternetAddress -Root $root -PublicIP $PublicIP -Port $Port
            if ($refreshed.changed) { Write-Host ('Адрес автоматически обновлён: ' + $url + '. Аккаунты, пароли и настройки почты сохранены.') }
        } else {
            Invoke-QStudyInternetManager 'init-http' @{ PublicIP = $PublicIP; Port = $Port }
        }
    } finally { $existing.Clear() }
    Write-Host ('Адрес этой установки: ' + $url)
    Write-Host 'HTTP передаёт данные без шифрования. Домен и сертификат не используются.'
    $stage = 'проверка установки'
    Invoke-QStudyInternetManager 'check' @{ Offline = $true }
    Invoke-QStudyInternetManager 'stack-status'
    $stack = Read-QStudyInternetReport $root 'host-stack-status.json'
    $fingerprint = Get-QStudyInternetBuildFingerprint $root
    $stage = 'подготовка приложения'
    if ($addressChanged -and $stack.caddy_running) { Invoke-QStudyInternetManager 'stop'; $stack.caddy_running = $false }
    if ($Rebuild -or -not $stack.images_ready -or -not (Test-QStudyInternetBuildCurrent $root $fingerprint)) {
        if ($stack.caddy_running) { Invoke-QStudyInternetManager 'stop' }
        Invoke-QStudyInternetManager 'prepare'
        Save-QStudyInternetBuildState $root $fingerprint
    } else { Invoke-QStudyInternetManager 'resume-private' }
    if ($Archive) {
        $stage = 'восстановление данных'
        Invoke-QStudyInternetManager 'verify' @{ Archive = $Archive }
        Invoke-QStudyInternetManager 'restore' @{ Archive = $Archive; NoPublish = $true }
    }
    $stage = 'проверка администратора'
    Invoke-QStudyInternetManager 'account-status'
    $accounts = Read-QStudyInternetReport $root 'host-account-status.json'
    if (-not $accounts.active_admin_exists) {
        if (-not $AdminEmail) { $AdminEmail = Read-Host 'Email нового первого администратора (пароль будет скрыт)' }
        if (-not $AdminEmail) { throw 'QStudy: первый администратор не создан. Публичный запуск остановлен; повторите эту же кнопку и укажите email.' }
        Invoke-QStudyInternetManager 'first-admin' @{ Email = $AdminEmail }
        Invoke-QStudyInternetManager 'account-status'
        if (-not (Read-QStudyInternetReport $root 'host-account-status.json').active_admin_exists) { throw 'QStudy: нет активного администратора. Публичный запуск остановлен.' }
    }
    $stage = 'сеть и проброс порта'
    $options = @{ HttpPort = $Port; NoPause = $true }
    if ($RouterWanIPv4) { $options['RouterWanIPv4'] = $RouterWanIPv4 }
    & (Join-Path $root 'scripts\Test-QStudyHomeNetwork.ps1') @options
    if ($LASTEXITCODE -ne 0) { throw 'QStudy: диагностика сети не завершилась. Проверьте интернет и повторите кнопку.' }
    $networkPath = Assert-QStudyHostPath $root (Join-Path $root '.local\home-network-report.json')
    $network = [IO.File]::ReadAllText($networkPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    try { Assert-QStudyHostIpNetworkForStart $network $PublicIP }
    catch {
        if ($network.wanAssessment -in @('cgnat', 'private_wan', 'invalid_wan', 'wan_mismatch')) {
            Write-QStudyManualNetworkGuide -Root $root -PublicIP $PublicIP -Port $Port -Route $route -Reason 'provider_action_required' | Out-Null
        }
        throw 'QStudy: диагностика не подтверждает подходящее подключение. Проверьте WAN роутера, VPN и сообщения выше; затем повторите ту же кнопку.'
    }
    $code = Invoke-QStudyInternetAccess $networkAction
    if ($code -eq 2) {
        $state = Read-QStudyPublicAccessState $root (Get-QStudyPublicAccessSpec $root)
        $reason = 'unknown'
        if ($null -ne $state) {
            $reason = [string]$state.mapping_status
            if (-not $reason) { $reason = [string]$state.status }
            if ($state.provider_action_required) { $reason = 'provider_action_required' }
        }
        $guide = Write-QStudyManualNetworkGuide -Root $root -PublicIP $PublicIP -Port $Port -Route $route -Reason $reason
        $existingManualRule = $reason -ceq 'conflict' -and $null -ne $state -and $null -eq $state.record -and $state.status -ceq 'manual_required' -and -not $state.provider_action_required
        if ((-not $guide.manual_ready -and -not $existingManualRule) -or $null -eq $state -or $null -ne $state.record -or $state.status -cne 'manual_required') {
            throw 'QStudy: сначала устраните указанную сетевую причину. Ручной проброс не обходит CGNAT, конфликт или незавершённую очистку. Инструкция сохранена рядом с отчётом запуска.'
        }
        if (-not $NoBrowser) { Start-Process -FilePath $guide.router_url | Out-Null }
        if ($existingManualRule) {
            Write-Host ('Если это ваше уже созданное правило QStudy, проверьте: внешний TCP ' + $Port + ' -> ' + $route.client_ip + ':' + $Port + '. Чужое правило подтверждать нельзя; скрипт его не изменит.')
            $answer = Read-Host 'Проверили своё правило QStudy и его точный адрес? 1 — подтверждаю; 0 — остановить'
            if ($answer -cne '1') { throw 'QStudy: существующее правило не подтверждено как ваше правило QStudy. Настройка остановлена; чужое правило не изменено.' }
        } else {
            $answer = Read-Host 'После сохранения правила роутера нажмите Enter; 0 — остановить и настроить позже'
            if ($answer -cne '') { throw 'QStudy: ручной проброс пока не подтверждён. Инструкция сохранена; после настройки повторите эту же кнопку без команд.' }
        }
        $code = Invoke-QStudyInternetAccess 'manual'
    }
    if ($code -ne 0) { throw 'QStudy: настройка сети не завершилась. Прочитайте сообщение Windows выше и повторите эту же кнопку после исправления.' }
    $stage = 'запуск сайта'
    Invoke-QStudyInternetManager 'launch' @{ NoBrowser = $NoBrowser }
    if ($EnableAutostart) { Invoke-QStudyInternetManager 'install-autostart' }
    Write-Host ('QStudy работает на хосте. Адрес для посетителей: ' + $url)
    Write-Host 'Откройте этот адрес с телефона с выключенным Wi-Fi. Это подтвердит доступ из интернета.'
    Save-QStudyInternetLaunchResult 'complete' 'QStudy: сайт запущен на хосте. Внешний доступ ещё нужно проверить с телефона через мобильный интернет.'
} catch {
    $failed = $true
    $message = ConvertTo-QStudyNetworkOperationMessage $_.Exception.Message $_.Exception.GetType().Name
    Write-Host ('Этап: ' + $stage + '. ' + $message) -ForegroundColor Red
    try { Save-QStudyInternetLaunchResult 'failed' $message } catch { Write-Host 'Не удалось сохранить отчёт. Скопируйте сообщение из этого окна.' }
    if ($directory) { Write-Host ('Отчёт для помощи: ' + (Join-Path $directory 'last-run.json') + '. Он не содержит паролей. Не отправляйте .env или базу данных.') }
    Write-Host 'Исправьте указанную причину и снова дважды щёлкните Start-QStudy-Internet.cmd. Команды вводить не нужно.'
} finally {
    $env:PATH = $savedPath
    if ($null -ne $launchLock) { $launchLock.Dispose() }
}
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
