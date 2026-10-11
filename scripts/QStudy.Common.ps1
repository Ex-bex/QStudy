Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:QStudyRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$script:QStudyLocal = Join-Path $script:QStudyRoot '.local'
$script:QStudyStateFile = Join-Path $script:QStudyLocal 'processes.json'

function Enter-QStudyLock {
    [IO.Directory]::CreateDirectory($script:QStudyLocal) | Out-Null
    $path = Join-Path $script:QStudyLocal 'launcher.lock'
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { Start-Sleep -Milliseconds 200 }
    }
    throw 'Другой запуск или остановка QStudy ещё выполняется. Повторите через несколько секунд.'
}

function Get-QStudyComputerFingerprint {
    $machine = [Environment]::MachineName
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
        if ($null -ne $key -and $key.GetValue('MachineGuid')) { $machine += ':' + [string]$key.GetValue('MachineGuid') }
    } catch { }
    finally { if ($null -ne $key) { $key.Dispose() } }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($machine)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function New-QStudyState([string]$PreviousWorkspace = '') {
    return [PSCustomObject]@{
        version = 2; workspace = $script:QStudyRoot; computer = (Get-QStudyComputerFingerprint)
        previousWorkspace = $PreviousWorkspace; mode = 'local'; bind = '127.0.0.1'
        runMode = 'development'; siteUrl = ''; browserUrl = ''; localUrl = ''; lanUrls = @()
        backend = $null; frontend = $null
    }
}

function Read-QStudyState {
    if (-not (Test-Path -LiteralPath $script:QStudyStateFile)) {
        return New-QStudyState
    }
    try { $state = [IO.File]::ReadAllText($script:QStudyStateFile) | ConvertFrom-Json }
    catch { throw 'Повреждён .local/processes.json. Автоматическое управление процессами остановлено; чужие процессы не затронуты.' }
    if ($state.version -notin @(1, 2)) { throw 'Неизвестная версия состояния запуска. Процессы не изменены.' }
    $moved = -not [string]::Equals($state.workspace, $script:QStudyRoot, [StringComparison]::OrdinalIgnoreCase)
    $otherComputer = $state.version -eq 2 -and $state.computer -ne (Get-QStudyComputerFingerprint)
    if ($moved -or $otherComputer) {
        # Copied process IDs belong to another workspace or computer. Never stop
        # them, even if the same PID happens to exist on the new computer.
        $archive = Join-Path $script:QStudyLocal 'stale-state'
        [IO.Directory]::CreateDirectory($archive) | Out-Null
        $archiveFile = Join-Path $archive ("processes-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.json')
        Move-Item -LiteralPath $script:QStudyStateFile -Destination $archiveFile
        Write-Host 'Обнаружена перенесённая копия проекта. Старое состояние запуска помещено в архив.'
        return New-QStudyState ([string]$state.workspace)
    }
    if ($state.version -eq 1) {
        $converted = New-QStudyState
        $converted.backend = $state.backend
        $converted.frontend = $state.frontend
        if ($null -ne $converted.frontend) {
            $converted.localUrl = 'http://127.0.0.1:' + $converted.frontend.port
            $converted.siteUrl = $converted.localUrl
            $converted.browserUrl = $converted.localUrl
        }
        return $converted
    }
    return $state
}

function Write-QStudyState($State) {
    $temporary = Join-Path $script:QStudyLocal 'processes.pending.json'
    [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $script:QStudyStateFile -Force
}

function Get-QStudyProcess([int]$ProcessId) {
    try { return Get-CimInstance -ClassName Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction Stop }
    catch { return $null }
}

function New-QStudyProcessIdentity($Process, [string]$Marker = '', [string]$Instance = '') {
    return [PSCustomObject]@{
        processId = [int]$Process.ProcessId
        createdUtc = $Process.CreationDate.ToUniversalTime().ToString('o')
        executable = [string]$Process.ExecutablePath
        marker = $Marker
        instance = $Instance
    }
}

function Get-QStudyOwnedProcess($Identity) {
    if ($null -eq $Identity) { return $null }
    $process = Get-QStudyProcess ([int]$Identity.processId)
    if ($null -eq $process) { return $null }
    if ($process.CreationDate.ToUniversalTime().ToString('o') -ne $Identity.createdUtc) { return $null }
    if (-not [string]::Equals($process.ExecutablePath, $Identity.executable, [StringComparison]::OrdinalIgnoreCase)) { return $null }
    if ($Identity.marker -and ($null -eq $process.CommandLine -or $process.CommandLine.IndexOf($Identity.marker, [StringComparison]::OrdinalIgnoreCase) -lt 0)) { return $null }
    if ($Identity.instance -and ($null -eq $process.CommandLine -or -not $process.CommandLine.Contains($Identity.instance))) { return $null }
    return $process
}

function Get-QStudyDescendants($Identity) {
    $rootProcess = Get-QStudyOwnedProcess $Identity
    if ($null -eq $rootProcess) { return @() }
    $queue = [Collections.Generic.Queue[object]]::new()
    $queue.Enqueue($rootProcess)
    $found = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[int]]::new()
    [void]$seen.Add([int]$rootProcess.ProcessId)
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        $parentIdentity = New-QStudyProcessIdentity $parent
        if ($null -eq (Get-QStudyOwnedProcess $parentIdentity)) { continue }
        $children = @(Get-CimInstance -ClassName Win32_Process -Filter "ParentProcessId = $($parent.ProcessId)" -ErrorAction SilentlyContinue)
        if ($null -eq (Get-QStudyOwnedProcess $parentIdentity)) { continue }
        foreach ($child in $children) {
            if ($child.CreationDate -lt $parent.CreationDate -or -not $seen.Add([int]$child.ProcessId)) { continue }
            $found.Add((New-QStudyProcessIdentity $child))
            $queue.Enqueue($child)
        }
    }
    return @($found.ToArray())
}

