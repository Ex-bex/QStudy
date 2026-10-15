# The root launch and stop buttons use this native Windows runtime. No data restore.
. (Join-Path $PSScriptRoot '..\QStudy.Common.ps1')
. (Join-Path $PSScriptRoot '..\QStudy.Install.ps1')

function Assert-QStudyNativePath([string]$Root, [string]$Path) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($Path)
    if ($candidate -ne $base -and -not $candidate.StartsWith($base + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'QStudy: путь выходит за пределы проекта.' }
    $current = $candidate
    while ($current -and $current.Length -ge $base.Length) {
        if ((Test-Path -LiteralPath $current) -and ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'QStudy: папка запуска или данных содержит ссылку. Данные не изменены.' }
        if ([string]::Equals($current, $base, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
    }
    return $candidate
}

function Protect-QStudyNativePath([string]$Path) {
    $item = Get-Item -LiteralPath $Path -Force
    $acl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow))
    }
    $item.SetAccessControl($acl)
}

function Initialize-QStudyNativeStorage([string]$Root) {
    foreach ($relative in @('.local', '.local\launcher', '.local\managed', '.local\transfers', '.local\logs')) {
        $path = Assert-QStudyNativePath $Root (Join-Path $Root $relative)
        [IO.Directory]::CreateDirectory($path) | Out-Null
        Protect-QStudyNativePath $path
    }
}

function Get-QStudyNativeDataset([string]$Root) {
    $choicePath = Assert-QStudyNativePath $Root (Join-Path $Root '.local\launcher\data-choice.json')
    $localDB = Assert-QStudyNativePath $Root (Join-Path $Root 'backend\studyhub.db')
    $productionDB = Assert-QStudyNativePath $Root (Join-Path $Root 'deployment\data\backend\studyhub.db')
    $source = ''
    if (Test-Path -LiteralPath $choicePath -PathType Leaf) {
        try { $choice = [IO.File]::ReadAllText($choicePath) | ConvertFrom-Json; $source = [string]$choice.source }
        catch { throw 'QStudy: не удалось прочитать выбранное хранилище. Обе базы сохранены.' }
        if ($source -cnotin @('local', 'deployment')) { throw 'QStudy: неизвестное выбранное хранилище. Обе базы сохранены.' }
    } elseif ((Test-Path -LiteralPath $localDB -PathType Leaf) -and (Test-Path -LiteralPath $productionDB -PathType Leaf)) {
        $localHash = Get-QStudyInstallHash $localDB
        $productionHash = Get-QStudyInstallHash $productionDB
        $liveSidecar = $false
        foreach ($databasePath in @($localDB, $productionDB)) {
            foreach ($suffix in @('-wal', '-journal')) {
                $sidecar = Assert-QStudyNativePath $Root ($databasePath + $suffix)
                if ((Test-Path -LiteralPath $sidecar -PathType Leaf) -and (Get-Item -LiteralPath $sidecar).Length -gt 0) { $liveSidecar = $true }
            }
        }
        if ($localHash -ceq $productionHash -and -not $liveSidecar) { $source = 'local' }
        else {
            Write-Host 'Найдены две разные базы QStudy. Они останутся на своих местах; выберите, какую использовать во всех режимах.'
            Write-Host '1 — Текущие локальные аккаунты и материалы (backend/studyhub.db).'
            Write-Host '2 — Существующие аккаунты интернет-установки (deployment/data/backend/studyhub.db).'
            $answer = Read-Host 'Выберите 1 или 2; 0 — отмена'
            if ($answer -ceq '1') { $source = 'local' } elseif ($answer -ceq '2') { $source = 'deployment' } else { throw 'QStudy: запуск отменён. Обе базы сохранены.' }
        }
    } elseif (Test-Path -LiteralPath $productionDB -PathType Leaf) { $source = 'deployment' }
    else { $source = 'local' }
    $selectedDB = if ($source -ceq 'local') { $localDB } else { $productionDB }
    # A saved choice must not silently fall back to another or empty database.
    if ((Test-Path -LiteralPath $choicePath) -and (Get-QStudyInstallProperty $choice 'had_database' $true) -and -not (Test-Path -LiteralPath $selectedDB -PathType Leaf)) { throw 'QStudy: выбранная база недоступна. Запуск остановлен; другое хранилище не выбрано.' }
    if (-not (Test-Path -LiteralPath $choicePath)) {
        Write-QStudyInstallJson $choicePath @{ version = 1; source = $source; had_database = [bool](Test-Path -LiteralPath $selectedDB -PathType Leaf) }
        Protect-QStudyNativePath $choicePath
    } elseif ((Test-Path -LiteralPath $selectedDB -PathType Leaf) -and -not (Get-QStudyInstallProperty $choice 'had_database' $true)) {
        Write-QStudyInstallJson $choicePath @{ version = 1; source = $source; had_database = $true }
        Protect-QStudyNativePath $choicePath
    }
    $envPath = Assert-QStudyNativePath $Root (Join-Path $Root $(if ($source -ceq 'local') { 'backend\.env' } else { 'deployment\.env' }))
    return [PSCustomObject]@{ source = $source; database = $selectedDB; env_file = $envPath }
}

