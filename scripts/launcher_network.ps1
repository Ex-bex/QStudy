param(
    [Alias('Action')][ValidateSet('Library', 'EnableFirewall', 'DisableFirewall')][string]$NetworkAction = 'Library',
    [Alias('Root')][string]$NetworkRoot = '', [Alias('Port')][int]$NetworkPort = 0,
    [Alias('OwnerSid')][string]$NetworkOwnerSid = '', [Alias('Nonce')][string]$NetworkNonce = ''
)

# The native launcher shares only the audited router primitives with the optional
# Docker deployment. No Docker configuration or database is read here.
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'QStudy.HomeNetwork.ps1')
. (Join-Path $PSScriptRoot 'production\QStudy.WindowsHost.ps1')
. (Join-Path $PSScriptRoot 'production\QStudy.PortMapping.ps1')

function Get-QStudyNativeNetworkSpec([string]$Root, [int]$Port) {
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'Некорректный TCP-порт QStudy.' }
    $rootPath = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $id = ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($rootPath.ToLowerInvariant() + ':' + $sid)))).Replace('-', '').Substring(0, 16) }
    finally { $hash.Dispose() }
    [pscustomobject]@{
        root = $rootPath; sid = $sid; port = $Port
        rule = 'QStudy-Native-' + $id + '-' + $Port
        description = 'QStudy native: ' + $rootPath + '; owner=' + $sid + '; tcp=' + $Port
        mapping_description = 'QStudy-Native-' + $id
    }
}

function Get-QStudyNativeRoute {
    $candidates = @()
    foreach ($route in @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop)) {
        if (-not $route.NextHop -or $route.NextHop -eq '0.0.0.0') { continue }
        $adapter = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop
        if ([string]$adapter.ConnectionState -ne 'Connected') { continue }
        foreach ($address in @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop)) {
            if ([string]$address.AddressState -ne 'Preferred' -or $address.SkipAsSource -or (Get-QStudyIPv4Kind $address.IPAddress) -notin @('private', 'public')) { continue }
            $candidates += [pscustomobject]@{ client_ip = [string]$address.IPAddress; gateway = [string]$route.NextHop; metric = [int]$route.RouteMetric + [int]$adapter.InterfaceMetric }
        }
    }
    $selected = $candidates | Sort-Object metric | Select-Object -First 1
    if ($null -eq $selected -or (Get-QStudyIPv4Kind $selected.gateway) -notin @('private', 'public')) { throw 'Не найдены IPv4 компьютера и шлюз. Проверьте Ethernet/Wi-Fi и VPN.' }
    return $selected
}

function Get-QStudyNativePublicIP {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    foreach ($uri in @('https://api.ipify.org?format=json', 'https://api4.ipify.org?format=json')) {
        try {
            $value = [string](Invoke-RestMethod -Uri $uri -TimeoutSec 10 -ErrorAction Stop).ip
            if ((Get-QStudyIPv4Kind $value) -eq 'public') { return $value }
        } catch { }
    }
    throw 'Не удалось определить внешний IPv4. Проверьте интернет и VPN, затем повторите ту же кнопку.'
}

function Get-QStudyNativeNetworkContext {
    param([string]$Root, [ValidateSet('local', 'lan', 'internet')][string]$Mode, [int]$Port)
    $null = Get-QStudyNativeNetworkSpec $Root $Port
    if ($Mode -eq 'local') { return [pscustomobject]@{ public_ip = ''; lan_ip = ''; gateway = ''; site_url = 'http://127.0.0.1:' + $Port; bind = '127.0.0.1' } }
    $route = Get-QStudyNativeRoute
    $public = if ($Mode -eq 'internet') { Get-QStudyNativePublicIP } else { '' }
    $hostIP = if ($Mode -eq 'internet') { $public } else { $route.client_ip }
    [pscustomobject]@{ public_ip = $public; lan_ip = $route.client_ip; gateway = $route.gateway; site_url = 'http://' + $hostIP + ':' + $Port; bind = '0.0.0.0' }
}

function Read-QStudyNativeNetworkState([string]$Root) {
    $path = Assert-QStudyHostPath $Root (Join-Path $Root '.local\launcher\network.json')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    if ((Get-Item -LiteralPath $path).Length -gt 65536) { throw 'Слишком большой файл состояния сети.' }
    $state = [IO.File]::ReadAllText($path) | ConvertFrom-Json
    $spec = Get-QStudyNativeNetworkSpec $Root ([int]$state.port)
    # Copying the project must not grant authority over another machine's rules.
    if ($state.version -ne 1 -or $state.root -cne $spec.root -or $state.owner_sid -cne $spec.sid -or $state.computer -cne [Environment]::MachineName) { return $null }
    return $state
}

