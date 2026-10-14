# Windows one-click data choice. No database/configuration content is read here.
. (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')

function Select-QStudyInternetBackupFile {
    try {
        Add-Type -AssemblyName System.Windows.Forms
        $dialog = [Windows.Forms.OpenFileDialog]::new()
        try {
            $dialog.Title = 'Выберите резервную копию QStudy (.zip)'
            $dialog.Filter = 'Резервная копия QStudy (*.zip)|*.zip'
            $dialog.Multiselect = $false
            $dialog.CheckFileExists = $true
            $dialog.CheckPathExists = $true
            $dialog.RestoreDirectory = $true
            if ($dialog.ShowDialog() -eq [Windows.Forms.DialogResult]::OK) { return [string]$dialog.FileName }
            return ''
        } finally { $dialog.Dispose() }
    } catch { throw 'QStudy: окно выбора резервной копии недоступно. Запуск остановлен; данные не изменены.' }
}

function Get-QStudyInternetBackupHash([string]$Path) {
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($hash.ComputeHash($stream)) }
    finally { $hash.Dispose(); $stream.Dispose() }
}

function Get-QStudyInternetBackupImportName {
    return 'qstudy-' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss', [Globalization.CultureInfo]::InvariantCulture) + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.zip'
}

function Copy-QStudyInternetSelectedBackup([string]$Root, [string]$SourcePath) {
    $sourceStream = $null; $lock = $null; $temporary = $null
    try {
        if (-not $SourcePath -or [IO.Path]::GetExtension($SourcePath) -ine '.zip') {
            throw 'QStudy: выберите существующий файл резервной копии с расширением .zip. Данные не изменены.'
        }
        $source = [IO.Path]::GetFullPath($SourcePath)
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
            throw 'QStudy: выбранный ZIP недоступен или является папкой. Данные не изменены.'
        }
        # The user explicitly selected this outside-project source. Refuse
        # filesystem links throughout its path, including a linked parent.
        $sourceAncestor = $source
        while ($sourceAncestor) {
            if ((Get-Item -LiteralPath $sourceAncestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'QStudy: резервную копию нужно выбирать из обычной папки без ссылок и junction. Данные не изменены.'
            }
            $parent = Split-Path -Parent $sourceAncestor
            if (-not $parent -or $parent -eq $sourceAncestor) { break }
            $sourceAncestor = $parent
        }
        $sourceStream = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        if ($sourceStream.Length -gt [long]2147483648) {
            throw 'QStudy: выбранная резервная копия больше 2 ГБ. Запуск остановлен; данные не изменены.'
        }
        $hash = [Security.Cryptography.SHA256]::Create()
        try { $sourceHash = [Convert]::ToBase64String($hash.ComputeHash($sourceStream)) }
        finally { $hash.Dispose() }
        $sourceStream.Position = 0
        $local = Assert-QStudyHostPath $Root (Join-Path $Root '.local')
        [IO.Directory]::CreateDirectory($local) | Out-Null
        $lockPath = Assert-QStudyHostPath $Root (Join-Path $local 'internet-host.lock')
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { throw 'QStudy: другая операция хоста уже выполняется. Дождитесь её завершения.' }
        $folder = Assert-QStudyHostPath $Root (Join-Path $Root 'deployment\data\backups')
        Protect-QStudyHostStorage $Root
        [IO.Directory]::CreateDirectory($folder) | Out-Null
        (Get-Item -LiteralPath $folder -Force).SetAccessControl((New-QStudyPrivateAcl $true $folder))
        $name = Get-QStudyInternetBackupImportName
        if ($name -cnotmatch '^qstudy-\d{8}-\d{6}-[a-f0-9]{8}\.zip$') { throw 'QStudy: недопустимое имя резервной копии; данные не изменены.' }
        $target = Assert-QStudyHostPath $Root (Join-Path $folder $name)
        if (Test-Path -LiteralPath $target) { throw 'QStudy: файл резервной копии уже существует. Никакие файлы не перезаписаны.' }
        $temporary = Assert-QStudyHostPath $Root (Join-Path $folder ('.import-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
        $targetStream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $sourceStream.CopyTo($targetStream)
            $targetStream.Flush($true)
        } finally { $targetStream.Dispose() }
        (Get-Item -LiteralPath $temporary -Force).SetAccessControl((New-QStudyPrivateAcl $false $temporary))
        if ((Get-QStudyInternetBackupHash $temporary) -cne $sourceHash) {
            throw 'QStudy: контрольная сумма скопированной резервной копии не совпала. Запуск остановлен; данные не восстановлены.'
        }
        # Atomic move never replaces an existing archive, even after a race.
        [IO.File]::Move($temporary, $target)
        $temporary = $null
        return $name
    } catch {
        if ($_.Exception -is [Management.Automation.RuntimeException] -and $_.Exception.Message -match '^QStudy:') { throw }
        throw 'QStudy: не удалось безопасно скопировать выбранную резервную копию. Проверьте доступ к ZIP и папке проекта; данные не восстановлены.'
    } finally {
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
        if ($null -ne $lock) { $lock.Dispose() }
        if ($null -ne $sourceStream) { $sourceStream.Dispose() }
    }
}

function Resolve-QStudyInternetDataChoice {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Root,
        [string]$Archive = '', [switch]$NewInstallation)
    if ($Archive -and $NewInstallation) { throw 'QStudy: выберите либо восстановление резервной копии, либо отдельную новую установку.' }
    $legacyPath = Assert-QStudyHostPath $Root (Join-Path $Root 'backend\studyhub.db')
    $productionPath = Assert-QStudyHostPath $Root (Join-Path $Root 'deployment\data\backend\studyhub.db')
    $legacyDetected = [bool](Test-Path -LiteralPath $legacyPath -PathType Leaf)
    if ($Archive) {
        Assert-QStudyBackupBasename $Archive
        if ($Archive -cnotmatch '^qstudy-\d{8}-\d{6}-[a-f0-9]{8}\.zip$') { throw 'QStudy: укажите имя существующей резервной копии QStudy без пути.' }
        $archivePath = Assert-QStudyHostPath $Root (Join-Path $Root ('deployment\data\backups\' + $Archive))
        if (-not (Test-Path -LiteralPath $archivePath -PathType Leaf)) { throw 'QStudy: выбранная резервная копия отсутствует в deployment/data/backups. Данные не изменены.' }
        return [PSCustomObject]@{ archive = $Archive; new_installation = $false; legacy_detected = $legacyDetected }
    }
    if ($NewInstallation -or -not $legacyDetected -or (Test-Path -LiteralPath $productionPath -PathType Leaf)) {
        return [PSCustomObject]@{ archive = ''; new_installation = [bool]$NewInstallation; legacy_detected = $legacyDetected }
    }
    Write-Host 'Найдены данные локального QStudy. Интернет-версия использует отдельную базу.'
    Write-Host '1 — Выбрать ZIP резервной копии и восстановить аккаунты и материалы.'
    Write-Host '2 — Создать отдельную новую интернет-версию. Локальные данные сохранятся.'
    Write-Host '0 — Остановить запуск.'
    while ($true) {
        $answer = Read-Host 'Выберите 1, 2 или 0'
        if ($answer -eq '0' -or [string]::IsNullOrWhiteSpace($answer)) { throw 'QStudy: запуск отменён. Локальные данные не изменены.' }
        if ($answer -eq '2') { return [PSCustomObject]@{ archive = ''; new_installation = $true; legacy_detected = $true } }
        if ($answer -eq '1') {
            try { $selected = Select-QStudyInternetBackupFile }
            catch { throw 'QStudy: окно выбора резервной копии недоступно. Запуск остановлен; данные не изменены.' }
            if (-not $selected) { throw 'QStudy: выбор резервной копии отменён. Запуск остановлен; локальные данные не изменены.' }
            $name = Copy-QStudyInternetSelectedBackup -Root $Root -SourcePath $selected
            Write-Host 'Резервная копия скопирована. Перед восстановлением QStudy проверит её содержимое.'
            return [PSCustomObject]@{ archive = $name; new_installation = $false; legacy_detected = $true }
        }
        Write-Host 'Введите только 1, 2 или 0. Команды вводить не нужно.'
    }
}
