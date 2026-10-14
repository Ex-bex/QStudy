# Read-only network guidance. Dot-sourcing does not inspect or change the network.
. (Join-Path $PSScriptRoot 'QStudy.HostSetup.ps1')
. (Join-Path $PSScriptRoot '..\QStudy.HomeNetwork.ps1')

function Get-QStudyFriendlyNetworkReason {
    param([Alias('Status')][string]$Reason = 'manual_required')
    $code = $Reason.Trim().ToLowerInvariant()
    if ($code -notmatch '^[a-z_]+$') { $code = 'unknown' }
    $title = 'Автоматический проброс порта недоступен.'
    $detail = 'Роутер не разрешил UPnP/NAT-PMP. Один раз добавьте правило в настройках роутера, затем продолжите запуск в этом окне.'
    $manual = $true; $provider = $false
    switch ($code) {
        { $_ -in @('manual_required', 'unsupported', 'absent', 'not_configured') } { break }
        'conflict' {
            $title = 'На роутере этот внешний порт уже занят другим правилом.'
            $detail = 'QStudy не менял чужое правило. Проверьте его назначение: если оно относится к другому приложению, сначала согласуйте освобождение порта. Продолжать с чужим правилом нельзя.'
            $manual = $false; break
        }
        { $_ -in @('stale_record', 'router_cleanup_pending') } {
            $title = 'Сохранённое правило относится к прежней сети или адресу компьютера.'
            $detail = 'Старое правило не удалено автоматически. Проверьте прежнее правило QStudy и сетевые настройки; нельзя перенаправлять или удалять чужое правило. После исправления повторите ту же кнопку запуска.'
            $manual = $false; break
        }
        { $_ -in @('foreignport', 'foreign_port', 'port_occupied') } {
            $title = 'На компьютере выбранный порт занят другим приложением.'
            $detail = 'QStudy не остановил чужой процесс. Закройте приложение, которое занимает этот порт, и повторите ту же кнопку запуска. Настройка роутера не устранит занятый порт на компьютере.'
            $manual = $false; break
        }
        { $_ -in @('wan_mismatch', 'provider_action_required', 'cgnat', 'private_wan', 'invalid_wan') } {
            $title = 'Прямой доступ из интернета пока невозможен через этот WAN-адрес.'
            $detail = 'WAN-адрес роутера не совпадает с внешним публичным IPv4 либо находится за CGNAT/другим роутером. Обычный проброс порта это не обходит. Проверьте VPN и второй роутер; у провайдера уточните публичный IPv4 именно на WAN этого роутера. После исправления повторите ту же кнопку запуска.'
            $manual = $false; $provider = $true; break
        }
        default {
            $title = 'Сетевую настройку нужно проверить перед продолжением.'
            $detail = 'Причина не распознана. Запуск не будет выдавать это за успешный проброс. Сохраните сообщение из окна запуска и проверьте состояние подключения.'
            $manual = $false
        }
    }
    return [PSCustomObject]@{ code = $code; title = $title; detail = $detail; manual_allowed = $manual; provider_action_required = $provider }
}

