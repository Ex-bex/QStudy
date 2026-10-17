@echo off
setlocal
chcp 65001 >nul
set "QBALL_FIELD_FIX_HOME=%~dp0"
set "QBALL_FIELD_FIX_FILE=%~f0"
powershell.exe -STA -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$text=[IO.File]::ReadAllText($env:QBALL_FIELD_FIX_FILE); $marker='#==QBALL_FIELD_POWERSHELL=='; & ([scriptblock]::Create($text.Substring($text.LastIndexOf($marker)+$marker.Length)))"
set "qball_field_exit=%errorlevel%"
pause
exit /b %qball_field_exit%
#==QBALL_FIELD_POWERSHELL==
param([string]$Root = '', [switch]$Library)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$script:QBallFieldHash = '22c7a449b1727d1a9a77715edccd9586fe59848cdd71ee8c3f273411c4d8db46'
$script:QBallFieldUrl = 'https://github.com/Ex-bex/QStudy/raw/23068152396d2dd014349b3915e1fce527dc3796/assets/distribution/QStudy-QCareer-Integration.zip'

function Resolve-QBallFieldPath([string]$Base, [string]$Relative = '') {
    $basePath = [IO.Path]::GetFullPath($Base).TrimEnd('\', '/')
    if ([IO.Path]::IsPathRooted($Relative) -or $Relative -match '(^|[/\\])\.\.([/\\]|$)|:|[\x00-\x1f]') { throw 'Недопустимый путь обновления.' }
    $path = if ($Relative) { [IO.Path]::GetFullPath((Join-Path $basePath $Relative)) } else { $basePath }
    if ($path -cne $basePath -and -not $path.StartsWith($basePath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Путь выходит за пределы QStudy.' }
    $current = $path
    while ($current.Length -ge $basePath.Length) {
        if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Обновление через ссылки или junction запрещено.' }
        if ([string]::Equals($current, $basePath, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
    }
    return $path
}

function Test-QBallFieldRoot([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
    foreach ($name in @('Start-QStudy-Internet.cmd', 'frontend', 'backend', 'scripts/Start-QStudy.ps1')) {
        if (-not (Test-Path -LiteralPath (Join-Path $Path $name))) { return $false }
    }
    return $true
}

function Install-QBallFieldPackage([string]$Project, [string]$Archive, [string]$ExpectedHash) {
    Add-Type -AssemblyName System.IO.Compression
    $stream = [IO.File]::Open($Archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $zip = $null; $pending = ''
    try {
        $digest = [Security.Cryptography.SHA256]::Create()
        try { $actual = ([BitConverter]::ToString($digest.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() } finally { $digest.Dispose() }
        if ($actual -cne $ExpectedHash) { throw 'Контрольная сумма обновления не совпала. Сайт не изменён.' }
        $stream.Position = 0
        $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Read, $true)
        $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
        $plan = @(); $size = 0
        if ($zip.Entries.Count -lt 4 -or $zip.Entries.Count -gt 200) { throw 'Неизвестный состав пакета обновления.' }
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName
            if ($name.Contains('\') -or $name.Contains('//') -or $name -match '(^|/)(\.|\.\.|\.env[^/]*)(/|$)' -or
                ($name -cne 'Apply-QBall-Fix.cmd' -and -not $name.StartsWith('.qstudy-fix/', [StringComparison]::Ordinal)) -or
                $name.EndsWith('/') -or $entry.Length -gt 4MB -or -not $seen.Add($name)) { throw 'Пакет содержит запрещённый путь.' }
            $size += $entry.Length
            if ($size -gt 32MB) { throw 'Пакет превышает допустимый размер.' }
            $plan += [pscustomobject]@{ entry = $entry; target = (Resolve-QBallFieldPath $Project $name) }
        }
        foreach ($required in @('Apply-QBall-Fix.cmd', '.qstudy-fix/Apply.ps1', '.qstudy-fix/manifest.json')) {
            if (-not $seen.Contains($required)) { throw 'Пакет обновления неполный.' }
        }
        foreach ($item in $plan) {
            [IO.Directory]::CreateDirectory((Split-Path -Parent $item.target)) | Out-Null
            [void](Resolve-QBallFieldPath $Project $item.entry.FullName)
            $pending = $item.target + '.field-' + [Guid]::NewGuid().ToString('N') + '.tmp'
            $entryInput = $item.entry.Open(); $entryOutput = [IO.File]::Create($pending)
            try { $entryInput.CopyTo($entryOutput); $entryOutput.Flush($true) } finally { $entryOutput.Dispose(); $entryInput.Dispose() }
            if (Test-Path -LiteralPath $item.target) { [IO.File]::Replace($pending, $item.target, [NullString]::Value) } else { [IO.File]::Move($pending, $item.target) }
            $pending = ''
        }
    } finally {
        if ($null -ne $zip) { $zip.Dispose() }; $stream.Dispose()
        if ($pending -and (Test-Path -LiteralPath $pending -PathType Leaf)) { Remove-Item -LiteralPath $pending -Force }
    }
}

function Invoke-QBallFieldApply([string]$Project) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $apply = Resolve-QBallFieldPath $Project '.qstudy-fix/Apply.ps1'
    # A NoWindow PS5.1 child otherwise uses its system OEM code page, which
    # can replace Cyrillic with '?' on English Windows before we can decode it.
    # Single-quote literal paths so quotes, dollars and backticks stay filename
    # data. Windows filenames cannot contain the outer argument's double quote.
    $command = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); & ''' + $apply.Replace("'", "''") + ''' -Root ''' + $Project.Replace("'", "''") + ''' -NoPause; exit $LASTEXITCODE'
    $info.Arguments = '-NoProfile -OutputFormat Text -ExecutionPolicy Bypass -Command "' + $command + '"'
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $encoding = [Text.UTF8Encoding]::new($false)
    $info.StandardOutputEncoding = $encoding; $info.StandardErrorEncoding = $encoding
    # A PS7 parent can pass Core-only module paths into nested Windows PS5.1.
    # Let this child discover its own built-in modules; do not change host settings.
    $info.EnvironmentVariables.Remove('PSModulePath')
    $child = [Diagnostics.Process]::new(); $child.StartInfo = $info
    try {
        [void]$child.Start()
        $channels = @(
            @{ reader = $child.StandardOutput; task = $child.StandardOutput.ReadLineAsync(); error = $false },
            @{ reader = $child.StandardError; task = $child.StandardError.ReadLineAsync(); error = $true }
        )
        $errors = [Text.StringBuilder]::new()
        $timer = [Diagnostics.Stopwatch]::StartNew(); $exitedAt = -1
        while ($true) {
            foreach ($channel in $channels) {
                if ($null -eq $channel.task -or -not $channel.task.IsCompleted) { continue }
                $value = $channel.task.GetAwaiter().GetResult()
                if ($null -eq $value) { $channel.task = $null; continue }
                if ($channel.error) { [void]$errors.AppendLine($value) } else { Write-Host $value }
                $channel.task = $channel.reader.ReadLineAsync()
            }
            if ($child.HasExited) {
                if ($exitedAt -lt 0) { $exitedAt = $timer.ElapsedMilliseconds }
                # Detached application children can inherit a pipe handle.
                # Finish on the updater's exit, with a brief bounded log drain.
                if ($timer.ElapsedMilliseconds - $exitedAt -ge 400) { break }
            }
            [Threading.Thread]::Sleep(25)
        }
        $details = $errors.ToString()
        if ($child.ExitCode -ne 0 -and $details) { Write-Host $details -ForegroundColor Red }
        return $child.ExitCode
    } finally { $child.Dispose() }
}

if ($Library) { return }
try {
    Write-Host 'QCareer: добавляем карьерное пространство. Учебные данные, аккаунты и настройки QStudy сохраняются.' -ForegroundColor Cyan
    if (-not $Root -and (Test-QBallFieldRoot $env:QBALL_FIELD_FIX_HOME)) { $Root = $env:QBALL_FIELD_FIX_HOME }
    if (-not $Root) {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = [Windows.Forms.FolderBrowserDialog]::new()
        try {
            $dialog.Description = 'Выберите существующую папку QStudy с Start-QStudy-Internet.cmd. База и настройки сохранятся.'
            $dialog.ShowNewFolderButton = $false
            if ($dialog.ShowDialog() -ne [Windows.Forms.DialogResult]::OK) { throw 'Папка не выбрана; сайт не изменён.' }
            $Root = $dialog.SelectedPath
        } finally { $dialog.Dispose() }
    }
    $Root = Resolve-QBallFieldPath $Root
    if (-not (Test-QBallFieldRoot $Root)) { throw 'В выбранной папке нет установленного QStudy.' }
    $store = Resolve-QBallFieldPath $Root ('.local/career-update/' + [Guid]::NewGuid().ToString('N'))
    [IO.Directory]::CreateDirectory($store) | Out-Null
    $archive = Join-Path $store 'update.zip'
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Write-Host 'Скачиваем зафиксированную версию обновления из GitHub…'
    Invoke-WebRequest -UseBasicParsing -Uri $script:QBallFieldUrl -OutFile $archive -TimeoutSec 60
    Write-Host 'Проверяем SHA256 и подготавливаем обновление…'
    Install-QBallFieldPackage $Root $archive $script:QBallFieldHash
    Write-Host 'Обновление проверено. Штатно останавливаем, собираем и запускаем существующий сайт…'
    $result = Invoke-QBallFieldApply $Root
    if ($result -ne 0) { throw 'Штатное обновление не завершено. Причина указана выше; база не импортировалась.' }
    Write-Host 'Готово. На устройствах игроков нажмите Ctrl+F5. Данные и настройки не заменялись.' -ForegroundColor Green
    exit 0
} catch {
    Write-Host ('QCareer: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Не удаляйте базу или .env. Повторите этот же файл после исправления указанной причины.'
    exit 1
}
