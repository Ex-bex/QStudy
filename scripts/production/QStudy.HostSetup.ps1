# Helpers for the Windows handover wizard. Private values never leave memory/.env.
. (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')

function Read-QStudyHostEnvironment([string]$Root) {
    $path = Assert-QStudyHostPath $Root (Join-Path $Root 'deployment\.env')
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return @{} }
    $values = @{}
    foreach ($line in [IO.File]::ReadAllLines($path, [Text.Encoding]::UTF8)) {
        if (-not $line.Trim() -or $line.TrimStart().StartsWith('#')) { continue }
        $match = [regex]::Match($line, "^\s*([A-Za-z_][A-Za-z_0-9]*)\s*=\s*'([^']*)'\s*(?:#.*)?$")
        if (-not $match.Success -or $values.ContainsKey($match.Groups[1].Value)) {
            throw "Мастер требует уникальные строки KEY='value' в deployment/.env. Проверьте файл приватно."
        }
        $value = $match.Groups[2].Value
        if ($value -match '[\x00-\x1f\x7f]' -or $value.EndsWith('\')) { throw 'Некорректный формат настройки в deployment/.env; значение скрыто.' }
        $values[$match.Groups[1].Value] = $value
    }
    return $values
}

function Set-QStudyHostSettings([string]$Root, [hashtable]$Settings) {
    $allowed = @('REGISTRATION_ENABLED', 'GEMINI_API_KEY', 'RECOVERY_DELIVERY', 'SMTP_HOST', 'SMTP_PORT', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM', 'SMTP_SECURITY')
    foreach ($key in $Settings.Keys) {
        if ($key -notin $allowed -or $Settings[$key] -isnot [string] -or $Settings[$key] -match "['\x00-\x1f\x7f]" -or $Settings[$key].EndsWith('\')) {
            throw 'Настройка не поддерживается или содержит недопустимые символы; значение скрыто.'
        }
    }
    $local = Assert-QStudyHostPath $Root (Join-Path $Root '.local')
    [IO.Directory]::CreateDirectory($local) | Out-Null
    $lockPath = Assert-QStudyHostPath $Root (Join-Path $local 'internet-host.lock')
    $lock = $null; $temporary = $null
    try {
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { throw 'Другая операция хоста уже выполняется. Дождитесь её завершения.' }
        $values = Read-QStudyHostEnvironment $Root
        if (-not $values.Count) { throw 'Сначала создайте настройки командой init.' }
        foreach ($key in $Settings.Keys) {
            if (-not $values.ContainsKey($key)) { throw 'Шаблон настроек неполный; значение скрыто.' }
            $values[$key] = $Settings[$key]
        }
        if ($values['REGISTRATION_ENABLED'] -notin @('true', 'false') -or $values['RECOVERY_DELIVERY'] -notin @('smtp', 'disabled') -or
            $values['SMTP_SECURITY'] -notin @('starttls', 'ssl') -or $values['SMTP_PORT'] -notmatch '^\d{1,5}$' -or
            [int]$values['SMTP_PORT'] -lt 1 -or [int]$values['SMTP_PORT'] -gt 65535) { throw 'Проверьте режим регистрации, восстановления и параметры SMTP; значения скрыты.' }
        if ($values['RECOVERY_DELIVERY'] -eq 'smtp') {
            foreach ($key in @('SMTP_HOST', 'SMTP_USERNAME', 'SMTP_PASSWORD', 'SMTP_FROM')) {
                if (-not $values[$key].Trim()) { throw 'Для SMTP нужно заполнить сервер, аккаунт, пароль и отправителя.' }
            }
        }
        Protect-QStudyHostStorage $Root
        $path = Assert-QStudyHostPath $Root (Join-Path $Root 'deployment\.env')
        $text = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8)
        foreach ($key in $Settings.Keys) {
            $replacement = $key + "='" + $Settings[$key] + "'"
            # MatchEvaluator preserves literal dollars/backslashes in passwords.
            $evaluator = [Text.RegularExpressions.MatchEvaluator]({ param($match) return $replacement }.GetNewClosure())
            $text = [regex]::Replace($text, ('(?m)^\s*' + [regex]::Escape($key) + '\s*=.*$'), $evaluator)
        }
        # The temporary name is ignored/rejected by Git even after interruption.
        $temporary = Assert-QStudyHostPath $Root (Join-Path $Root ('deployment\.env.setup-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes($text)
            $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
        } finally { $stream.Dispose() }
        # PowerShell 5.1 converts $null to an empty string for this overload.
        [IO.File]::Replace($temporary, $path, [NullString]::Value)
        $temporary = $null
        Protect-QStudyHostStorage $Root
    } catch {
        # Filesystem exceptions can include user data; do not echo them.
        if ($_.Exception -is [Management.Automation.RuntimeException] -and $_.Exception.Message -match '^(Настройка|Другая|Мастер|Сначала|Шаблон|Проверьте|Для SMTP|Некорректный)') { throw }
        throw ('Не удалось безопасно сохранить настройки хоста (' + $_.Exception.GetType().Name + ', строка ' + $_.InvocationInfo.ScriptLineNumber + '). Проверьте доступ к файлам; значения скрыты.')
    } finally {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
        if ($null -ne $lock) { $lock.Dispose() }
    }
}

function Assert-QStudyHostNetworkForStart($Report, [string]$Domain) {
    if ($Report.version -ne 1 -or $Report.offline -or $Report.domain -cne $Domain -or
        $Report.dnsAssessment -notin @('ipv4_matches', 'ipv4_matches_verify_ipv6')) {
        throw 'DNS домена должен указывать на внешний IPv4 этого хоста. Проверьте A-запись, VPN и отчёт диагностики.'
    }
    if ($Report.wanAssessment -in @('cgnat', 'private_wan', 'invalid_wan', 'wan_mismatch')) {
        throw 'Прямой доступ не подтверждён: проверьте WAN, второй роутер и публичный IPv4 у провайдера.'
    }
    $checked = [DateTimeOffset]::Parse($Report.checkedUtc)
    if ([Math]::Abs(([DateTimeOffset]::UtcNow - $checked).TotalMinutes) -gt 10) { throw 'Отчёт сети устарел. Повторите диагностику перед запуском.' }
    # A successful local HTTPS request is not an independent Internet test.
}

function Assert-QStudyHostIpNetworkForStart($Report, [string]$PublicIP) {
    if ($Report.version -ne 1 -or $Report.offline -or $Report.externalIpStatus -ne 'observed' -or $Report.externalIPv4 -cne $PublicIP) {
        throw 'Указанный публичный IPv4 должен совпадать с адресом этого подключения. Проверьте VPN, IP и отчёт сети.'
    }
    if ($Report.wanAssessment -in @('cgnat', 'private_wan', 'invalid_wan', 'wan_mismatch')) { throw 'Прямой доступ не подтверждён: проверьте WAN и публичный IPv4 у провайдера.' }
    $checked = [DateTimeOffset]::Parse($Report.checkedUtc)
    if ([Math]::Abs(([DateTimeOffset]::UtcNow - $checked).TotalMinutes) -gt 10) { throw 'Отчёт сети устарел. Повторите диагностику перед запуском.' }
}

function Get-QStudyAvailableHttpPort([int]$Preferred = 8080) {
    foreach ($candidate in $Preferred..([Math]::Min($Preferred + 99, 65535))) {
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, $candidate)
        try { $listener.Start(); return $candidate }
        catch [Net.Sockets.SocketException] { }
        finally { $listener.Stop() }
    }
    throw 'Не найден свободный порт. Укажите -Port вручную; чужие процессы не останавливаются.'
}
