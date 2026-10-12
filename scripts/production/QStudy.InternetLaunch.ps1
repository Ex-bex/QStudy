# Helpers for the public launcher; dot-sourcing performs no host changes.
. (Join-Path $PSScriptRoot 'QStudy.HostSetup.ps1')
. (Join-Path $PSScriptRoot '..\QStudy.HomeNetwork.ps1')
. (Join-Path $PSScriptRoot 'QStudy.PublicPortOwner.ps1')

function Get-QStudyInternetObservedIP {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try { $value = [string](Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 12).ip }
    catch { throw 'Не удалось определить внешний IPv4. Проверьте интернет или укажите -PublicIP.' }
    if ((Get-QStudyIPv4Kind $value) -ne 'public') { throw 'Внешний IPv4 не подходит для прямой публикации.' }
    return $value
}

function Get-QStudyInternetNetworkAction([string]$Root, [switch]$ManualRequested) {
    $path = Assert-QStudyHostPath $Root (Join-Path $Root '.local\public-access\state.json')
    $manualSaved = $false
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        if ((Get-Item -LiteralPath $path).Length -gt 65536) { throw 'Сохранённое состояние сети слишком большое; запуск остановлен.' }
        try { $state = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
        catch { throw 'Повреждено состояние сетевого доступа. Проверьте .local/public-access/state.json приватно.' }
        if ($state.version -ne 1 -or $state.owner -cne ('QStudy public access: ' + [IO.Path]::GetFullPath($Root)) -or
            $state.owner_sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -or $state.enabled -isnot [bool] -or
            $state.method -notin @('none', 'manual', 'direct', 'upnp', 'nat-pmp')) {
            throw 'Сохранённая настройка сети принадлежит другой установке или Windows-пользователю; запуск остановлен.'
        }
        $manualSaved = $state.enabled -and $state.method -ceq 'manual'
    }
    if ($ManualRequested -or $manualSaved) { return 'manual' }
    return 'enable'
}

function Ensure-QStudyInternetDocker([ValidateRange(10, 600)][int]$TimeoutSeconds = 180) {
    $installation = Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'Docker\Docker'
    if (-not (Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue)) {
        $bin = Join-Path $installation 'resources\bin'
        if (Test-Path -LiteralPath (Join-Path $bin 'docker.exe') -PathType Leaf) { $env:PATH = $bin + ';' + $env:PATH }
    }
    $command = Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue
    if ($null -eq $command) { throw 'Установите Docker Desktop для Windows: https://docs.docker.com/desktop/setup/install/windows-install/ . Завершите первичную настройку и повторите эту же кнопку.' }
    if ($env:DOCKER_HOST -and -not (Test-QStudyLocalDockerEndpoint $env:DOCKER_HOST)) { throw 'Выбран удалённый Docker. Переключите Docker Desktop на локальные Linux-контейнеры; настройки других серверов не менялись.' }
    $context = (Invoke-QStudyPublicPortDocker $command.Source @('context', 'show')).Trim()
    try { $endpoint = (Invoke-QStudyPublicPortDocker $command.Source @('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}', '--', $context)) | ConvertFrom-Json }
    catch { throw 'Не удалось безопасно проверить выбранный Docker. Выберите локальный Docker Desktop.' }
    if ($endpoint -isnot [string] -or -not (Test-QStudyLocalDockerEndpoint $endpoint)) { throw 'Выберите локальный Docker Desktop с Linux-контейнерами. Удалённый Docker не используется.' }
    if ($env:DOCKER_HOST -and -not $env:DOCKER_CONTEXT) { $endpoint = $env:DOCKER_HOST }
    $arguments = @('--host', $endpoint, 'info', '--format', '{{.OSType}}')
    try { $ready = (Invoke-QStudyPublicPortDocker $command.Source $arguments -Pinned).Trim() -ceq 'linux' }
    catch { $ready = $false }
    if ($ready) { return }
    $desktop = Join-Path $installation 'Docker Desktop.exe'
    if (Test-Path -LiteralPath $desktop -PathType Leaf) { Start-Process -FilePath $desktop -WindowStyle Hidden | Out-Null }
    Write-Host 'Ожидаю Docker Desktop. Если появилась первичная настройка, завершите её и выберите Linux-контейнеры.'
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        try { $engine = (Invoke-QStudyPublicPortDocker $command.Source $arguments -Pinned -TimeoutMs 3000).Trim() }
        catch { $engine = '' }
        if ($engine -ceq 'linux') { return }
        if ($engine -ceq 'windows') { throw 'В Docker Desktop переключитесь на Linux containers и повторите кнопку запуска.' }
        Start-Sleep -Seconds 2
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Docker Desktop не готов. Проверьте WSL 2, виртуализацию и сообщения Docker, затем повторите кнопку запуска.'
}