function Get-QStudyNativeBuildHash([string]$Root) {
    $lines = [Text.StringBuilder]::new()
    $paths = [Collections.Generic.List[string]]::new()
    foreach ($relative in @('app', 'components', 'lib', 'types', 'public')) {
        $folder = Join-Path $Root ('frontend\' + $relative)
        if (Test-Path -LiteralPath $folder -PathType Container) {
            foreach ($file in @(Get-ChildItem -LiteralPath $folder -File -Recurse -Force)) {
                $paths.Add((Assert-QStudyNativePath $Root $file.FullName))
            }
        }
    }
    foreach ($relative in @('package.json', 'package-lock.json', 'next.config.ts', 'postcss.config.mjs', 'tsconfig.json', 'proxy.ts', 'middleware.ts', 'server.mjs')) {
        $path = Join-Path $Root ('frontend\' + $relative)
        if (Test-Path -LiteralPath $path -PathType Leaf) { $paths.Add((Assert-QStudyNativePath $Root $path)) }
    }
    foreach ($path in @($paths | Sort-Object)) { [void]$lines.Append($path.Substring($Root.Length)).Append(':').Append((Get-QStudyInstallHash $path)).Append("`n") }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($lines.ToString())))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Get-QStudyNativeBackendHash([string]$Root) {
    $lines = [Text.StringBuilder]::new()
    foreach ($relative in @('backend\app', 'scripts\launcher')) {
        foreach ($file in @(Get-ChildItem -LiteralPath (Join-Path $Root $relative) -Recurse -File -Force | Where-Object { $_.FullName -notmatch '[\\/]__pycache__[\\/]' -and $_.Extension -ne '.pyc' } | Sort-Object FullName)) {
            $path = Assert-QStudyNativePath $Root $file.FullName
            [void]$lines.Append($path.Substring($Root.Length)).Append(':').Append((Get-QStudyInstallHash $path)).Append("`n")
        }
    }
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($lines.ToString())))).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
}

