param(
    [string]$RouterWanIPv4 = '',
    [string]$Domain = '',
    [ValidateRange(0, 65535)][int]$HttpPort = 0,
    [switch]$Offline,
    [switch]$NoPause
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'QStudy.HomeNetwork.ps1')
$root = Split-Path -Parent $PSScriptRoot
$failed = $false
try {
    if ($RouterWanIPv4 -and (Get-QStudyIPv4Kind $RouterWanIPv4) -eq 'invalid') {
        throw 'RouterWanIPv4 должен быть IPv4 из раздела Internet/WAN роутера, например 100.70.1.2.'
    }
    if ($Domain) { $Domain = ConvertTo-QStudyHomeDomain $Domain }
    $adapters = @(Get-NetIPConfiguration -ErrorAction SilentlyContinue | Where-Object {
        $null -ne $_.NetAdapter -and $_.NetAdapter.Status -eq 'Up' -and $null -ne $_.IPv4DefaultGateway
    } | ForEach-Object {
        [PSCustomObject]@{ interface = $_.InterfaceAlias; ipv4 = @($_.IPv4Address.IPAddress); gateway = @($_.IPv4DefaultGateway.NextHop) }
    })
    $listeners = @()
    $checkedPorts = if ($HttpPort) { @($HttpPort) } else { @(80, 443) }
    foreach ($port in $checkedPorts) {
        $listeners += @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object {
            [PSCustomObject]@{ port = $port; address = $_.LocalAddress; processId = $_.OwningProcess }
        })
    }
    $external = ''
    $externalState = 'skipped'
    $dnsV4 = @(); $dnsV6 = @(); $dnsState = 'not_requested'
    $httpsState = 'not_requested'
    if (-not $Offline) {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        try {
            $external = [string](Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 12).ip
            if ((Get-QStudyIPv4Kind $external) -ne 'public') { throw 'Invalid public IP' }
            $externalState = 'observed'
        } catch { $external = ''; $externalState = 'unavailable' }
        if ($Domain) {
            try {
                $addresses = @([Net.Dns]::GetHostAddresses($Domain))
                $dnsV4 = @($addresses | Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork } | ForEach-Object { $_.ToString() })
                $dnsV6 = @($addresses | Where-Object { $_.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetworkV6 } | ForEach-Object { $_.ToString() })
                $dnsState = Get-QStudyDnsAssessment $dnsV4 $dnsV6 $external
            } catch { $dnsState = 'lookup_failed' }
            try {
                $health = Invoke-RestMethod -Uri ('https://' + $Domain + '/api/health') -TimeoutSec 15
                if ($health.status -eq 'ok' -and $health.service -eq 'QStudy') { $httpsState = 'qstudy_https_verified_from_this_computer' }
                else { $httpsState = 'different_service' }
            } catch { $httpsState = 'not_verified_check_from_mobile_network' }
        }
    }
    $wan = Get-QStudyWanAssessment $RouterWanIPv4 $external
    $report = [PSCustomObject]@{
        version = 1; checkedUtc = [DateTime]::UtcNow.ToString('o'); offline = [bool]$Offline
        adapters = $adapters; listeningPorts = $listeners; externalIPv4 = $external; externalIpStatus = $externalState
        routerWanIPv4 = $RouterWanIPv4; wanAssessment = $wan; domain = $Domain
        dnsIPv4 = $dnsV4; dnsIPv6 = $dnsV6; dnsAssessment = $dnsState; httpsAssessment = $httpsState
        externalReachabilityProven = $false
        publicHttpPort = $HttpPort
    }
    $reportPath = Assert-QStudyHomePath $root '.local\home-network-report.json'
    [IO.Directory]::CreateDirectory((Split-Path -Parent $reportPath)) | Out-Null
    [IO.File]::WriteAllText($reportPath, ($report | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    Write-Host 'Сеть для домашнего QStudy'
    foreach ($adapter in $adapters) { Write-Host ('LAN [' + $adapter.interface + ']: ' + ($adapter.ipv4 -join ', ') + '; роутер: ' + ($adapter.gateway -join ', ')) }
    if ($external) { Write-Host ('Внешний IPv4: ' + $external) }
    elseif (-not $Offline) { Write-Warning 'Не удалось получить внешний IPv4 через HTTPS ipify. Проверьте подключение.' }
    switch ($wan) {
        'wan_unknown' { Write-Warning 'WAN-адрес неизвестен. Внешний IP сам по себе не подтверждает белый IP. Посмотрите Internet/WAN в роутере и повторите с -RouterWanIPv4.' }
        'cgnat' { Write-Warning 'WAN находится в 100.64.0.0/10: CGNAT. Запросите публичный IPv4 у провайдера. DDNS и проброс портов сами это не исправят.' }
        'private_wan' { Write-Warning 'WAN роутера приватный: возможен второй роутер или NAT провайдера. Нужна настройка обоих роутеров либо публичный IP провайдера.' }
        'public_wan_matches' {
            $portHint = if ($HttpPort) { [string]$HttpPort } else { '80/443' }
            Write-Host ('WAN совпадает с внешним IPv4. Настройте проброс TCP ' + $portHint + ' и подтвердите доступ с мобильного интернета.')
        }
        'wan_mismatch' { Write-Warning 'WAN не совпадает с внешним IPv4. Отключите VPN для проверки и уточните NAT у провайдера; доступ ещё не подтверждён.' }
        'public_wan_unconfirmed' { Write-Warning 'WAN выглядит публичным, но внешний адрес не проверен. Подтвердите условия у провайдера.' }
        default { Write-Warning 'WAN-адрес не является обычным публичным IPv4. Проверьте адрес в роутере.' }
    }
    if ($Domain) { Write-Host ('DNS: ' + $dnsState + '; HTTPS: ' + $httpsState) }
    if ($dnsV6.Count -gt 0) { Write-Warning 'Есть AAAA. Проверьте доступность IPv6; ошибочная запись может помешать HTTPS. IPv4-проверка не проверяет IPv6.' }
    if ($HttpPort) {
        Write-Host ('Для HTTP IP:port нужен проброс и firewall только TCP ' + $HttpPort + '. Роутер и firewall не изменены.')
        Write-Host ('Внешняя проверка: телефон с выключенным Wi-Fi, http://БЕЛЫЙ_IP:' + $HttpPort + '/.')
    } else {
        Write-Host 'Роутер и firewall не изменены. Для HTTPS открывайте наружу только TCP 80 и 443.'
        Write-Host 'Обязательная внешняя проверка: телефон с выключенным Wi-Fi, https://ВАШ-ДОМЕН/.'
    }
    Write-Host ('Отчёт: ' + $reportPath)
} catch {
    $failed = $true
    Write-Host ('Ошибка диагностики: ' + $_.Exception.Message) -ForegroundColor Red
}
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
