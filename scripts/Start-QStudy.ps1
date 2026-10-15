param(
    [ValidateSet('install', 'local', 'lan', 'internet')][string]$Mode = 'local',
    [ValidateRange(10, 600)][int]$TimeoutSeconds = 180,
    [switch]$Offline, [switch]$Repair, [switch]$ForceRepair,
    [switch]$NoBrowser, [switch]$NoPause,
    [switch]$Lan, [switch]$Local
)
. (Join-Path $PSScriptRoot 'launcher\Native.ps1')
$root = $script:QStudyRoot
$lock = $null; $failed = $false; $supervisor = $null; $state = $null
$stage = 'выбор существующих данных'
try {
    if ($Lan -and $Local) { throw 'QStudy: выберите один режим запуска.' }
    if ($Lan) { $Mode = 'lan' }; if ($Local) { $Mode = 'local' }
    Initialize-QStudyNativeStorage $root
    $lock = Enter-QStudyLock
    $dataset = Get-QStudyNativeDataset $root
    Write-Host ('QStudy — ' + $(if ($Mode -ceq 'install') { 'установка окружения' } elseif ($Mode -ceq 'internet') { 'доступ из интернета' } elseif ($Mode -ceq 'lan') { 'локальная сеть' } else { 'этот компьютер' }))
    Write-Host ('Активная база: ' + $dataset.database)
    Write-Host 'Аккаунты, материалы и настройки сохраняются во всех режимах. Восстановление ZIP при запуске не выполняется.'
    $networkScript = Join-Path $PSScriptRoot 'launcher_network.ps1'
    if (-not (Test-Path -LiteralPath $networkScript -PathType Leaf)) { throw 'QStudy: отсутствует scripts/launcher_network.ps1. Скопируйте проект полностью.' }
    . $networkScript
    $state = Read-QStudyNativeState $root
    $status = Get-QStudyInstallationStatus $root
    $runtime = $status.runtime
    $hash = Get-QStudyNativeBuildHash $root
    $backendHash = Get-QStudyNativeBackendHash $root
    $build = Read-QStudyInstallJson (Join-Path $root '.local\launcher\build.json')
    $reuse = $Mode -cne 'install' -and -not $Repair -and -not $ForceRepair -and $null -ne $state -and $state.mode -ceq $Mode -and $state.data_source -ceq $dataset.source -and (Get-QStudyInstallProperty $state 'backend_hash' '') -ceq $backendHash -and $status.ready -and $null -ne $build -and $build.hash -ceq $hash -and $null -ne (Get-QStudyOwnedProcess $state.supervisor.identity)
    if ($reuse) {
        $context = Get-QStudyNativeNetworkContext -Root $root -Mode $Mode -Port ([int]$state.frontend_port)
        $reuse = $context.site_url -ceq $state.site_url
        if ($reuse) {
            $managed = Read-QStudyInstallJson (Join-Path $root '.local\managed\status.json')
            if ($null -eq $managed -or $managed.instance -cne $state.instance -or $managed.state -cne 'running') { $reuse = $false }
            else {
                $state.backend = New-QStudyNativeChildRecord 'backend' ([int]$managed.backend_pid) $root $state.instance ([int]$state.backend_port) '127.0.0.1'
                $state.frontend = New-QStudyNativeChildRecord 'frontend' ([int]$managed.frontend_pid) $root $state.instance ([int]$state.frontend_port) $state.bind (($state.site_url -split '//', 2)[1])
                Wait-QStudyReady $state.backend 10
                Wait-QStudyReady $state.frontend 10
                $refreshedStatePath = Join-Path $root '.local\launcher\state.json'
                Write-QStudyInstallJson $refreshedStatePath $state
                Protect-QStudyNativePath $refreshedStatePath
                Write-Host 'QStudy уже работает. Используется та же база данных.'
            }
        }
    }
    if (-not $reuse) {
        $stage = 'завершение прежнего запуска'
        if ($null -ne $state) {
            Disable-QStudyNativeNetwork -Root $root
            if ($null -eq $runtime) { throw 'QStudy: окружение действующего запуска не найдено. Процессы и данные сохранены.' }
            Stop-QStudyNativeState $root $state $runtime
        }
        # Upgrade the original local launcher without guessing process ownership.
        $legacy = Read-QStudyState
        foreach ($name in @('frontend', 'backend')) { if ($null -ne $legacy.$name) { Stop-QStudyRecord $legacy.$name; $legacy.$name = $null } }
        Write-QStudyState $legacy
        $stage = 'установка зависимостей'
        $runtime = Ensure-QStudyInstallation -RootPath $root -Offline:$Offline -ForceRepair:($Repair -or $ForceRepair)
        Protect-QStudyNativePath $dataset.env_file
        if ($dataset.source -ceq 'deployment') {
            $stage = 'переход с прежнего контейнерного запуска'
            & $runtime.python -I (Join-Path $root 'scripts\launcher\docker_migration.py') --root $root
            if ($LASTEXITCODE -ne 0) { throw 'QStudy: прежняя установка может использовать выбранную базу. Остановите её в Docker Desktop и повторите кнопку; база не копировалась и не сбрасывалась.' }
        }
        $stage = 'сборка production-интерфейса'
        Ensure-QStudyNativeBuild $root $runtime -Repair:($Repair -or $ForceRepair)
        if ($Mode -ceq 'install') {
            Write-Host 'Окружение и production-интерфейс готовы. Выберите Start-QStudy.cmd, Start-QStudy-LAN.cmd или Start-QStudy-Internet.cmd.'
        } else {
            $stage = 'выбор портов'
            $backendPort = Find-QStudyFreePort 8000 '127.0.0.1'
            $bind = if ($Mode -ceq 'local') { '127.0.0.1' } else { '0.0.0.0' }
            if ($Mode -ceq 'internet') {
                $frontendPort = 8080
                if (-not (Test-QStudyPortUsable $frontendPort $bind)) { throw 'QStudy: TCP 8080 занят другим приложением. Закройте прежний сервер и повторите кнопку. Порт не заменён автоматически.' }
            } else { $frontendPort = Find-QStudyFreePort 3000 $bind @($backendPort) }
            $context = Get-QStudyNativeNetworkContext -Root $root -Mode $Mode -Port $frontendPort
            $instance = [Guid]::NewGuid().ToString('N')
            $random = [Security.Cryptography.RandomNumberGenerator]::Create()
            try { $secretBytes = New-Object byte[] 48; $random.GetBytes($secretBytes); $controlToken = [Convert]::ToBase64String($secretBytes) } finally { $random.Dispose() }
            $config = @{ version = 1; root = $root; owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
                instance = $instance; mode = $Mode; data_source = $dataset.source; backend_port = $backendPort; frontend_port = $frontendPort;
                site_url = $context.site_url; bind = $bind; node = $runtime.node; control_token = $controlToken; timeout_seconds = $TimeoutSeconds }
            $configPath = Assert-QStudyNativePath $root (Join-Path $root '.local\launcher\launch.json')
            Write-QStudyInstallJson $configPath $config
            Protect-QStudyNativePath $configPath
            $stage = 'проверка существующих аккаунтов'
            & $runtime.python -I (Join-Path $root 'scripts\launcher\setup.py') --config $configPath
            $setupExitCode = $LASTEXITCODE
            if (Test-Path -LiteralPath $dataset.database -PathType Leaf) {
                $choicePath = Join-Path $root '.local\launcher\data-choice.json'
                Write-QStudyInstallJson $choicePath @{ version = 1; source = $dataset.source; had_database = $true }
                Protect-QStudyNativePath $choicePath
            }
            if ($setupExitCode -ne 0) { throw 'QStudy: первый администратор не подтверждён. Сайт не опубликован; существующие аккаунты и настройки сохранены.' }
            $stage = 'запуск приложения'
            $entry = Join-Path $root 'scripts\launcher\supervisor.py'
            $supervisor = Start-QStudyProcess -Name 'supervisor' -Executable $runtime.python -Arguments @('-I', $entry, '--config', $configPath, '--instance', $instance) -Directory $root -Marker $entry -Instance $instance -Port 0 -Url ''
            $state = [PSCustomObject]@{ version = 3; root = $root; computer = (Get-QStudyComputerFingerprint); owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value;
                instance = $instance; mode = $Mode; data_source = $dataset.source; backend_hash = $backendHash; backend_port = $backendPort; frontend_port = $frontendPort;
                site_url = $context.site_url; bind = $bind; supervisor = $supervisor; backend = $null; frontend = $null }
            $statePath = Assert-QStudyNativePath $root (Join-Path $root '.local\launcher\state.json')
            Write-QStudyInstallJson $statePath $state; Protect-QStudyNativePath $statePath
            $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds * 2 + 20)
            do {
                if ($null -eq (Get-QStudyOwnedProcess $supervisor.identity)) { throw ('QStudy: приложение завершилось при запуске. Лог: ' + $supervisor.stderr) }
                $managed = Read-QStudyInstallJson (Join-Path $root '.local\managed\status.json')
                if ($null -ne $managed -and $managed.instance -ceq $instance) {
                    if ($managed.state -ceq 'failed') { throw ('QStudy: приложение не прошло проверку. Причина: ' + $managed.message + '. Логи: .local/logs/backend-' + $instance + '.log и frontend-' + $instance + '.log') }
                    if ($managed.state -ceq 'running') { break }
                }
                if ([DateTime]::UtcNow -ge $deadline) { throw 'QStudy: превышено время запуска. Посмотрите отдельные логи API и интерфейса в .local/logs.' }
                Start-Sleep -Milliseconds 500
            } while ($true)
            $state.backend = New-QStudyNativeChildRecord 'backend' ([int]$managed.backend_pid) $root $instance $backendPort '127.0.0.1'
            $state.frontend = New-QStudyNativeChildRecord 'frontend' ([int]$managed.frontend_pid) $root $instance $frontendPort $bind (($context.site_url -split '//', 2)[1])
            Wait-QStudyReady $state.backend 10; Wait-QStudyReady $state.frontend 10
            Write-QStudyInstallJson $statePath $state; Protect-QStudyNativePath $statePath
            $choicePath = Join-Path $root '.local\launcher\data-choice.json'
            Write-QStudyInstallJson $choicePath @{ version = 1; source = $dataset.source; had_database = $true }; Protect-QStudyNativePath $choicePath
        }
    }
    if ($Mode -cne 'install') {
        $stage = 'настройка доступа'
        Set-QStudyNativeNetwork -Root $root -Mode $Mode -Port ([int]$state.frontend_port) -PublicIP $context.public_ip -SiteUrl $state.site_url
        Write-Host ('Сайт: ' + $state.site_url)
        Write-Host ('Логи: ' + (Join-Path $root '.local\logs'))
        if ($Mode -ceq 'internet') { Write-Host 'Проверьте адрес с телефона с выключенным Wi-Fi. HTTP передаёт данные без шифрования.' }
        if (-not $NoBrowser) { Start-Process -FilePath $state.site_url | Out-Null }
    }
} catch {
    $failed = $true
    Write-Host ('QStudy: этап «' + $stage + '» не завершён. ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Аккаунты, база и настройки не сбрасывались. Повторите ту же кнопку после исправления причины.'
} finally { if ($null -ne $lock) { $lock.Dispose() } }
if (-not $NoPause) { [void](Read-Host 'Нажмите Enter, чтобы закрыть окно. Приложение продолжит работать.') }
if ($failed) { exit 1 }
exit 0