function Update-QStudyDescendants($Record) {
    $known = @{}
    foreach ($identity in @($Record.descendants) + @(Get-QStudyDescendants $Record.identity)) {
        if ($null -ne $identity -and $null -ne (Get-QStudyOwnedProcess $identity)) {
            $known[[string]$identity.processId] = $identity
        }
    }
    $Record.descendants = @($known.Values)
}

function Stop-QStudyRecord($Record) {
    if ($null -eq $Record) { return }
    if (-not ('QStudy.Local.DetachedProcess' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'QStudy.DetachedProcess.cs') }
    Update-QStudyDescendants $Record
    # The root identity and every child are checked again immediately before stopping.
    # Creation time prevents PID reuse from targeting another application.
    # Stop the parent first so a development server cannot respawn a child.
    $owned = @($Record.identity) + @($Record.descendants | Sort-Object createdUtc -Descending)
    foreach ($identity in $owned) {
        if ($null -ne (Get-QStudyOwnedProcess $identity)) {
            $created = [DateTime]::Parse($identity.createdUtc, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToFileTimeUtc()
            [void][QStudy.Local.DetachedProcess]::Stop([int]$identity.processId, $created, $identity.executable)
        }
    }
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        $alive = @($owned | Where-Object { $null -ne (Get-QStudyOwnedProcess $_) })
        if ($alive.Count -eq 0) { return }
        Start-Sleep -Milliseconds 100
    }
    throw "Не удалось остановить собственный процесс $($Record.name). Состояние сохранено для повторной попытки."
}

function Get-QStudyListeners([int]$Port) {
    return @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
}

function Test-QStudyPortUsable([int]$Port, [string]$Bind = '127.0.0.1') {
    if (@(Get-QStudyListeners $Port).Count -gt 0) { return $false }
    $socket = $null
    try {
        # Binding also detects excluded/reserved Windows ports and listeners that
        # cannot be queried by the current account.
        $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($Bind), $Port)
        $socket.Server.ExclusiveAddressUse = $true
        $socket.Start()
        return $true
    } catch [Net.Sockets.SocketException] { return $false }
    finally { if ($null -ne $socket) { $socket.Stop() } }
}