function Ensure-QStudyNativeBuild([string]$Root, $Runtime, [switch]$Repair) {
    $hash = Get-QStudyNativeBuildHash $Root
    $path = Join-Path $Root '.local\launcher\build.json'
    $previous = Read-QStudyInstallJson $path
    if (-not $Repair -and $null -ne $previous -and $previous.hash -ceq $hash -and $previous.node -ceq $Runtime.nodeVersion -and (Get-QStudyInstallProperty $previous 'root' '') -ceq $Root -and (Get-QStudyInstallProperty $previous 'computer' '') -ceq (Get-QStudyComputerFingerprint) -and (Test-Path -LiteralPath (Join-Path $Root 'frontend\.next\BUILD_ID') -PathType Leaf)) { return }
    $savedPath = $env:PATH; $savedMode = $env:NODE_ENV
    try {
        $env:PATH = (Split-Path -Parent $Runtime.node) + ';' + $savedPath
        $env:NODE_ENV = 'production'
        Write-Host 'Подготовка production-интерфейса QStudy. Первый запуск может занять несколько минут…'
        Invoke-QStudyInstallCommand $Runtime.node @((Join-Path $Root 'frontend\node_modules\next\dist\bin\next'), 'build') (Join-Path $Root 'frontend') 'Сборка интерфейса'
    } finally { $env:PATH = $savedPath; $env:NODE_ENV = $savedMode }
    Write-QStudyInstallJson $path @{ version = 1; hash = $hash; node = $Runtime.nodeVersion; root = $Root; computer = (Get-QStudyComputerFingerprint) }
    Protect-QStudyNativePath $path
}

function Read-QStudyNativeState([string]$Root) {
    $path = Assert-QStudyNativePath $Root (Join-Path $Root '.local\launcher\state.json')
    $state = Read-QStudyInstallJson $path
    if ($null -eq $state) { return $null }
    if ($state.version -ne 3 -or $state.root -cne $Root -or $state.computer -cne (Get-QStudyComputerFingerprint) -or $state.owner_sid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) { return $null }
    return $state
}

function Get-QStudyNativeStorageOwner([string]$Path) {
    return (Get-Item -LiteralPath $Path -Force).GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
}

function Assert-QStudyNativeStopOwner([string]$Root) {
    $localPath = Assert-QStudyNativePath $Root (Join-Path $Root '.local')
    if (-not (Test-Path -LiteralPath $localPath)) { return }
    $caller = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not (Test-Path -LiteralPath $localPath -PathType Container) -or (Get-QStudyNativeStorageOwner $localPath) -cne $caller) {
        throw 'QStudy: остановите сайт из того же Windows-аккаунта, которым он был запущен. Владелец и права служебной папки не изменены.'
    }
    $state = Read-QStudyInstallJson (Join-Path $Root '.local\launcher\state.json')
    if ($null -ne $state -and $state.root -ceq $Root -and $state.computer -ceq (Get-QStudyComputerFingerprint) -and $state.owner_sid -cne $caller) {
        throw 'QStudy: действующий запуск принадлежит другому Windows-аккаунту. Процессы, данные и права доступа не изменены.'
    }
}

