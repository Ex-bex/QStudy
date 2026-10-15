# This file is saved as UTF-8 with BOM for Windows PowerShell 5.1.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$script:QStudyInstallScriptDirectory = $PSScriptRoot

$qstudyOcrModule = Join-Path $PSScriptRoot 'QStudy.Ocr.ps1'
if (Test-Path -LiteralPath $qstudyOcrModule -PathType Leaf) { . $qstudyOcrModule }

function Get-QStudyInstallRoot([string]$RootPath = '') {
    if (-not $RootPath) { $RootPath = Split-Path -Parent $script:QStudyInstallScriptDirectory }
    $root = [IO.Path]::GetFullPath($RootPath).TrimEnd([IO.Path]::DirectorySeparatorChar)
    foreach ($required in @('backend\requirements.txt', 'frontend\package.json', 'frontend\package-lock.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $root $required) -PathType Leaf)) {
            throw "Неполная папка проекта: отсутствует $required. Перенесите backend, frontend и scripts вместе."
        }
    }
    return $root
}

function Get-QStudyFileDigest([string]$Path, [string]$Algorithm = 'SHA256') {
    if ($Algorithm -notin @('SHA256', 'SHA512')) { throw 'Недопустимый алгоритм проверки файла.' }
    $hasher = [Security.Cryptography.HashAlgorithm]::Create($Algorithm)
    $stream = [IO.File]::OpenRead($Path)
    try { return ([BitConverter]::ToString($hasher.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $hasher.Dispose() }
}

function Get-QStudyInstallHash([string]$Path) {
    return Get-QStudyFileDigest $Path 'SHA256'
}

function Get-QStudyDependencyHash([string]$Root) {
    $requirementsHash = Get-QStudyInstallHash (Join-Path $Root 'backend\requirements.txt')
    $constraints = Join-Path $Root 'backend\requirements.lock.txt'
    if (-not (Test-Path -LiteralPath $constraints -PathType Leaf)) { return $requirementsHash }
    $combined = $requirementsHash + ':' + (Get-QStudyInstallHash $constraints)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($combined)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Get-QStudyInstallComputerFingerprint {
    $machine = [Environment]::MachineName
    $key = $null
    try {
        $key = [Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SOFTWARE\Microsoft\Cryptography')
        if ($null -ne $key) {
            $guid = [string]$key.GetValue('MachineGuid', '')
            if ($guid) { $machine += ':' + $guid }
        }
    } catch { }
    finally { if ($null -ne $key) { $key.Dispose() } }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($machine)))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
}

function Read-QStudyInstallJson([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try { return [IO.File]::ReadAllText($Path) | ConvertFrom-Json }
    catch { return $null }
}

function Get-QStudyInstallProperty($Object, [string]$Name, $Default = $null) {
    if ($null -eq $Object -or $null -eq $Object.PSObject.Properties[$Name]) { return $Default }
    return $Object.$Name
}

function Write-QStudyInstallJson([string]$Path, $Value) {
    [IO.Directory]::CreateDirectory((Split-Path -Parent $Path)) | Out-Null
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    [IO.File]::WriteAllText($temporary, ($Value | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

function Get-QStudyWindowsArchitecture {
    $architecture = $env:PROCESSOR_ARCHITEW6432
    if (-not $architecture) { $architecture = $env:PROCESSOR_ARCHITECTURE }
    if ($architecture -eq 'ARM64') { return 'arm64' }
    if ($architecture -eq 'AMD64') { return 'x64' }
    throw 'QStudy требует 64-разрядную Windows 10/11 (x64 или Windows 11 ARM64).'
}

function Get-QStudyComputerInfo([string]$RootPath = '') {
    $root = Get-QStudyInstallRoot $RootPath
    $architecture = Get-QStudyWindowsArchitecture
    $os = Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue
    $cpu = Get-CimInstance Win32_Processor -ErrorAction SilentlyContinue | Select-Object -First 1
    $drive = $null
    try { $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($root)) } catch { }
    return [PSCustomObject]@{
        os = if ($os) { [string]$os.Caption } else { 'Windows' }
        osVersion = if ($os) { [string]$os.Version } else { [Environment]::OSVersion.Version.ToString() }
        architecture = $architecture
        processor = if ($cpu) { [string]$cpu.Name } else { $env:PROCESSOR_IDENTIFIER }
        memoryGB = if ($os) { [Math]::Round(([double]$os.TotalVisibleMemorySize / 1MB), 1) } else { $null }
        availableDiskGB = if ($drive -and $drive.IsReady) { [Math]::Round(($drive.AvailableFreeSpace / 1GB), 1) } else { $null }
        workspace = $root
    }
}

function Assert-QStudySupportedComputer([string]$Root) {
    $computer = Get-QStudyComputerInfo $Root
    $version = [version]$computer.osVersion
    if ($version.Major -lt 10 -or ($computer.architecture -eq 'arm64' -and $version.Build -lt 22000)) {
        throw 'Требуется Windows 10/11 x64 или Windows 11 ARM64. Устаревшая Windows не поддерживается выбранным Node.js.'
    }
    if ($null -ne $computer.availableDiskGB -and $computer.availableDiskGB -lt 2) {
        throw 'Для настройки освободите минимум 2 ГБ на диске с проектом.'
    }
}

function Test-QStudyPython([string]$Path, [switch]$BaseOnly) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf) -or $Path -like '*\WindowsApps\*') { return $null }
    try {
        $code = "import json, sys, struct, platform, venv, ensurepip; print(json.dumps({'version':platform.python_version(),'bits':struct.calcsize('P')*8,'machine':platform.machine(),'base':sys.prefix == sys.base_prefix}))"
        $result = & $Path -I -c $code 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $info = ($result -join '') | ConvertFrom-Json
        $version = [version]$info.version
        # x64 CPython also runs on Windows 11 ARM64 and has wheels for every pinned dependency.
        if ($version.Major -ne 3 -or $version.Minor -ne 13 -or $version.Build -lt 12 -or $info.bits -ne 64 -or $info.machine -ne 'AMD64' -or ($BaseOnly -and -not $info.base)) { return $null }
        return [PSCustomObject]@{ path = [IO.Path]::GetFullPath($Path); version = [string]$info.version }
    } catch { return $null }
}

function Test-QStudyNode([string]$Path) {
    if (-not $Path -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    try {
        $result = & $Path -e 'console.log(JSON.stringify({version:process.versions.node, arch:process.arch}))' 2>$null
        if ($LASTEXITCODE -ne 0) { return $null }
        $info = ($result -join '') | ConvertFrom-Json
        $version = [version]$info.version
        if ($version.Major -ne 24 -or $info.arch -notin @('x64', 'arm64')) { return $null }
        $npm = Join-Path (Split-Path -Parent $Path) 'node_modules\npm\bin\npm-cli.js'
        if (-not (Test-Path -LiteralPath $npm -PathType Leaf)) { return $null }
        return [PSCustomObject]@{ path = [IO.Path]::GetFullPath($Path); version = [string]$info.version; architecture = [string]$info.arch; npm = $npm }
    } catch { return $null }
}

function Get-QStudySettingsPath([string]$Root) {
    $choicePath = Join-Path $Root '.local\launcher\data-choice.json'
    $choice = Read-QStudyInstallJson $choicePath
    $productionOnly = (Test-Path -LiteralPath (Join-Path $Root 'deployment\data\backend\studyhub.db') -PathType Leaf) -and -not (Test-Path -LiteralPath (Join-Path $Root 'backend\studyhub.db') -PathType Leaf)
    if (($null -ne $choice -and (Get-QStudyInstallProperty $choice 'source' '') -ceq 'deployment') -or ($null -eq $choice -and $productionOnly)) { return Join-Path $Root 'deployment\.env' }
    return Join-Path $Root 'backend\.env'
}

function Test-QStudySecret([string]$Root) {
    $envPath = Get-QStudySettingsPath $Root
    if (-not (Test-Path -LiteralPath $envPath -PathType Leaf)) { return $false }
    $text = [IO.File]::ReadAllText($envPath)
    $match = [regex]::Match($text, '(?m)^\s*SECRET_KEY\s*=\s*([^\r\n#]+)')
    if (-not $match.Success) { return $false }
    $secret = $match.Groups[1].Value.Trim().Trim('"', "'")
    return $secret.Length -ge 32 -and $secret -notmatch '(?i)replace_with|change.?me|your.?secret|^secret$'
}

function Get-QStudyInstallationStatus([string]$RootPath = '') {
    $root = Get-QStudyInstallRoot $RootPath
    $runtime = Read-QStudyInstallJson (Join-Path $root '.local\runtime.json')
    $reasons = [Collections.Generic.List[string]]::new()
    $workspace = [string](Get-QStudyInstallProperty $runtime 'workspace' '')
    $machine = [string](Get-QStudyInstallProperty $runtime 'machineName' '')
    $fingerprint = [string](Get-QStudyInstallProperty $runtime 'machineFingerprint' '')
    $moved = $workspace -and (-not [string]::Equals($workspace, $root, [StringComparison]::OrdinalIgnoreCase) -or $machine -ne [Environment]::MachineName -or $fingerprint -ne (Get-QStudyInstallComputerFingerprint))
    if ($null -eq $runtime) { $reasons.Add('Первичная настройка окружения ещё не выполнена.') }
    elseif ($moved) { $reasons.Add('Проект перенесён в другую папку или на другой компьютер.') }
    $sameInstallation = $null -ne $runtime -and -not $moved -and (Get-QStudyInstallProperty $runtime 'version' 0) -eq 1
    $pythonInfo = $null
    $nodeInfo = $null
    if ($sameInstallation) {
        $pythonInfo = Test-QStudyPython ([string](Get-QStudyInstallProperty $runtime 'python' ''))
        $nodeInfo = Test-QStudyNode ([string](Get-QStudyInstallProperty $runtime 'node' ''))
    }
    $requirementsHash = Get-QStudyDependencyHash $root
    $lockHash = Get-QStudyInstallHash (Join-Path $root 'frontend\package-lock.json')
    $expectedPython = Join-Path $root 'backend\.venv\Scripts\python.exe'
    $backendReady = $sameInstallation -and $null -ne $pythonInfo -and [string]::Equals($pythonInfo.path, $expectedPython, [StringComparison]::OrdinalIgnoreCase) -and (Get-QStudyInstallProperty $runtime 'requirementsHash' '') -eq $requirementsHash -and (Test-Path -LiteralPath (Join-Path $root 'backend\.venv\pyvenv.cfg'))
    if ($backendReady) {
        foreach ($package in @('fastapi', 'uvicorn', 'sqlalchemy', 'pydantic', 'pydantic_settings', 'jwt', 'bcrypt', 'httpx', 'pymupdf', 'docx', 'openpyxl', 'pptx', 'multipart')) {
            if (-not (Test-Path -LiteralPath (Join-Path $root "backend\.venv\Lib\site-packages\$package"))) { $backendReady = $false; break }
        }
    }
    $frontendReady = $sameInstallation -and $null -ne $nodeInfo -and (Get-QStudyInstallProperty $runtime 'lockHash' '') -eq $lockHash -and (Get-QStudyInstallProperty $runtime 'nodeVersion' '') -eq $nodeInfo.version -and (Test-Path -LiteralPath (Join-Path $root 'frontend\node_modules\next\dist\bin\next')) -and (Test-Path -LiteralPath (Join-Path $root 'frontend\node_modules\.package-lock.json'))
    if (-not $backendReady) { $reasons.Add('Окружение Python отсутствует, перенесено или требует обновления зависимостей.') }
    if (-not $frontendReady) { $reasons.Add('Окружение Node.js отсутствует, перенесено или требует npm ci.') }
    $secretReady = Test-QStudySecret $root
    if (-not $secretReady) { $reasons.Add('Нет корректного SECRET_KEY в выбранном файле настроек. Существующие настройки не заменены.') }
    return [PSCustomObject]@{
        ready = [bool]($backendReady -and $frontendReady -and $secretReady)
        reasons = @($reasons.ToArray()); moved = [bool]$moved
        backendReady = [bool]$backendReady; frontendReady = [bool]$frontendReady
        secretReady = [bool]$secretReady; runtime = $runtime; workspace = $root
    }
}

function Enter-QStudyInstallLock([string]$Root) {
    [IO.Directory]::CreateDirectory((Join-Path $Root '.local')) | Out-Null
    $path = Join-Path $Root '.local\install.lock'
    for ($attempt = 0; $attempt -lt 300; $attempt++) {
        try { return [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] {
            if ($attempt -eq 0) { Write-Host 'Ожидание другой установки QStudy…' }
            Start-Sleep -Milliseconds 500
        }
    }
    throw 'Установка QStudy уже выполняется в другом окне. Дождитесь её завершения.'
}

function Get-QStudyVerifiedDownload([string]$Root, $Artifact, [switch]$Offline) {
    $uri = [Uri]$Artifact.url
    if ($uri.Scheme -ne 'https' -or $uri.Host -notin @('api.nuget.org', 'nodejs.org')) { throw 'Адрес runtime не относится к разрешённым официальным источникам.' }
    $cache = Join-Path $Root '.local\downloads'
    [IO.Directory]::CreateDirectory($cache) | Out-Null
    $path = Join-Path $cache $Artifact.fileName
    $expectedHash = [string](Get-QStudyInstallProperty $Artifact 'hash' '')
    if (-not $expectedHash) { $expectedHash = ([BitConverter]::ToString([Convert]::FromBase64String($Artifact.hashBase64))).Replace('-', '').ToLowerInvariant() }
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        if ((Get-QStudyFileDigest $path $Artifact.algorithm) -eq $expectedHash.ToLowerInvariant()) { return $path }
        if ($Offline) { throw "Повреждён кэш $($Artifact.fileName). Для восстановления нужен Интернет." }
        Remove-Item -LiteralPath $path -Force
    }
    if ($Offline) { throw "Нет сохранённого $($Artifact.fileName). Первый запуск требует Интернет; запустите без -Offline." }
    Write-Host "Загрузка $($Artifact.fileName) из $($uri.Host)…"
    $temporary = "$path.download"
    $oldProtocol = [Net.ServicePointManager]::SecurityProtocol
    try {
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocol -bor [Net.SecurityProtocolType]::Tls12
        $oldProgress = $ProgressPreference
        $ProgressPreference = 'SilentlyContinue'
        try { Invoke-WebRequest -Uri $uri.AbsoluteUri -OutFile $temporary -UseBasicParsing -TimeoutSec 600 }
        finally { $ProgressPreference = $oldProgress }
        if ((Get-QStudyFileDigest $temporary $Artifact.algorithm) -ne $expectedHash.ToLowerInvariant()) {
            throw "Проверка $($Artifact.algorithm) для $($Artifact.fileName) не прошла. Файл не будет запущен."
        }
        Move-Item -LiteralPath $temporary -Destination $path -Force
        return $path
    } catch { throw "Не удалось получить проверенный $($Artifact.fileName): $($_.Exception.Message)" }
    finally {
        [Net.ServicePointManager]::SecurityProtocol = $oldProtocol
        if (Test-Path -LiteralPath $temporary -PathType Leaf) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Expand-QStudyRuntime([string]$Archive, [string]$Destination, [string]$Root) {
    $fullDestination = [IO.Path]::GetFullPath($Destination)
    $allowed = [IO.Path]::GetFullPath((Join-Path $Root '.local\runtimes')) + [IO.Path]::DirectorySeparatorChar
    if (-not $fullDestination.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Путь runtime вышел за пределы .local/runtimes.' }
    [IO.Directory]::CreateDirectory((Split-Path -Parent $fullDestination)) | Out-Null
    $stage = "$fullDestination.extract-$([Guid]::NewGuid().ToString('N'))"
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $stage)
    if (Test-Path -LiteralPath $fullDestination) {
        $retired = Join-Path $Root ".local\retired\runtime-$([Guid]::NewGuid().ToString('N'))"
        [IO.Directory]::CreateDirectory((Split-Path -Parent $retired)) | Out-Null
        Move-Item -LiteralPath $fullDestination -Destination $retired
    }
    Move-Item -LiteralPath $stage -Destination $fullDestination
}

function Find-QStudyBasePython([string]$Root, [switch]$Offline) {
    $manifest = Read-QStudyInstallJson (Join-Path $script:QStudyInstallScriptDirectory 'runtime-manifest.json')
    $private = Join-Path $Root ".local\runtimes\python-$($manifest.python.version)\tools\python.exe"
    $candidates = [Collections.Generic.List[string]]::new()
    $candidates.Add($private)
    if ($env:LOCALAPPDATA) { $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313\python.exe')) }
    foreach ($command in @(Get-Command python.exe -CommandType Application -ErrorAction SilentlyContinue)) { $candidates.Add($command.Source) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'Python313\python.exe')) }
    foreach ($candidate in $candidates) {
        $info = Test-QStudyPython $candidate -BaseOnly
        if ($null -ne $info) { return $info }
    }
    $archive = Get-QStudyVerifiedDownload $Root $manifest.python -Offline:$Offline
    Expand-QStudyRuntime $archive (Split-Path -Parent (Split-Path -Parent $private)) $Root
    $info = Test-QStudyPython $private -BaseOnly
    if ($null -eq $info) { throw 'Официальный Python не запустился. Требуются Windows 10/11 x64 или Windows 11 ARM64 с поддержкой x64-приложений.' }
    return $info
}

function Find-QStudyNode([string]$Root, [switch]$Offline) {
    $manifest = Read-QStudyInstallJson (Join-Path $script:QStudyInstallScriptDirectory 'runtime-manifest.json')
    $architecture = Get-QStudyWindowsArchitecture
    $privateDirectory = Join-Path $Root ".local\runtimes\node-$($manifest.node.version)-$architecture"
    $private = Join-Path $privateDirectory "node-v$($manifest.node.version)-win-$architecture\node.exe"
    $candidates = [Collections.Generic.List[string]]::new()
    $candidates.Add($private)
    foreach ($command in @(Get-Command node.exe -CommandType Application -ErrorAction SilentlyContinue)) { $candidates.Add($command.Source) }
    if ($env:ProgramFiles) { $candidates.Add((Join-Path $env:ProgramFiles 'nodejs\node.exe')) }
    foreach ($candidate in $candidates) {
        $info = Test-QStudyNode $candidate
        if ($null -ne $info) { return $info }
    }
    $archive = Get-QStudyVerifiedDownload $Root $manifest.node.$architecture -Offline:$Offline
    Expand-QStudyRuntime $archive $privateDirectory $Root
    $info = Test-QStudyNode $private
    if ($null -eq $info) { throw 'Официальный Node.js не запустился. Проверьте версию Windows и архитектуру компьютера.' }
    return $info
}

function Retire-QStudyGeneratedDirectory([string]$Root, [string]$RelativePath) {
    if ($RelativePath -notin @('backend\.venv', 'frontend\node_modules')) { throw 'Запрещено перемещать пользовательские данные при настройке.' }
    $path = [IO.Path]::GetFullPath((Join-Path $Root $RelativePath))
    $allowed = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
    if (-not $path.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Папка окружения вышла за пределы проекта.' }
    if (-not (Test-Path -LiteralPath $path)) { return $null }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Папка $RelativePath является ссылкой. Удалите ссылку вручную; внешняя папка не затронута." }
    $destination = Join-Path $Root ".local\retired\$($RelativePath.Replace('\', '-'))-$([Guid]::NewGuid().ToString('N'))"
    [IO.Directory]::CreateDirectory((Split-Path -Parent $destination)) | Out-Null
    Move-Item -LiteralPath $path -Destination $destination
    return $destination
}

function Invoke-QStudyInstallCommand([string]$Executable, [string[]]$CommandArguments, [string]$Directory, [string]$Description) {
    if (-not (Test-Path -LiteralPath $Executable -PathType Leaf)) { throw "Не найден исполняемый файл для $Description." }
    Push-Location -LiteralPath $Directory
    try {
        $oldNativePreference = Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
        if ($null -ne $oldNativePreference) { $PSNativeCommandUseErrorActionPreference = $false }
        $oldErrorPreference = $ErrorActionPreference
        try {
            # PowerShell 5.1 represents native stderr warnings as ErrorRecords.
            # npm/pip exit status, rather than harmless warning output, decides success.
            $ErrorActionPreference = 'Continue'
            & $Executable @CommandArguments 2>&1 | ForEach-Object { Write-Host $_ }
            $commandExitCode = $LASTEXITCODE
        } finally { $ErrorActionPreference = $oldErrorPreference }
        if ($commandExitCode -ne 0) { throw "$Description завершилось с кодом $commandExitCode. Проверьте Интернет, свободное место и сообщения выше." }
    } finally { Pop-Location }
}

function Initialize-QStudySecret([string]$Root) {
    $path = Get-QStudySettingsPath $Root
    if (Test-Path -LiteralPath $path -PathType Leaf) {
        if (-not (Test-QStudySecret $Root)) { throw 'Выбранный .env содержит пустой или шаблонный SECRET_KEY. Существующий файл и аккаунты сохранены; укажите корректный ключ.' }
        return
    }
    $database = if ([string]::Equals($path, (Join-Path $Root 'deployment\.env'), [StringComparison]::OrdinalIgnoreCase)) { Join-Path $Root 'deployment\data\backend\studyhub.db' } else { Join-Path $Root 'backend\studyhub.db' }
    if (Test-Path -LiteralPath $database -PathType Leaf) { throw 'QStudy: существующая база найдена, но её файл настроек .env отсутствует. Восстановите соответствующий файл настроек из своей копии. Новый ключ не создан, аккаунты и база сохранены.' }
    $random = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $bytes = New-Object byte[] 48; $random.GetBytes($bytes) }
    finally { $random.Dispose() }
    $secret = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    [IO.Directory]::CreateDirectory((Split-Path -Parent $path)) | Out-Null
    $example = Join-Path $Root 'backend\.env.example'
    $text = if (Test-Path -LiteralPath $example) { [IO.File]::ReadAllText($example) } else { "DATABASE_URL=sqlite:///./studyhub.db`nUPLOAD_DIR=./uploads`n" }
    $text = [regex]::Replace($text, '(?m)^\s*SECRET_KEY\s*=.*(?:\r?\n|$)', '')
    $text = "SECRET_KEY=$secret`r`n" + $text
    # Protect an empty temporary file before writing the first secret byte.
    # Publishing it never replaces an existing settings file.
    $temporary = Join-Path (Split-Path -Parent $path) ('.qstudy-env-' + [Guid]::NewGuid().ToString('N') + '.tmp')
    try {
        $empty = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $empty.Dispose()
        $item = Get-Item -LiteralPath $temporary
        $acl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
        $acl.SetAccessRuleProtection($true, $false)
        foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRuleSpecific($rule) }
        $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.SetOwner($owner)
        foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
            $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, [Security.AccessControl.AccessControlType]::Allow))
        }
        $item.SetAccessControl($acl)
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::Open, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $content = [Text.UTF8Encoding]::new($false).GetBytes($text); $stream.Write($content, 0, $content.Length); $stream.Flush($true) }
        finally { $stream.Dispose() }
        [IO.File]::Move($temporary, $path)
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
    Write-Host 'Создан приватный backend/.env со случайным ключом.'
}