function Find-QStudyFreePort([int]$Preferred, [string]$Bind = '127.0.0.1', [int[]]$Exclude = @()) {
    for ($offset = 0; $offset -lt 128; $offset++) {
        $candidate = $Preferred + $offset
        if ($candidate -gt 65535) { break }
        if ($Exclude -notcontains $candidate -and (Test-QStudyPortUsable $candidate $Bind)) { return $candidate }
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        $socket = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Parse($Bind), 0)
        try { $socket.Start(); $candidate = [int]$socket.LocalEndpoint.Port }
        finally { $socket.Stop() }
        if ($Exclude -notcontains $candidate -and (Test-QStudyPortUsable $candidate $Bind)) { return $candidate }
    }
    throw 'Не удалось подобрать свободный TCP-порт. Проверьте настройки сети Windows.'
}

function Get-QStudyLanAddresses {
    try {
        $addresses = @(Get-NetIPConfiguration -ErrorAction Stop | Where-Object {
            $null -ne $_.NetAdapter -and $_.NetAdapter.Status -eq 'Up'
        } | Sort-Object @{ Expression = { if ($null -ne $_.IPv4DefaultGateway) { 0 } else { 1 } } }, InterfaceIndex | ForEach-Object {
            $_.IPv4Address | ForEach-Object { $_.IPAddress }
        } | Where-Object { $_ -and $_ -notlike '127.*' -and $_ -notlike '169.254.*' -and $_ -ne '0.0.0.0' } | Select-Object -Unique)
        return $addresses
    } catch { return @() }
}

function Set-QStudyAddresses($State, [int]$FrontendPort, [bool]$Lan) {
    $State.mode = if ($Lan) { 'lan' } else { 'local' }
    $State.bind = if ($Lan) { '0.0.0.0' } else { '127.0.0.1' }
    $State.localUrl = 'http://127.0.0.1:' + $FrontendPort
    if ($Lan) { $State.lanUrls = @(Get-QStudyLanAddresses | ForEach-Object { 'http://' + $_ + ':' + $FrontendPort }) }
    else { $State.lanUrls = @() }
    $State.siteUrl = if (@($State.lanUrls).Count -gt 0) { @($State.lanUrls)[0] } else { $State.localUrl }
    $State.browserUrl = $State.siteUrl
}

function Test-QStudyForeignListener($Record) {
    if ($null -eq $Record) { return $false }
    Update-QStudyDescendants $Record
    $ids = @($Record.identity.processId) + @($Record.descendants | ForEach-Object { $_.processId })
    return @(Get-QStudyListeners ([int]$Record.port) | Where-Object { $ids -notcontains [int]$_.OwningProcess }).Count -gt 0
}

function Assert-QStudyListenerOwned($Record) {
    Update-QStudyDescendants $Record
    $ids = @($Record.identity.processId) + @($Record.descendants | ForEach-Object { $_.processId })
    $listeners = @(Get-QStudyListeners ([int]$Record.port))
    if ($listeners.Count -eq 0) { throw "Процесс $($Record.name) не открыл порт $($Record.port)." }
    foreach ($listener in $listeners) {
        $expectedBind = if ($Record.PSObject.Properties.Name -contains 'bind') { $Record.bind } else { '127.0.0.1' }
        if ($listener.LocalAddress -ne $expectedBind -or $ids -notcontains [int]$listener.OwningProcess) {
            throw "PORT_COLLISION: порт $($Record.port) не принадлежит процессу QStudy с нужным адресом. Запуск прерван."
        }
    }
}