function Save-QStudyNativeNetworkJson([string]$Root, [string]$Name, $Value) {
    if ($Name -notmatch '^(network|firewall-[a-f0-9]{32})\.json$') { throw 'Неверное имя служебного отчёта.' }
    $folder = Assert-QStudyHostPath $Root (Join-Path $Root '.local\launcher')
    [void][IO.Directory]::CreateDirectory($folder)
    (Get-Item -LiteralPath $folder).SetAccessControl((New-QStudyPrivateAcl $true $folder))
    $path = Assert-QStudyHostPath $Root (Join-Path $folder $Name)
    $temp = $path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
    try {
        [IO.File]::WriteAllText($temp, ($Value | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        (Get-Item -LiteralPath $temp).SetAccessControl((New-QStudyPrivateAcl $false $temp))
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temp, $path, [NullString]::Value) } else { [IO.File]::Move($temp, $path) }
    } finally { if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force } }
}

function Test-QStudyNativeFirewallOwned($Rule, $Spec) {
    if ($Rule.Name -cne $Spec.rule -or $Rule.Description -cne $Spec.description -or [string]$Rule.Direction -ne 'Inbound' -or [string]$Rule.Action -ne 'Allow') { return $false }
    $filters = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    return $filters.Count -eq 1 -and [string]$filters[0].Protocol -in @('TCP', '6') -and [string]$filters[0].LocalPort -ceq [string]$Spec.port
}

function Set-QStudyNativeFirewallRule([string]$Root, [int]$Port, [bool]$Enable) {
    $spec = Get-QStudyNativeNetworkSpec $Root $Port
    $rules = @(Get-NetFirewallRule -Name $spec.rule -ErrorAction SilentlyContinue)
    if ($rules.Count -gt 1 -or ($rules.Count -and -not (Test-QStudyNativeFirewallOwned $rules[0] $spec))) { throw 'Имя правила брандмауэра занято чужой настройкой. Она оставлена без изменений.' }
    if (-not $Enable) { if ($rules.Count) { $rules[0] | Remove-NetFirewallRule -ErrorAction Stop }; return }
    if ($rules.Count) { $rules[0] | Set-NetFirewallRule -Enabled True -Profile Any -RemoteAddress Any -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null }
    else { New-NetFirewallRule -Name $spec.rule -DisplayName ('QStudy TCP ' + $Port) -Description $spec.description -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress Any -Profile Any -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null }
}

