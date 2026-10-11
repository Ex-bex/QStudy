param(
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 120,
    [ValidateRange(1024, 65535)][int]$FrontendPort = 3000,
    [ValidateRange(1024, 65535)][int]$BackendPort = 8000,
    [string]$PythonPath = '',
    [string]$NodePath = '',
    [switch]$Lan,
    [switch]$Local,
    [switch]$Dev,
    [switch]$Offline,
    [switch]$Repair,
    [switch]$NoBrowser,
    [switch]$OpenBrowser,
    [switch]$NoPause
)
. (Join-Path $PSScriptRoot 'QStudy.Common.ps1')
$lock = $null
$state = $null
$created = [Collections.Generic.List[object]]::new()
$failed = $false
$savedEnvironment = @{}
foreach ($key in @('PYTHONUNBUFFERED', 'NODE_ENV', 'BACKEND_URL', 'CORS_ORIGINS', 'PUBLIC_BASE_URL')) {
    $savedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}
try {
    if ($Lan -and $Local) { throw 'Параметры -Lan и -Local нельзя использовать вместе.' }
    if ($NoBrowser -and $OpenBrowser) { throw 'Параметры -NoBrowser и -OpenBrowser нельзя использовать вместе.' }
    $lock = Enter-QStudyLock
    $state = Read-QStudyState
    $useLan = if ($Lan) { $true } elseif ($Local) { $false } else { $state.mode -eq 'lan' }
    $desiredBind = if ($useLan) { '0.0.0.0' } else { '127.0.0.1' }
    $bothAlive = $null -ne $state.backend -and $null -ne $state.frontend -and
        $null -ne (Get-QStudyOwnedProcess $state.backend.identity) -and
        $null -ne (Get-QStudyOwnedProcess $state.frontend.identity)
    $sameMode = $state.bind -eq $desiredBind
    $samePorts = $true
    if ($bothAlive) {
        $samePorts = (-not $PSBoundParameters.ContainsKey('FrontendPort') -or $state.frontend.port -eq $FrontendPort) -and
            (-not $PSBoundParameters.ContainsKey('BackendPort') -or $state.backend.port -eq $BackendPort)
    }
    if ($bothAlive -and $sameMode -and $samePorts -and -not $Repair) {
        Wait-QStudyReady $state.backend $TimeoutSeconds
        Wait-QStudyReady $state.frontend $TimeoutSeconds
        Set-QStudyAddresses $state ([int]$state.frontend.port) $useLan
        Write-QStudyState $state
        Write-Host 'QStudy уже работает.'
    } else {
        # Stop a partial launch before dependency repair or data preflight.
        # Every identity is checked; copied/reused PIDs are never terminated.
        foreach ($name in @('frontend', 'backend')) {
            if ($null -ne $state.$name) {
                Stop-QStudyRecord $state.$name
                $state.$name = $null
            }
        }
        Write-QStudyState $state
        $installHelper = Join-Path $PSScriptRoot 'QStudy.Install.ps1'
        if (-not (Test-Path -LiteralPath $installHelper -PathType Leaf)) { throw 'Отсутствует scripts/QStudy.Install.ps1. Скопируйте проект полностью.' }
        . $installHelper
        $runtime = Ensure-QStudyInstallation -Offline:$Offline -ForceRepair:$Repair
        $python = if ($PythonPath) { Resolve-QStudyRuntime $PythonPath 'python' } else { [string]$runtime.python }
        $node = if ($NodePath) { Resolve-QStudyRuntime $NodePath 'node' } else { [string]$runtime.node }
        $backendEntry = Join-Path $PSScriptRoot 'qstudy_backend.py'
        $nextEntry = Join-Path $script:QStudyRoot 'frontend\node_modules\next\dist\bin\next'
        if (-not (Test-Path -LiteralPath $nextEntry -PathType Leaf)) { throw 'Не удалось подготовить зависимости frontend.' }
        $preflight = Join-Path $PSScriptRoot 'qstudy_data.py'
        if (-not (Test-Path -LiteralPath $preflight -PathType Leaf)) { throw 'Отсутствует scripts/qstudy_data.py. Скопируйте проект полностью.' }
        $preflightArgs = @($preflight, '--project-root', $script:QStudyRoot, '--apply')
        if ($state.previousWorkspace) { $preflightArgs += @('--previous-project-root', $state.previousWorkspace) }
        $preflightOutput = @(& $python @preflightArgs 2>&1)
        $preflightExit = $LASTEXITCODE
        try { $dataReport = ($preflightOutput -join [Environment]::NewLine) | ConvertFrom-Json }
        catch { throw 'Не удалось прочитать результат проверки данных QStudy.' }
        [IO.File]::WriteAllText((Join-Path $script:QStudyLocal 'portability-report.json'), ($dataReport | ConvertTo-Json -Depth 12), [Text.UTF8Encoding]::new($false))
        if ($preflightExit -ne 0 -or -not $dataReport.ok) { throw 'Проверка переносимых данных не завершена. Подробности: .local/portability-report.json. Данные не удалены.' }
        if (@($dataReport.warnings).Count -gt 0) { Write-Warning ('Проверка данных: предупреждений ' + @($dataReport.warnings).Count + '. Подробности доступны в отчёте переносимости.') }
        $state.previousWorkspace = ''
        Write-QStudyState $state
        for ($attempt = 1; $attempt -le 3; $attempt++) {
            $created.Clear()
            $selectedBackend = Find-QStudyFreePort $BackendPort '127.0.0.1'
            $selectedFrontend = Find-QStudyFreePort $FrontendPort $desiredBind @($selectedBackend)
            Set-QStudyAddresses $state $selectedFrontend $useLan
            $state | Add-Member -NotePropertyName backendPort -NotePropertyValue $selectedBackend -Force
            $state | Add-Member -NotePropertyName frontendPort -NotePropertyValue $selectedFrontend -Force
            $env:PYTHONUNBUFFERED = '1'
            $env:NODE_ENV = 'development'
            $env:BACKEND_URL = 'http://127.0.0.1:' + $selectedBackend
            $env:PUBLIC_BASE_URL = $state.siteUrl
            $origins = @($state.localUrl, ('http://localhost:' + $selectedFrontend)) + @($state.lanUrls)
            $env:CORS_ORIGINS = ($origins | Select-Object -Unique) -join ','
            try {
                $instance = [Guid]::NewGuid().ToString('N')
                $record = Start-QStudyProcess -Name 'backend' -Executable $python -Arguments @($backendEntry, '--port', [string]$selectedBackend, '--qstudy-instance', $instance) -Directory (Join-Path $script:QStudyRoot 'backend') -Marker $backendEntry -Instance $instance -Port $selectedBackend -Url ($env:BACKEND_URL + '/api/health')
                $created.Add($record); $state.backend = $record; Write-QStudyState $state
                Wait-QStudyReady $record $TimeoutSeconds
                $instance = [Guid]::NewGuid().ToString('N')
                $record = Start-QStudyProcess -Name 'frontend' -Executable $node -Arguments @("--title=qstudy-$instance", $nextEntry, 'dev', '--hostname', $desiredBind, '--port', [string]$selectedFrontend) -Directory (Join-Path $script:QStudyRoot 'frontend') -Marker $nextEntry -Instance $instance -Port $selectedFrontend -Url ($state.localUrl + '/') -Bind $desiredBind
                $created.Add($record); $state.frontend = $record; Write-QStudyState $state
                Wait-QStudyReady $record $TimeoutSeconds
                Write-QStudyState $state
                Write-Host 'QStudy запущен в отдельных скрытых процессах.'
                break
            } catch {
                $collision = $_.Exception.Message -like '*PORT_COLLISION:*'
                if (-not $collision) {
                    foreach ($record in $created) { if (Test-QStudyForeignListener $record) { $collision = $true } }
                }
                foreach ($record in $created) { Stop-QStudyRecord $record; $state.($record.name) = $null }
                Write-QStudyState $state
                if (-not $collision -or $attempt -eq 3) { throw }
                Write-Host 'Выбранный порт успело занять другое приложение. Подбираю новые порты.'
            }
        }
    }
    Write-Host ('Сайт: ' + $state.siteUrl)
    if ($state.siteUrl -ne $state.localUrl) { Write-Host ('На этом компьютере: ' + $state.localUrl) }
    foreach ($url in @($state.lanUrls | Select-Object -Skip 1)) { Write-Host ('Другой сетевой адрес: ' + $url) }
    if ($useLan -and @($state.lanUrls).Count -eq 0) { Write-Warning 'Активный сетевой IPv4-адрес не найден. Открываю локальный адрес.' }
    Write-Host ('API:  ' + $state.backend.url)
    Write-Host ('Логи: ' + (Join-Path $script:QStudyLocal 'logs'))
    if (-not $NoBrowser -and ($OpenBrowser -or -not $NoPause)) {
        try { Start-Process -FilePath $state.siteUrl | Out-Null }
        catch { Write-Warning 'Не удалось открыть браузер. Откройте адрес сайта, указанный выше.' }
    }
} catch {
    $failed = $true
    $failureMessage = $_.Exception.Message
    foreach ($record in $created) {
        try {
            Stop-QStudyRecord $record
            if ($null -ne $state) { $state.($record.name) = $null }
        } catch { Write-Warning "Не удалось завершить $($record.name); состояние сохранено для Stop-QStudy.cmd." }
    }
    if ($null -ne $state -and $null -ne $lock) {
        try { Write-QStudyState $state } catch { Write-Warning 'Не удалось сохранить состояние процессов.' }
    }
    Write-Host "Ошибка запуска QStudy: $failureMessage" -ForegroundColor Red
} finally {
    foreach ($key in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $savedEnvironment[$key], 'Process') }
    if ($null -ne $lock) { $lock.Dispose() }
}
if ($failed) {
    if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно') }
    exit 1
}
exit 0
