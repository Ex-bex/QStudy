param(
    [ValidateSet('help', 'configure', 'update', 'status', 'install-autostart', 'remove-autostart')]
    [string]$Action = 'help',
    [string]$Domain = '',
    [switch]$NoPause
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'QStudy.HomeNetwork.ps1')
$script:QStudyDuckRoot = Split-Path -Parent $PSScriptRoot

function ConvertTo-QStudyDuckLabel([string]$Value) {
    $label = $Value.Trim().ToLowerInvariant()
    if ($label.EndsWith('.duckdns.org')) { $label = $label.Substring(0, $label.Length - 12) }
    if ($label -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$') {
        throw 'Укажите только свой поддомен DuckDNS: example или example.duckdns.org.'
    }
    return $label
}

function Set-QStudyDuckPrivateAcl([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Ссылки в папке секретов запрещены.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid = $identity.User } finally { $identity.Dispose() }
    $acl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($existingRule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($existingRule) }
    $acl.SetOwner($sid)
    foreach ($allowed in @($sid, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $rule = if ($item.PSIsContainer) {
            [Security.AccessControl.FileSystemAccessRule]::new($allowed, [Security.AccessControl.FileSystemRights]::FullControl,
                ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
                [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        } else {
            [Security.AccessControl.FileSystemAccessRule]::new($allowed, [Security.AccessControl.FileSystemRights]::FullControl,
                [Security.AccessControl.AccessControlType]::Allow)
        }
        $acl.AddAccessRule($rule)
    }
    # Persist only the modified owner/DACL; writing a fresh audit descriptor
    # with Set-Acl can require an unnecessary SeSecurityPrivilege elevation.
    $item.SetAccessControl($acl)
}

function Get-QStudyDuckConfigurationPath { return Assert-QStudyHomePath $script:QStudyDuckRoot '.local\secrets\duckdns.json' }

function Save-QStudyDuckConfiguration([string]$Label, [Security.SecureString]$Token) {
    $Label = ConvertTo-QStudyDuckLabel $Label
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
    try {
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($plain -notmatch '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'Token DuckDNS должен иметь формат UUID. Возьмите его из своего аккаунта DuckDNS.' }
    } finally { $plain = $null; [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $path = Get-QStudyDuckConfigurationPath
    $directory = Split-Path -Parent $path
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    Set-QStudyDuckPrivateAcl $directory
    $configuration = [PSCustomObject]@{ version = 1; label = $Label; protectedToken = (ConvertFrom-SecureString $Token) }
    $temporary = Assert-QStudyHomePath $script:QStudyDuckRoot ('.local\secrets\duckdns-' + [Guid]::NewGuid().ToString('N') + '.pending.json')
    try {
        [IO.File]::WriteAllText($temporary, ($configuration | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        Set-QStudyDuckPrivateAcl $temporary
        [void](Get-QStudyDuckConfigurationPath)
        Move-Item -LiteralPath $temporary -Destination $path -Force
        Set-QStudyDuckPrivateAcl $path
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}

function Read-QStudyDuckConfiguration {
    $path = Get-QStudyDuckConfigurationPath
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Сначала выполните Manage-QStudy-DuckDNS.cmd configure -Domain ВАШ-ПОДДОМЕН.' }
    Set-QStudyDuckPrivateAcl (Split-Path -Parent $path)
    Set-QStudyDuckPrivateAcl $path
    try {
        $configuration = [IO.File]::ReadAllText($path) | ConvertFrom-Json
        if ($configuration.version -ne 1) { throw 'Version' }
        $label = ConvertTo-QStudyDuckLabel ([string]$configuration.label)
        $token = ConvertTo-SecureString ([string]$configuration.protectedToken)
        return [PSCustomObject]@{ label = $label; token = $token }
    } catch { throw 'Токен не прочитан. После переноса на другой ПК или смены пользователя выполните configure заново; токен зашифрован Windows DPAPI.' }
}

function New-QStudyDuckUpdateUri([string]$Label, [string]$Token, [string]$IPv4) {
    $label = ConvertTo-QStudyDuckLabel $Label
    if ($Token -notmatch '^[a-fA-F0-9]{8}(?:-[a-fA-F0-9]{4}){3}-[a-fA-F0-9]{12}$') { throw 'Некорректный формат токена.' }
    if ((Get-QStudyIPv4Kind $IPv4) -ne 'public') { throw 'Для DDNS нужен публичный IPv4.' }
    return [Uri]('https://www.duckdns.org/update?domains=' + [Uri]::EscapeDataString($label) +
        '&token=' + [Uri]::EscapeDataString($Token) + '&ip=' + [Uri]::EscapeDataString($IPv4))
}

function New-QStudyDuckHttpClient {
    Add-Type -AssemblyName System.Net.Http
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $client = [Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromSeconds(15)
    return $client
}

function Invoke-QStudyDuckHttps([Uri]$Uri) {
    $client = New-QStudyDuckHttpClient
    $response = $null
    try {
        $response = $client.GetAsync($Uri).GetAwaiter().GetResult()
        if (-not $response.IsSuccessStatusCode) { throw 'HTTP_FAILURE' }
        $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if ($text.Length -gt 64 -or $text.Trim() -cne 'OK') { throw 'UPDATE_REJECTED' }
    } catch {
        # The documented API carries its token in the HTTPS query. Never print
        # the request URI, response body or original network exception.
        throw 'DuckDNS не подтвердил обновление. Проверьте интернет, поддомен и токен; секреты не выводились.'
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $client.Dispose()
    }
}

function Update-QStudyDuckDns {
    $configuration = Read-QStudyDuckConfiguration
    $pointer = [IntPtr]::Zero
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
        try { $ip = [string](Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 12).ip }
        catch { throw 'Не удалось определить внешний IPv4 через HTTPS ipify. DDNS не изменён.' }
        if ((Get-QStudyIPv4Kind $ip) -ne 'public') { throw 'Внешний IPv4 не подтверждён. DDNS не изменён.' }
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($configuration.token)
        $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        $uri = New-QStudyDuckUpdateUri $configuration.label $plain $ip
        Invoke-QStudyDuckHttps $uri
        $statusPath = Assert-QStudyHomePath $script:QStudyDuckRoot '.local\duckdns-status.json'
        $status = [PSCustomObject]@{ updatedUtc = [DateTime]::UtcNow.ToString('o'); domain = ($configuration.label + '.duckdns.org'); ipv4 = $ip; confirmedByDuckDns = $true }
        [IO.File]::WriteAllText($statusPath, ($status | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
        Write-Host ('DuckDNS подтвердил IPv4 для https://' + $configuration.label + '.duckdns.org. Это не подтверждение доступности сайта снаружи.')
    } finally {
        $plain = $null; $uri = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $configuration.token.Dispose()
    }
}

function Get-QStudyDuckTaskDefinition {
    $path = Assert-QStudyHomePath $script:QStudyDuckRoot 'scripts\Manage-QStudyDuckDNS.ps1'
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $ownerSid = $identity.User.Value } finally { $identity.Dispose() }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $suffix = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($path.ToLowerInvariant() + '|' + $ownerSid)))).Replace('-', '').Substring(0, 12) }
    finally { $sha.Dispose() }
    return [PSCustomObject]@{
        name = ('QStudy-DuckDNS-' + $suffix)
        executable = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
        arguments = ('-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $path + '" update -NoPause')
    }
}

function Assert-QStudyDuckTaskOwned($Task, $Definition) {
    if ($null -eq $Task) { return }
    $actions = @($Task.Actions)
    if ($actions.Count -ne 1 -or $actions[0].Execute -ine $Definition.executable -or
        $actions[0].Arguments -cne $Definition.arguments) { throw 'Имя задачи занято чужой командой. Чужая задача не изменена.' }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try { $sid = $identity.User.Value } finally { $identity.Dispose() }
    try {
        $taskOwner = [string]$Task.Principal.UserId
        $taskSid = if ($taskOwner -match '^S-1-') { $taskOwner } else {
            ([Security.Principal.NTAccount]::new($taskOwner)).Translate([Security.Principal.SecurityIdentifier]).Value
        }
    } catch { throw 'Владелец задачи не подтверждён. Она не изменена.' }
    if ($taskSid -ine $sid) { throw 'Задача принадлежит другому пользователю. Она не изменена.' }
}

function Invoke-QStudyDuckMain {
    if ($Domain -and $Action -ne 'configure') { throw '-Domain используется только при configure; другие команды используют сохранённый домен.' }
    switch ($Action) {
        'help' {
            Write-Host 'Manage-QStudy-DuckDNS.cmd configure -Domain ВАШ-ПОДДОМЕН'
            Write-Host 'Manage-QStudy-DuckDNS.cmd update | status | install-autostart | remove-autostart'
            Write-Host 'Токен вводится скрыто только при configure. Расписание обновляет IPv4 раз в 5 минут после входа в Windows.'
            return
        }
        'configure' {
            if (-not $Domain) { $script:Domain = Read-Host 'Ваш уже созданный поддомен DuckDNS' }
            $label = ConvertTo-QStudyDuckLabel $Domain
            $token = Read-Host 'Token из вашего аккаунта DuckDNS (ввод скрыт)' -AsSecureString
            try { Save-QStudyDuckConfiguration $label $token } finally { $token.Dispose() }
            Update-QStudyDuckDns
            Write-Host 'Теперь выполните install-autostart из этой же учётной записи Windows.'
        }
        'update' { Update-QStudyDuckDns }
        'status' {
            $configuration = Read-QStudyDuckConfiguration
            try { Write-Host ('Настроен: ' + $configuration.label + '.duckdns.org; токен зашифрован для текущего пользователя Windows.') }
            finally { $configuration.token.Dispose() }
            $definition = Get-QStudyDuckTaskDefinition
            $task = Get-ScheduledTask -TaskName $definition.name -TaskPath '\' -ErrorAction SilentlyContinue
            if ($null -ne $task) { Assert-QStudyDuckTaskOwned $task $definition; Write-Host ('Автообновление: ' + $task.State) }
            else { Write-Host 'Автообновление не установлено.' }
        }
        'install-autostart' {
            $configuration = Read-QStudyDuckConfiguration
            $configuration.token.Dispose()
            $definition = Get-QStudyDuckTaskDefinition
            $existing = Get-ScheduledTask -TaskName $definition.name -TaskPath '\' -ErrorAction SilentlyContinue
            Assert-QStudyDuckTaskOwned $existing $definition
            $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
            try { $sid = $identity.User.Value } finally { $identity.Dispose() }
            $action = New-ScheduledTaskAction -Execute $definition.executable -Argument $definition.arguments
            $triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $sid), (New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval ([TimeSpan]::FromMinutes(5))))
            $principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
            $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::FromMinutes(2)) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
            Register-ScheduledTask -TaskName $definition.name -TaskPath '\' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
            Write-Host 'DuckDNS будет обновляться после входа в Windows и каждые 5 минут. Пароль учётной записи не сохраняется.'
        }
        'remove-autostart' {
            $definition = Get-QStudyDuckTaskDefinition
            $existing = Get-ScheduledTask -TaskName $definition.name -TaskPath '\' -ErrorAction SilentlyContinue
            if ($null -ne $existing) { Assert-QStudyDuckTaskOwned $existing $definition; Unregister-ScheduledTask -TaskName $definition.name -TaskPath '\' -Confirm:$false }
            Write-Host 'Автообновление этой установки удалено; настройки DuckDNS сохранены.'
        }
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $failed = $false
    try { Invoke-QStudyDuckMain }
    catch { $failed = $true; Write-Host ('Ошибка DuckDNS: ' + $_.Exception.Message) -ForegroundColor Red }
    if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
    if ($failed) { exit 1 }
    exit 0
}