function Invoke-QStudyNativeFirewall([string]$Root, [int]$Port, [bool]$Enable) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [Security.Principal.WindowsPrincipal]::new($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { Set-QStudyNativeFirewallRule $Root $Port $Enable; return }
    $spec = Get-QStudyNativeNetworkSpec $Root $Port
    $existing = @(Get-NetFirewallRule -Name $spec.rule -ErrorAction SilentlyContinue)
    if ($Enable -and $existing.Count -eq 1 -and (Test-QStudyNativeFirewallOwned $existing[0] $spec) -and [string]$existing[0].Enabled -eq 'True') { return }
    if (-not $Enable -and $existing.Count -eq 0) { return }
    $nonce = [Guid]::NewGuid().ToString('N')
    $requested = [DateTimeOffset]::UtcNow
    $operation = if ($Enable) { 'EnableFirewall' } else { 'DisableFirewall' }
    $scriptPath = Assert-QStudyHostPath $Root (Join-Path $Root 'scripts\launcher_network.ps1')
    # Quotes cannot appear in Windows filenames. Arguments contain no user code.
    $arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $scriptPath + '" -Action ' + $operation + ' -Root "' + $spec.root + '" -Port ' + $Port + ' -OwnerSid ' + $spec.sid + ' -Nonce ' + $nonce
    Write-Host ('Windows запросит разрешение изменить только правило QStudy TCP ' + $Port + '. Используйте этот же аккаунт Windows.')
    try { $child = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $arguments -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop }
    catch { throw 'Windows не разрешила настройку брандмауэра. Примите запрос UAC при повторном запуске.' }
    if (-not $child.WaitForExit(45000)) { throw 'Окно разрешения Windows ещё не завершено. Подтвердите его и повторите запуск.' }
    $child.Refresh()
    if ($child.ExitCode -eq 3) { throw 'В запросе UAC выбран другой аккаунт Windows. Запустите QStudy из аккаунта администратора Windows и подтвердите UAC этим же аккаунтом. Настройки и права файлов не изменены.' }
    $reportPath = Assert-QStudyHostPath $Root (Join-Path $Root ('.local\launcher\firewall-' + $nonce + '.json'))
    if (-not (Test-Path -LiteralPath $reportPath -PathType Leaf) -or (Get-Item -LiteralPath $reportPath).Length -gt 16384) { throw 'Не получен результат настройки брандмауэра Windows.' }
    $report = [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
    if ($report.nonce -cne $nonce -or $report.owner_sid -cne $spec.sid -or $report.root -cne $spec.root -or $report.action -cne $operation -or [DateTimeOffset]::Parse($report.checked_utc) -lt $requested.AddSeconds(-1)) { throw 'Отчёт настройки Windows не соответствует текущему запуску.' }
    if (-not $report.ok) { throw ('Брандмауэр QStudy: ' + [string]$report.message) }
    Remove-Item -LiteralPath $reportPath -Force
}

function Assert-QStudyNativeListener([string]$Root, [int]$Port) {
    $path = Assert-QStudyHostPath $Root (Join-Path $Root '.local\launcher\state.json')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Не найден запущенный экземпляр QStudy. Правила сети не изменены.' }
    $state = [IO.File]::ReadAllText($path) | ConvertFrom-Json
    $spec = Get-QStudyNativeNetworkSpec $Root $Port
    if ($state.root -cne $spec.root -or $state.owner_sid -cne $spec.sid -or [int]$state.frontend_port -ne $Port -or [string]$state.bind -ne '0.0.0.0') { throw 'Настройка сети не соответствует запущенному QStudy.' }
    $child = $state.frontend
    if ($null -eq $child) { throw 'Frontend QStudy ещё не запущен.' }
    $process = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + [int]$child.pid) -ErrorAction Stop
    if ($null -eq $process -or -not [string]::Equals($process.ExecutablePath, [string]$child.exe, [StringComparison]::OrdinalIgnoreCase) -or
        [Math]::Abs(($process.CreationDate.ToUniversalTime() - [DateTimeOffset]::Parse([string]$child.created).UtcDateTime).TotalSeconds) -gt 0.01 -or
        -not $process.CommandLine.Contains([string]$state.instance) -or -not $process.CommandLine.Contains([string]$child.marker)) { throw 'Владение процессом QStudy не подтверждено; чужой порт не открыт.' }
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0 -or @($listeners | Where-Object { [int]$_.OwningProcess -ne [int]$child.pid }).Count -gt 0) { throw 'Этот TCP-порт не принадлежит запущенному QStudy.' }
}

function Write-QStudyNativeRouterGuide([string]$Root, $Context, [int]$Port, [string]$Reason) {
    $text = @"
QStudy — сайт запущен, внешняя доступность ещё не подтверждена.
Адрес: $($Context.site_url)/
Причина: $Reason

Один раз откройте http://$($Context.gateway)/ и войдите в роутер.
NAT / Переадресация портов / Виртуальный сервер → правило QStudy:
  Протокол TCP; внешний порт $Port; внутренний порт $Port;
  IP компьютера: $($Context.lan_ip); включено.
Закрепите этот LAN-IP в DHCP / Address Reservation за компьютером.
Не указывайте внешний IP в поле внутреннего IP устройства.
Если правило уже настроено точно так, создавать второе не нужно.

WAN IPv4 в статусе роутера должен совпадать с $($Context.public_ip).
Если WAN имеет вид 10.x, 172.16–31.x, 192.168.x или 100.64–127.x,
уточните у провайдера белый IPv4 и входящий TCP $Port (либо второй роутер).
QStudy не может изменить правила провайдера без доступа к роутеру.

Проверьте адрес на телефоне через мобильный интернет с выключенным Wi-Fi.
Открытие на самом сервере не подтверждает доступ снаружи. Роутер может
не поддерживать открытие своего внешнего IP из домашней сети.
После настройки повторите Start-QStudy-Internet.cmd; данные сохранятся.
"@
    $path = Assert-QStudyHostPath $Root (Join-Path $Root '.local\launcher\router-instructions.txt')
    [IO.File]::WriteAllText($path, $text, [Text.UTF8Encoding]::new($true))
    Write-Host $text
    Write-Host ('Инструкция: ' + $path)
}