function Ensure-QStudyInstallation([string]$RootPath = '', [switch]$ForceRepair, [switch]$Offline) {
    $root = Get-QStudyInstallRoot $RootPath
    Assert-QStudySupportedComputer $root
    $lock = Enter-QStudyInstallLock $root
    try {
        $status = Get-QStudyInstallationStatus $root
        # OCR is an optional Windows capability, independent of Python/Node and
        # their marker. Check it even when all application dependencies are ready.
        # Partial source fixtures lacking OCR helpers still run the base app.
        if (Get-Command Ensure-QStudyOcr -CommandType Function -ErrorAction SilentlyContinue) {
            try { [void](Ensure-QStudyOcr $root -Offline:$Offline -ForceRepair:$ForceRepair) }
            catch { Write-Warning 'Не удалось подготовить русский OCR Windows. QStudy продолжит подготовку; PDF-сканы могут требовать Install-QStudy.cmd -ForceRepair.' }
        }
        if ($status.ready -and -not $ForceRepair) { return $status.runtime }
        if ($Offline -and (-not $status.backendReady -or -not $status.frontendReady -or $ForceRepair)) {
            throw 'Зависимости требуют установки. Первичная настройка или перенос на другой компьютер требуют Интернет; запустите без -Offline. Готовое окружение запускается без сети.'
        }
        Write-Host 'Проверка Python, Node.js и зависимостей QStudy…'
        Initialize-QStudySecret $root
        $python = Find-QStudyBasePython $root -Offline:$Offline
        $node = Find-QStudyNode $root -Offline:$Offline
        $venv = Join-Path $root 'backend\.venv'
        $venvPython = Join-Path $venv 'Scripts\python.exe'
        if (-not $status.backendReady -or $ForceRepair) {
            Write-Host 'Подготовка отдельного окружения Python…'
            [void](Retire-QStudyGeneratedDirectory $root 'backend\.venv')
            Invoke-QStudyInstallCommand $python.path @('-I', '-m', 'venv', $venv) $root 'Создание окружения Python'
            $pipArguments = @('-I', '-m', 'pip', '--isolated', 'install', '--disable-pip-version-check', '--only-binary=:all:', '--index-url', 'https://pypi.org/simple', '-r', (Join-Path $root 'backend\requirements.txt'))
            $constraints = Join-Path $root 'backend\requirements.lock.txt'
            if (Test-Path -LiteralPath $constraints -PathType Leaf) { $pipArguments += @('-c', $constraints) }
            Invoke-QStudyInstallCommand $venvPython $pipArguments $root 'Установка Python-зависимостей'
            Invoke-QStudyInstallCommand $venvPython @('-I', '-m', 'pip', '--isolated', 'check') $root 'Проверка Python-зависимостей'
        }
        if (-not $status.frontendReady -or $ForceRepair -or (Get-QStudyInstallProperty $status.runtime 'nodeVersion' '') -ne $node.version) {
            Write-Host 'Установка интерфейса по package-lock.json…'
            [void](Retire-QStudyGeneratedDirectory $root 'frontend\node_modules')
            $oldPath = $env:Path
            $oldNodeEnvironment = $env:NODE_ENV
            try {
                # Process-local PATH is needed by npm lifecycle scripts; Windows settings are unchanged.
                $env:Path = (Split-Path -Parent $node.path) + ';' + $oldPath
                $env:NODE_ENV = 'development'
                Invoke-QStudyInstallCommand $node.path @($node.npm, 'ci', '--include=dev', '--include=optional', '--registry=https://registry.npmjs.org', '--no-audit', '--no-fund') (Join-Path $root 'frontend') 'Установка npm-зависимостей'
            } finally { $env:Path = $oldPath; $env:NODE_ENV = $oldNodeEnvironment }
        }
        $runtime = [PSCustomObject]@{
            version = 1; workspace = $root; machineName = [Environment]::MachineName
            machineFingerprint = (Get-QStudyInstallComputerFingerprint)
            python = $venvPython; basePython = $python.path; pythonVersion = $python.version
            node = $node.path; nodeVersion = $node.version; nodeArchitecture = $node.architecture; npm = $node.npm
            requirementsHash = (Get-QStudyDependencyHash $root)
            lockHash = (Get-QStudyInstallHash (Join-Path $root 'frontend\package-lock.json'))
            installedAtUtc = [DateTime]::UtcNow.ToString('o')
        }
        Write-QStudyInstallJson (Join-Path $root '.local\runtime.json') $runtime
        $verified = Get-QStudyInstallationStatus $root
        if (-not $verified.ready) { throw ('Проверка готовности не прошла: ' + ($verified.reasons -join ' ')) }
        Write-Host 'Все зависимости QStudy готовы.'
        return $runtime
    } finally { $lock.Dispose() }
}
