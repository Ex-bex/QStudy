param(
    [string]$Domain = '',
    [string]$Email = '',
    [string]$RouterWanIPv4 = '',
    [switch]$Prepare,
    [switch]$Start,
    [switch]$EnableAutostart,
    [switch]$SkipPrivateSettings,
    [switch]$NoPause
)
. (Join-Path $PSScriptRoot 'QStudy.HostSetup.ps1')
. (Join-Path $PSScriptRoot '..\QStudy.HomeNetwork.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$manager = Join-Path $PSScriptRoot 'Manage-QStudy.ps1'
$failed = $false

function Invoke-HostManager([string]$Action, [hashtable]$Options = @{}) {
    & $manager -Action $Action @Options
    if ($LASTEXITCODE -ne 0) { throw 'Операция хоста не завершилась. Исправьте указанную выше причину и повторите запуск.' }
}

function Read-PrivateHostValue([string]$Prompt) {
    $secure = Read-Host $Prompt -AsSecureString
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $secure.Dispose() }
}

try {
    if ($EnableAutostart -and -not $Start) { throw '-EnableAutostart используйте вместе с -Start после подготовки данных и сети.' }
    if ($Prepare -and $Start) { throw 'Используйте -Prepare для приватной подготовки или -Start после переноса данных; эти режимы выполняются отдельно.' }
    Write-Host 'QStudy: настройка Windows-хоста с белым IPv4 и своим доменом'
    Write-Host 'Инструкция: docs/friend-hosting.md. Настройки сохраняются приватно на этом компьютере.'
    $existing = Read-QStudyHostEnvironment $root
    if (-not $Domain -and $existing.ContainsKey('QSTUDY_DOMAIN')) { $Domain = $existing['QSTUDY_DOMAIN'] }
    if (-not $Email -and $existing.ContainsKey('ACME_EMAIL')) { $Email = $existing['ACME_EMAIL'] }
    if (-not $Domain) { $Domain = Read-Host 'Домен сайта без https:// и пути (например study.example.org)' }
    $Domain = ConvertTo-QStudyHomeDomain $Domain
    if (-not $Email) { $Email = Read-Host 'Email владельца для уведомлений о HTTPS-сертификате' }
    Invoke-HostManager 'init' @{ Domain = $Domain; Email = $Email }
    if (-not $SkipPrivateSettings) {
        $settings = @{}
        Write-Host 'Enter в следующих двух вопросах сохраняет имеющиеся настройки.'
        if ((Read-Host 'Настроить SMTP для восстановления паролей сейчас? [y/Enter]') -eq 'y') {
            $settings['SMTP_HOST'] = Read-Host 'SMTP сервер'
            $port = Read-Host 'SMTP порт [587]'; if (-not $port) { $port = '587' }
            $settings['SMTP_PORT'] = $port
            $security = Read-Host 'Шифрование starttls или ssl [starttls]'; if (-not $security) { $security = 'starttls' }
            $settings['SMTP_SECURITY'] = $security
            $settings['SMTP_USERNAME'] = Read-Host 'SMTP аккаунт'
            $settings['SMTP_FROM'] = Read-Host 'Email отправителя'
            $settings['SMTP_PASSWORD'] = Read-PrivateHostValue 'Пароль SMTP / пароль приложения (скрытый ввод)'
            $settings['RECOVERY_DELIVERY'] = 'smtp'
        }
        if ((Read-Host 'Указать ключ Gemini для ИИ сейчас? [y/Enter]') -eq 'y') { $settings['GEMINI_API_KEY'] = Read-PrivateHostValue 'Ключ Gemini (скрытый ввод)' }
        if ($settings.Count) { Set-QStudyHostSettings $root $settings; $settings.Clear() }
    }
    Invoke-HostManager 'check' @{ Offline = $true }
    if ($Prepare) { Invoke-HostManager 'prepare' }
    $networkOptions = @{ Domain = $Domain; NoPause = $true }
    if ($RouterWanIPv4) { $networkOptions['RouterWanIPv4'] = $RouterWanIPv4 }
    & (Join-Path $root 'scripts\Test-QStudyHomeNetwork.ps1') @networkOptions
    if ($LASTEXITCODE -ne 0) { throw 'Не удалось выполнить диагностику сети.' }
    if ($Start) {
        $reportPath = Assert-QStudyHostPath $root (Join-Path $root '.local\home-network-report.json')
        $report = [IO.File]::ReadAllText($reportPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
        Assert-QStudyHostNetworkForStart $report $Domain
        if (@($report.dnsIPv6).Count) { Write-Warning 'Есть AAAA-запись. Убедитесь, что IPv6 тоже обслуживает этот сайт; неподключённый IPv6 уберите в DNS.' }
        Invoke-HostManager 'start'
        if ($EnableAutostart) { Invoke-HostManager 'install-autostart' }
        Write-Host ('HTTPS проверен с этого компьютера: https://' + $Domain)
        Write-Host 'Теперь откройте сайт с телефона с выключенным Wi-Fi. Только это подтвердит внешний доступ.'
    } else {
        Write-Host 'Конфигурация подготовлена. Следующие действия:'
        Write-Host '1. Manage-QStudy-Internet.cmd prepare — собрать и запустить приватные контейнеры.'
        Write-Host '2. Восстановить штатный архив: restore -Archive ИМЯ.zip -NoPublish; либо создать первого admin.'
        Write-Host '3. Настроить DNS A, закрепить LAN-адрес, пробросить TCP 80/443 и разрешить их в firewall.'
        Write-Host '4. Manage-QStudy-Internet.cmd start; проверить сайт с мобильного интернета.'
        Write-Host '5. Manage-QStudy-Internet.cmd install-autostart; включить входной автозапуск Docker Desktop и отключить сон.'
    }
} catch {
    $failed = $true
    Write-Host ('QStudy: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
    if (Get-Variable settings -ErrorAction SilentlyContinue) { if ($settings) { $settings.Clear() } }
    if (Get-Variable existing -ErrorAction SilentlyContinue) { $existing.Clear() }
}
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
if ($failed) { exit 1 }
exit 0