function Stop-QStudyNativeState([string]$Root, $State, $Runtime) {
    if ($null -eq $State) { return }
    # Admin restart replaces child PIDs. Recover only the latest private status
    # for this same random instance; validate executable command markers again.
    $managed = Read-QStudyInstallJson (Join-Path $Root '.local\managed\status.json')
    if ($null -ne $managed -and $managed.instance -ceq $State.instance -and $managed.root_owner -ceq $Root) {
        foreach ($name in @('backend', 'frontend')) {
            $childId = [int](Get-QStudyInstallProperty $managed ($name + '_pid') 0)
            if ($childId -gt 0) {
                try {
                    $childBind = if ($name -ceq 'backend') { '127.0.0.1' } else { $State.bind }
                    $childHost = if ($name -ceq 'frontend') { ($State.site_url -split '//', 2)[1] } else { '' }
                    $State.$name = New-QStudyNativeChildRecord $name $childId $Root $State.instance ([int]$State.($name + '_port')) $childBind $childHost
                } catch { } # A reused PID never becomes an authorized process.
            }
        }
    }
    $supervisor = Get-QStudyOwnedProcess $State.supervisor.identity
    if ($null -ne $supervisor) {
        $configPath = Assert-QStudyNativePath $Root (Join-Path $Root '.local\launcher\launch.json')
        $config = Read-QStudyInstallJson $configPath
        if ($null -eq $config -or $config.root -cne $Root -or $config.instance -cne $State.instance -or $config.owner_sid -cne $State.owner_sid) {
            throw 'QStudy: состояние управления не соответствует действующему запуску. Процессы и данные сохранены.'
        }
        # Stopping must not install dependencies or trust a copied runtime path.
        & $supervisor.ExecutablePath -I (Join-Path $Root 'scripts\launcher\control.py') --config $configPath --action stop
        if ($LASTEXITCODE -ne 0) { throw 'QStudy: уже выполняется команда администратора. Дождитесь её завершения и повторите запуск.' }
        $deadline = [DateTime]::UtcNow.AddSeconds(100)
        while ($null -ne (Get-QStudyOwnedProcess $State.supervisor.identity) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
        if ($null -ne (Get-QStudyOwnedProcess $State.supervisor.identity)) { throw 'QStudy: приложение ещё завершает задачи. Данные сохранены; повторите запуск через минуту.' }
    }
    # An interrupted supervisor can leave only its originally verified children.
    foreach ($name in @('frontend', 'backend')) { if ($null -ne $State.$name) { Stop-QStudyRecord $State.$name } }
}

function Stop-QStudySite([string]$Root) {
    $state = Read-QStudyNativeState $Root
    if ($null -ne $state) {
        Stop-QStudyNativeState $Root $state $null
        $statePath = Assert-QStudyNativePath $Root (Join-Path $Root '.local\launcher\state.json')
        foreach ($name in @('supervisor', 'frontend', 'backend')) {
            if ($null -ne $state.$name -and $null -ne (Get-QStudyOwnedProcess $state.$name.identity)) {
                throw 'QStudy: сайт ещё завершает работу. Повторите Stop-QStudy.cmd через минуту; состояние сохранено.'
            }
        }
        # Clear process state only after success. Keep data choice and settings.
        if (Test-Path -LiteralPath $statePath -PathType Leaf) { Remove-Item -LiteralPath $statePath -Force }
    }
    # The original development launcher has its own ownership-checked state.
    # Never kill arbitrary python/node processes or processes on an occupied port.
    $legacy = Read-QStudyState
    foreach ($name in @('frontend', 'backend')) {
        if ($null -ne $legacy.$name) {
            Stop-QStudyRecord $legacy.$name
            $legacy.$name = $null
            Write-QStudyState $legacy
        }
    }
    Disable-QStudyNativeNetwork -Root $Root
}

function New-QStudyNativeChildRecord([string]$Name, [int]$ProcessId, [string]$Root, [string]$Instance, [int]$Port, [string]$Bind, [string]$HostHeader = '') {
    $process = Get-QStudyProcess $ProcessId
    if ($null -eq $process) { throw 'QStudy: процесс приложения завершился. Посмотрите отдельный лог API или интерфейса.' }
    $marker = if ($Name -ceq 'backend') { Join-Path $Root 'scripts\launcher\backend.py' } else { Join-Path $Root 'frontend\server.mjs' }
    $record = [PSCustomObject]@{ name = $Name; port = $Port; bind = $Bind; url = ('http://127.0.0.1:' + $Port + '/api/health'); host = $HostHeader;
        identity = (New-QStudyProcessIdentity $process $marker $Instance); descendants = @();
        stdout = (Join-Path $Root ('.local\logs\' + $Name + '-' + $Instance + '.log')); stderr = (Join-Path $Root ('.local\logs\' + $Name + '-' + $Instance + '.log'));
        pid = $ProcessId; created = $process.CreationDate.ToUniversalTime().ToString('o'); exe = [string]$process.ExecutablePath;
        created_utc = $process.CreationDate.ToUniversalTime().ToString('o'); executable = [string]$process.ExecutablePath; marker = $marker }
    if ($null -eq (Get-QStudyOwnedProcess $record.identity)) { throw 'QStudy: владелец процесса приложения не подтверждён. Чужой процесс не изменён.' }
    return $record
}