function Write-QStudyManualNetworkGuide {
    param(
        [Parameter(Mandatory)][string]$Root,
        [Parameter(Mandatory)][string]$PublicIP,
        [Parameter(Mandatory)][ValidateRange(1, 65535)][int]$Port,
        $Route = $null,
        [string]$Reason = 'manual_required'
    )
    if ((Get-QStudyIPv4Kind $PublicIP) -ne 'public') {
        throw 'QStudy: инструкция требует настоящий публичный IPv4 без порта и пути.'
    }
    if ($null -eq $Route) {
        if ($null -eq (Get-Command Get-QStudyPublicAccessRoute -CommandType Function -ErrorAction SilentlyContinue)) {
            throw 'QStudy: не найден LAN-адрес компьютера. Подключите Ethernet/Wi-Fi и повторите запуск; примерный адрес подставлять нельзя.'
        }
        try { $Route = Get-QStudyPublicAccessRoute }
        catch { throw 'QStudy: не удалось определить LAN-адрес и шлюз. Проверьте Ethernet/Wi-Fi, отключите лишний VPN и повторите запуск.' }
    }
    if ($null -eq $Route -or $null -eq $Route.PSObject.Properties['client_ip'] -or $null -eq $Route.PSObject.Properties['gateway']) {
        throw 'QStudy: инструкция требует обнаруженные LAN-адрес и шлюз; примерные адреса не используются.'
    }
    $client = [string]$Route.client_ip; $gateway = [string]$Route.gateway
    if ((Get-QStudyIPv4Kind $client) -ne 'private' -or (Get-QStudyIPv4Kind $gateway) -notin @('private', 'public') -or $client -ceq $gateway) {
        throw 'QStudy: адрес компьютера или шлюза не подходит для инструкции проброса. Проверьте активное подключение Windows.'
    }
    $rootPath = [IO.Path]::GetFullPath($Root)
    if (-not (Test-Path -LiteralPath $rootPath -PathType Container)) { throw 'QStudy: папка проекта не найдена.' }
    $folder = Assert-QStudyHostPath $rootPath (Join-Path $rootPath '.local\internet-launch')
    $path = Assert-QStudyHostPath $rootPath (Join-Path $folder 'router-instructions.txt')
    $reasonInfo = Get-QStudyFriendlyNetworkReason -Reason $Reason
    $publicURL = 'http://' + $PublicIP + ':' + $Port
    $routerURL = 'http://' + $gateway
    $lines = [Collections.Generic.List[string]]::new()
    $lines.Add('QStudy — настройка доступа из интернета')
    $lines.Add('')
    $lines.Add($reasonInfo.title)
    $lines.Add($reasonInfo.detail)
    $lines.Add('')
    $lines.Add('Адрес сайта: ' + $publicURL + '/')
    $lines.Add('Адрес компьютера в Windows (LAN): ' + $client)
    $lines.Add('Роутер: ' + $routerURL + '/')
    $lines.Add('')
    if ($reasonInfo.manual_allowed) {
        $lines.Add('Сделайте один раз, команды вводить не нужно:')
        $lines.Add('1. Откройте ' + $routerURL + '/ и войдите в роутер самостоятельно. Пароль роутера в QStudy вводить не нужно.')
        $lines.Add('2. Найдите «NAT», «Переадресация портов / Port Forwarding» или «Виртуальные серверы / Virtual Servers».')
        $lines.Add('3. Добавьте и сохраните одно правило:')
        $lines.Add('   Название / Service name: QStudy')
        $lines.Add('   Внешний порт / External / WAN port: ' + $Port)
        $lines.Add('   Внутренний порт / Internal / LAN port: ' + $Port)
        $lines.Add('   IP устройства / Internal IP / Server IP: ' + $client)
        $lines.Add('   Протокол / Protocol: TCP')
        $lines.Add('   Состояние / Enabled: включено')
        $lines.Add('   Удалённый адрес / Source IP: любой (Any), если такое поле есть')
        $lines.Add('   Во внутренний IP впишите ' + $client + ', а не ' + $PublicIP + '.')
        $lines.Add('   Если этот внешний порт уже занят, сначала проверьте существующее правило; чужое правило не удаляйте.')
        $lines.Add('4. В DHCP / Address Reservation закрепите ' + $client + ' за этим компьютером, чтобы правило сохранилось после перезапуска.')
        $lines.Add('5. Вернитесь в окно запуска QStudy. Только после сохранения правила нажмите Enter для продолжения. Если ещё не настроили, выберите 0 и повторите эту же кнопку позже.')
        $lines.Add('   Запуск настроит разрешение входящего TCP ' + $Port + ' в брандмауэре Windows; примите запрос Windows на права администратора, если он появится.')
    } else {
        $lines.Add('Сначала устраните причину выше. Нажатие Enter или ручной проброс не подтвердят исправление этой проблемы.')
        if ($reasonInfo.provider_action_required) {
            $lines.Add('В статусе роутера посмотрите «Интернет / WAN IPv4». Он должен совпадать с ' + $PublicIP + '.')
            $lines.Add('Адреса 10.x.x.x, 172.16–31.x.x, 192.168.x.x и 100.64–127.x.x на WAN требуют проверки второго роутера или провайдера.')
            $lines.Add('Попросите провайдера: «Нужен публичный IPv4 на WAN моего роутера и входящие TCP-подключения на порт ' + $Port + '».')
        }
        $lines.Add('После исправления дважды щёлкните Start-QStudy-Internet.cmd снова.')
    }
    $lines.Add('')
    $lines.Add('Проверка после запуска: откройте ' + $publicURL + '/ на телефоне с выключенным Wi-Fi, через мобильный интернет.')
    $lines.Add('Открытие на самом сервере не доказывает доступность снаружи. Некоторые роутеры не открывают свой внешний IP из домашней сети; проверяйте с телефона.')
    $lines.Add('Если с телефона не открывается, проверьте правило, текущий LAN/WAN-адрес, второй роутер и ограничения входящих портов у провайдера.')
    $text = ($lines -join [Environment]::NewLine) + [Environment]::NewLine
    [IO.Directory]::CreateDirectory($folder) | Out-Null
    (Get-Item -LiteralPath $folder).SetAccessControl((New-QStudyPrivateAcl $true $folder))
    $temporary = Assert-QStudyHostPath $rootPath (Join-Path $folder ('guide-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    try {
        [IO.File]::WriteAllText($temporary, $text, [Text.UTF8Encoding]::new($true))
        (Get-Item -LiteralPath $temporary).SetAccessControl((New-QStudyPrivateAcl $false $temporary))
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    Write-Host $text
    Write-Host ('Инструкция сохранена: ' + $path)
    return [PSCustomObject]@{
        guide_path = $path; router_url = $routerURL; public_url = $publicURL; port = $Port
        client_ip = $client; gateway = $gateway; reason = $reasonInfo.code
        manual_ready = [bool]$reasonInfo.manual_allowed; provider_action_required = [bool]$reasonInfo.provider_action_required
        external_reachability_proven = $false
    }
}