function Set-QStudyNativeNetwork {
    param([string]$Root, [ValidateSet('local', 'lan', 'internet')][string]$Mode, [int]$Port, [string]$PublicIP = '', [string]$SiteUrl = '')
    if ($Mode -eq 'local') { return }
    if ($Mode -eq 'internet' -and ((Get-QStudyIPv4Kind $PublicIP) -ne 'public' -or $SiteUrl -cne ('http://' + $PublicIP + ':' + $Port))) { throw 'Публичный адрес не соответствует текущему IPv4 и порту.' }
    Assert-QStudyNativeListener $Root $Port
    $spec = Get-QStudyNativeNetworkSpec $Root $Port
    $route = Get-QStudyNativeRoute
    $previous = Read-QStudyNativeNetworkState $Root
    if ($null -ne $previous -and ($previous.port -ne $Port -or $previous.client_ip -cne $route.client_ip -or $previous.public_ip -cne $PublicIP)) { Disable-QStudyNativeNetwork $Root; $previous = Read-QStudyNativeNetworkState $Root }
    elseif ($null -ne $previous -and $null -ne $previous.PSObject.Properties['cleanup_pending'] -and $previous.cleanup_pending) { Disable-QStudyNativeNetwork $Root; $previous = Read-QStudyNativeNetworkState $Root }
    if ($Mode -eq 'internet' -and $null -ne $previous -and $null -ne $previous.PSObject.Properties['cleanup_pending'] -and $previous.cleanup_pending) {
        Write-Host ('Прежнее правило QStudy TCP ' + $previous.port + ' на роутере ' + $previous.gateway + ' → ' + $previous.client_ip + ':' + $previous.port + ' требует ручной проверки. Брандмауэр прежнего режима закрыт.')
        $answer = Read-Host 'Удалите именно это прежнее правило на старом роутере. 1 — я проверил и удалил; 0 — оставить интернет выключенным'
        if ($answer -cne '1') { throw 'Настройка интернета остановлена до проверки прежнего правила. Локальный запуск доступен; данные сохранены.' }
        $previous.cleanup_pending = $false; $previous.method = 'none'; $previous.record = $null
        Save-QStudyNativeNetworkJson $Root 'network.json' $previous
    }
    $sameContext = $null -ne $previous -and $previous.port -eq $Port -and $previous.client_ip -ceq $route.client_ip -and $previous.public_ip -ceq $PublicIP
    $oldRecord = if ($sameContext -and $previous.method -eq 'upnp') { $previous.record } else { $null }
    $state = [ordered]@{ version = 1; root = $spec.root; owner_sid = $spec.sid; computer = [Environment]::MachineName; port = $Port; mode = $Mode; public_ip = $PublicIP; client_ip = $route.client_ip; gateway = $route.gateway; method = $(if ($null -ne $oldRecord) { 'upnp' } else { 'none' }); record = $oldRecord; enabled = $true; external_reachability_proven = $false; checked_utc = [DateTimeOffset]::UtcNow.ToString('o') }
    # Persist firewall ownership before touching the router, so cleanup is possible
    # even when UPnP is unsupported or the program is interrupted.
    Save-QStudyNativeNetworkJson $Root 'network.json' $state
    # The ownership ledger must be durable before opening the host. If saving it
    # fails, no firewall mutation occurs; a partly failed UAC operation is tracked.
    Invoke-QStudyNativeFirewall $Root $Port $true
    if ($Mode -eq 'internet') {
        $result = Enable-QStudyUpnpPort -Gateway $route.gateway -ClientIP $route.client_ip -PublicIP $PublicIP -Port $Port -Description $spec.mapping_description -PreviousRecord $oldRecord
        if ($result.ok) { $state.method = 'upnp'; $state.record = $result.record; Write-Host 'Проброс UPnP настроен. Доступ из интернета проверьте с телефона через мобильную сеть.' }
        elseif ($result.status -eq 'wan_mismatch') { Write-Host 'WAN роутера не совпадает с внешним IPv4. Проверьте CGNAT, VPN или второй роутер.' }
        else { Write-Host 'Роутер не подтвердил автоматический проброс; показана точная ручная настройка.' }
        Save-QStudyNativeNetworkJson $Root 'network.json' $state
        Write-QStudyNativeRouterGuide $Root ([pscustomobject]@{ site_url = $SiteUrl; gateway = $route.gateway; lan_ip = $route.client_ip; public_ip = $PublicIP }) $Port ([string]$result.status)
    }
}