function Get-QStudyInternetBuildFingerprint([string]$Root) {
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($relative in @('backend\app', 'frontend\app', 'frontend\components', 'frontend\lib', 'frontend\public', 'frontend\types')) {
        $folder = Assert-QStudyHostPath $Root (Join-Path $Root $relative)
        if (-not (Test-Path -LiteralPath $folder -PathType Container)) { throw 'Скопируйте проект полностью: не хватает исходников приложения.' }
        $queue = [Collections.Generic.Queue[string]]::new(); $queue.Enqueue($folder)
        while ($queue.Count) {
            $directory = Assert-QStudyHostPath $Root $queue.Dequeue()
            foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force)) {
                if ($entry.Name -in @('__pycache__', 'node_modules', '.next') -or $entry.Extension -eq '.pyc') { continue }
                $candidate = Assert-QStudyHostPath $Root $entry.FullName
                if ($entry.PSIsContainer) { $queue.Enqueue($candidate) } else { $paths.Add($candidate) }
            }
        }
    }
    foreach ($relative in @('backend\requirements.txt', 'backend\requirements.lock.txt', 'frontend\package.json', 'frontend\package-lock.json', 'frontend\next.config.ts', 'frontend\postcss.config.mjs', 'frontend\proxy.ts', 'frontend\middleware.ts', 'frontend\tsconfig.json', '.dockerignore', 'deployment\backend.Dockerfile', 'deployment\frontend.Dockerfile', 'deployment\compose.yml', 'deployment\compose.http.yml', 'deployment\Caddyfile.http', 'scripts\production\runtime.py', 'scripts\check_mail.py')) {
        $file = Assert-QStudyHostPath $Root (Join-Path $Root $relative)
        if (Test-Path -LiteralPath $file -PathType Leaf) { $paths.Add($file) }
    }
    $sha = [Security.Cryptography.SHA256]::Create()
    $aggregate = [Text.StringBuilder]::new()
    try {
        foreach ($file in @($paths | Sort-Object)) {
            $stream = [IO.File]::OpenRead($file)
            try { $digest = [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '') }
            finally { $stream.Dispose() }
            [void]$aggregate.Append($file.Substring($Root.TrimEnd('\').Length)).Append(':').Append($digest).Append("`n")
        }
        return [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($aggregate.ToString()))).Replace('-', '').ToLowerInvariant()
    } finally { $sha.Dispose() }
}

function Read-QStudyInternetReport([string]$Root, [ValidateSet('host-stack-status.json', 'host-account-status.json')][string]$Filename) {
    $path = Assert-QStudyHostPath $Root (Join-Path $Root ('.local\' + $Filename))
    try { $report = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'Не удалось прочитать результат проверки контейнеров/аккаунтов. Публичный запуск остановлен.' }
    $checked = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$report.checked_utc, [ref]$checked) -or [Math]::Abs(($checked - [DateTimeOffset]::UtcNow).TotalMinutes) -gt 2) { throw 'Результат проверки хоста устарел; повторите запуск.' }
    if ($Filename -eq 'host-account-status.json') {
        if ($report.active_admin_exists -isnot [bool] -or $report.account_count -isnot [int] -or $report.account_count -lt 0) { throw 'Некорректный результат проверки аккаунтов; запуск остановлен.' }
    } else {
        foreach ($key in @('backend_running', 'frontend_running', 'caddy_running', 'images_ready')) { if ($report.$key -isnot [bool]) { throw 'Некорректный результат проверки контейнеров; запуск остановлен.' } }
    }
    return $report
}

function Get-QStudyInternetBuildStatePath([string]$Root) { return Assert-QStudyHostPath $Root (Join-Path $Root '.local\internet-launch\build.json') }
function Test-QStudyInternetBuildCurrent([string]$Root, [string]$Fingerprint) {
    $path = Get-QStudyInternetBuildStatePath $Root
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    try {
        $report = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
        return $report.source_hash -ceq $Fingerprint -and $report.root -ceq $Root -and $report.computer -ceq [Environment]::MachineName -and $report.owner_sid -ceq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    } catch { return $false }
}

function Save-QStudyInternetBuildState([string]$Root, [string]$Fingerprint) {
    $path = Get-QStudyInternetBuildStatePath $Root
    [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
    $report = @{ source_hash = $Fingerprint; root = $Root; computer = [Environment]::MachineName; owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; checked_utc = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText($path, ($report | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
    (Get-Item -LiteralPath $path).SetAccessControl((New-QStudyPrivateAcl $false $path))
}