function Wait-QStudyReady($Record, [int]$TimeoutSeconds) {
    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while ([DateTime]::UtcNow -lt $deadline) {
        if (Test-QStudyForeignListener $Record) { throw "PORT_COLLISION: порт $($Record.port) заняло другое приложение." }
        if ($null -eq (Get-QStudyOwnedProcess $Record.identity)) {
            throw "Процесс $($Record.name) завершился при запуске. Проверьте $($Record.stderr)."
        }
        Update-QStudyDescendants $Record
        try {
            $request = [Net.HttpWebRequest]::Create($Record.url)
            $request.Proxy = $null
            $request.Timeout = 3000
            $response = $request.GetResponse()
            try {
                $statusCode = [int]$response.StatusCode
                $reader = [IO.StreamReader]::new($response.GetResponseStream(), [Text.Encoding]::UTF8)
                try { $responseBody = $reader.ReadToEnd() } finally { $reader.Dispose() }
            } finally { $response.Dispose() }
            if ($statusCode -eq 200) {
                if ($Record.name -eq 'backend' -and (($responseBody | ConvertFrom-Json).service -ne 'QStudy')) {
                    throw 'На порту API отвечает другое приложение.'
                }
                Assert-QStudyListenerOwned $Record
                return
            }
        } catch {
            if ($_.Exception.Message -like '*другое приложение*' -or $_.Exception.Message -like '*PORT_COLLISION:*') { throw }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "Превышено время ожидания $($Record.name). Проверьте $($Record.stderr) и $($Record.stdout)."
}

function Resolve-QStudyRuntime([string]$Requested, [string]$Kind) {
    $candidates = [Collections.Generic.List[string]]::new()
    if ($Requested) {
        $explicit = [IO.Path]::GetFullPath($Requested)
        if (-not (Test-Path -LiteralPath $explicit -PathType Leaf)) { throw "Указанный путь $Kind не существует: $explicit" }
        return $explicit
    }
    $runtimeFile = Join-Path $script:QStudyLocal 'runtime.json'
    if (Test-Path -LiteralPath $runtimeFile -PathType Leaf) {
        try {
            $runtime = [IO.File]::ReadAllText($runtimeFile) | ConvertFrom-Json
            if ([string]::Equals($runtime.workspace, $script:QStudyRoot, [StringComparison]::OrdinalIgnoreCase)) { $candidates.Add([string]$runtime.$Kind) }
        } catch { }
    }
    if ($Kind -eq 'python') {
        $candidates.Add((Join-Path $script:QStudyRoot 'backend\.venv\Scripts\python.exe'))
        $candidates.Add((Join-Path $script:QStudyRoot 'backend\venv\Scripts\python.exe'))
        if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe')) }
        $command = Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $candidates.Add($command.Source) }
    } else {
        $command = Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($command) { $candidates.Add($command.Source) }
        if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
    }
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) { return [IO.Path]::GetFullPath($candidate) }
    }
    throw "Не найден $Kind. Установите runtime по README.md или передайте явный путь в параметре запуска."
}

function Start-QStudyProcess([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$Directory, [string]$Marker, [string]$Instance, [int]$Port, [string]$Url, [string]$Bind = '127.0.0.1') {
    if (-not ('QStudy.Local.DetachedProcess' -as [type])) { Add-Type -Path (Join-Path $PSScriptRoot 'QStudy.DetachedProcess.cs') }
    $logs = Join-Path $script:QStudyLocal 'logs'
    [IO.Directory]::CreateDirectory($logs) | Out-Null
    $prefix = "$Name-$(Get-Date -Format 'yyyyMMdd-HHmmss')-$($Instance.Substring(0, 8))"
    $stdout = Join-Path $logs "$prefix.stdout.log"
    $stderr = Join-Path $logs "$prefix.stderr.log"
    $processId = [QStudy.Local.DetachedProcess]::Start($Executable, $Arguments, $Directory, $stdout, $stderr)
    $process = Get-QStudyProcess $processId
    if ($null -eq $process) { throw "Процесс $Name завершился сразу после запуска. Лог: $stderr" }
    return [PSCustomObject]@{
        name = $Name; port = $Port; url = $Url; bind = $Bind
        identity = (New-QStudyProcessIdentity $process $Marker $Instance)
        descendants = @(); stdout = $stdout; stderr = $stderr
    }
}