function Disable-QStudyNativeNetwork {
    param([string]$Root)
    $state = Read-QStudyNativeNetworkState $Root
    if ($null -eq $state) { return }
    $pending = $null -ne $state.PSObject.Properties['cleanup_pending'] -and $state.cleanup_pending
    if (-not $state.enabled -and -not $pending) { return }
    $spec = Get-QStudyNativeNetworkSpec $Root ([int]$state.port)
    # Close the host first, even if the old router can no longer be reached.
    Invoke-QStudyNativeFirewall $Root ([int]$state.port) $false
    $state.enabled = $false
    $state | Add-Member -NotePropertyName cleanup_pending -NotePropertyValue ($state.method -eq 'upnp' -and $null -ne $state.record) -Force
    Save-QStudyNativeNetworkJson $Root 'network.json' $state
    if ($state.method -eq 'upnp' -and $null -ne $state.record) {
        # A dynamic public IP may have changed while the installation's exact
        # router rule still belongs to us. Reconfirm the current router/client
        # and actual mapping, then permit only that matching rule's deletion.
        try { $route = Get-QStudyNativeRoute }
        catch { Write-Warning 'Роутер временно недоступен. Брандмауэр QStudy закрыт; прежний проброс сохранён для проверки при следующем интернет-запуске.'; return }
        if ($route.gateway -cne $state.gateway -or $route.client_ip -cne $state.client_ip) {
            $state | Add-Member -NotePropertyName cleanup_pending -NotePropertyValue $true -Force
            Save-QStudyNativeNetworkJson $Root 'network.json' $state
            Write-Warning 'Сеть изменилась. Брандмауэр закрыт; проверьте прежнее правило QStudy на старом роутере. Локальный запуск доступен; перед следующим интернет-запуском потребуется подтвердить удаление старого правила.'
            return
        }
        $record = $state.record; $public = [string]$state.public_ip
        try {
            $collection = Get-QStudyUpnpCollection
            $mapping = if ($null -ne $collection) { Find-QStudyUpnpPort $collection ([int]$state.port) } else { $null }
            if ($null -ne $mapping -and (Test-QStudyOwnedUpnpPort $mapping $state.port $state.client_ip $spec.mapping_description)) {
                $observed = Get-QStudyUpnpPublicIP $mapping
                if ((Get-QStudyIPv4Kind $observed) -eq 'public' -and $observed -cne $public) {
                    $public = $observed
                    $record = New-QStudyPortRecord 'upnp' $state.gateway $state.client_ip $public $state.port $spec.mapping_description
                }
            }
        } catch { }
        $result = Disable-QStudyUpnpPort -Gateway $state.gateway -ClientIP $state.client_ip -PublicIP $public -Port $state.port -Description $spec.mapping_description -PreviousRecord $record
        if (-not $result.ok) {
            $state | Add-Member -NotePropertyName cleanup_pending -NotePropertyValue $true -Force
            Save-QStudyNativeNetworkJson $Root 'network.json' $state
            Write-Warning 'Прежний проброс QStudy не удалось удалить. Брандмауэр закрыт; локальный запуск доступен. Проверьте старое правило перед повторным интернет-запуском.'
            return
        }
        $state.method = 'none'; $state.record = $null; $state.cleanup_pending = $false
    }
    $state.enabled = $false
    Save-QStudyNativeNetworkJson $Root 'network.json' $state
}

if ($NetworkAction -ne 'Library') {
    # A different administrator must not take ownership of the original user's
    # private launcher folder merely to report a rejected UAC operation.
    if ($NetworkOwnerSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { exit 3 }
    $ok = $false; $message = ''
    try {
        if ($NetworkNonce -notmatch '^[a-f0-9]{32}$') { throw 'Неверный идентификатор операции.' }
        $spec = Get-QStudyNativeNetworkSpec $NetworkRoot $NetworkPort
        if ($NetworkOwnerSid -cne $spec.sid) { throw 'Нужен тот же Windows-аккаунт, которым запущен QStudy.' }
        if ($NetworkAction -eq 'EnableFirewall') { Assert-QStudyNativeListener $NetworkRoot $NetworkPort }
        else {
            $previous = Read-QStudyNativeNetworkState $NetworkRoot
            if ($null -eq $previous -or [int]$previous.port -ne $NetworkPort) { throw 'Нет записи о собственном правиле этого запуска.' }
        }
        Set-QStudyNativeFirewallRule $NetworkRoot $NetworkPort ($NetworkAction -eq 'EnableFirewall')
        $ok = $true
    } catch { $message = $_.Exception.Message }
    if ($NetworkRoot -and $NetworkNonce -match '^[a-f0-9]{32}$') { Save-QStudyNativeNetworkJson $NetworkRoot ('firewall-' + $NetworkNonce + '.json') ([ordered]@{ ok = $ok; message = $message; root = [IO.Path]::GetFullPath($NetworkRoot).TrimEnd('\', '/'); owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; nonce = $NetworkNonce; action = $NetworkAction; checked_utc = [DateTimeOffset]::UtcNow.ToString('o') }) }
    if ($ok) { exit 0 } else { exit 1 }
}
