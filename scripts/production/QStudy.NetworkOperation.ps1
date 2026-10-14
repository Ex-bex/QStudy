# Safe parent/hidden-UAC handover. Dot-sourcing performs no host operations.
if (-not (Get-Command Assert-QStudyHostPath -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')
}

function Get-QStudyNetworkOperationPath([string]$Root) {
    return Assert-QStudyHostPath $Root (Join-Path $Root '.local\public-access\last-operation.json')
}

function Assert-QStudyNetworkOperationStore([string]$Root, [string]$TargetUserSid) {
    $directory = Assert-QStudyHostPath $Root (Split-Path -Parent (Get-QStudyNetworkOperationPath $Root))
    if (-not (Test-Path -LiteralPath $directory -PathType Container)) { throw 'QStudy: закрытый отчёт настройки сети недоступен.' }
    $sid = [Security.Principal.SecurityIdentifier]::new($TargetUserSid)
    $acl = (Get-Item -LiteralPath $directory -Force).GetAccessControl([Security.AccessControl.AccessControlSections]'Access, Owner')
    if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne $sid.Value) {
        throw 'QStudy: отчёт настройки сети принадлежит другому Windows-пользователю.'
    }
    $allowed = @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')
    $readable = $false
    foreach ($rule in $acl.Access) {
        $identity = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Allow) {
            if ($identity -notin $allowed) { throw 'QStudy: отчёт настройки сети должен оставаться закрытым.' }
            if ($identity -ceq $sid.Value -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) { $readable = $true }
        }
    }
    if (-not $readable) { throw 'QStudy: исходный Windows-пользователь не может прочитать отчёт настройки сети.' }
    return $directory
}

function Initialize-QStudyNetworkOperationStore([string]$Root, [string]$TargetUserSid) {
    if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne $TargetUserSid) {
        throw 'QStudy: закрытую папку отчёта создаёт исходный Windows-пользователь.'
    }
    $directory = Assert-QStudyHostPath $Root (Split-Path -Parent (Get-QStudyNetworkOperationPath $Root))
    if (Test-Path -LiteralPath $directory -PathType Container) {
        $owner = (Get-Item -LiteralPath $directory -Force).GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier]).Value
        if ($owner -cne $TargetUserSid) { throw 'QStudy: папка отчёта принадлежит другому Windows-пользователю; права не изменены.' }
    }
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    (Get-Item -LiteralPath $directory -Force).SetAccessControl((New-QStudyPrivateAcl $true $directory))
    Assert-QStudyNetworkOperationStore $Root $TargetUserSid | Out-Null
}

function Assert-QStudyNetworkOperationFile([string]$Root, [string]$Path, [string]$TargetUserSid) {
    $checkedPath = Assert-QStudyHostPath $Root $Path
    if (-not (Test-Path -LiteralPath $checkedPath -PathType Leaf)) { throw 'QStudy: файл отчёта настройки сети недоступен.' }
    $allowed = @($TargetUserSid, 'S-1-5-18', 'S-1-5-32-544')
    $readable = $false
    $acl = (Get-Item -LiteralPath $checkedPath -Force).GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    foreach ($rule in $acl.Access) {
        if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
        $identity = $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value
        if ($identity -notin $allowed) { throw 'QStudy: файл отчёта настройки сети должен оставаться закрытым.' }
        if ($identity -ceq $TargetUserSid -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::ReadData)) { $readable = $true }
    }
    if (-not $readable) { throw 'QStudy: исходный Windows-пользователь не может прочитать файл отчёта.' }
}

function ConvertTo-QStudyNetworkOperationMessage([string]$Message, [string]$ExceptionType = '') {
    # Core networking errors deliberately use this prefix and contain no secrets.
    # Arbitrary exception text (which can contain paths/credentials) is discarded.
    if ($Message.StartsWith('QStudy:') -and $Message.Length -le 2048 -and $Message -notmatch '[\x00-\x1f\x7f]') { return $Message }
    $kind = if ($ExceptionType -match '^[A-Za-z][A-Za-z0-9]{0,80}$') { $ExceptionType } else { 'Ошибка' }
    return ('QStudy: настройка сети не завершилась (' + $kind + '). Проверьте разрешение Windows и повторите эту же кнопку.')
}

function Save-QStudyNetworkOperation {
    param([string]$Root, [ValidateSet('enable', 'manual', 'disable', 'status', 'renew')][string]$Action,
        [ValidateRange(0, 2)][int]$Code, [string]$Message, [string]$TargetUserSid, [string]$ExceptionType = '')
    $directory = Assert-QStudyNetworkOperationStore $Root $TargetUserSid
    $path = Get-QStudyNetworkOperationPath $Root
    if (Test-Path -LiteralPath $path) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'QStudy: файл отчёта настройки сети недоступен.' }
        Assert-QStudyNetworkOperationFile $Root $path $TargetUserSid
    }
    $report = @{ version = 1; root_owner = [IO.Path]::GetFullPath($Root); target_user_sid = $TargetUserSid;
        action = $Action; code = $Code; message = (ConvertTo-QStudyNetworkOperationMessage $Message $ExceptionType);
        checked_utc = [DateTimeOffset]::UtcNow.ToString('o') }
    $temporary = Assert-QStudyHostPath $Root (Join-Path $directory ('operation-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
    try {
        # The file inherits the original user's private directory ACL, including
        # when UAC was mistakenly completed with a different admin account.
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Compress))
            $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
        } finally { $stream.Dispose() }
        Assert-QStudyNetworkOperationStore $Root $TargetUserSid | Out-Null
        $path = Get-QStudyNetworkOperationPath $Root
        if (Test-Path -LiteralPath $path -PathType Leaf) {
            Assert-QStudyNetworkOperationFile $Root $path $TargetUserSid
            [IO.File]::Replace($temporary, $path, [NullString]::Value)
        }
        else { [IO.File]::Move($temporary, $path) }
        $temporary = $null
    } finally {
        if ($temporary -and (Test-Path -LiteralPath $temporary -PathType Leaf)) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Read-QStudyNetworkOperation {
    param([string]$Root, [ValidateSet('enable', 'manual', 'disable', 'status', 'renew')][string]$Action,
        [string]$TargetUserSid, [DateTimeOffset]$MinimumUtc)
    try {
        Assert-QStudyNetworkOperationStore $Root $TargetUserSid | Out-Null
        $path = Get-QStudyNetworkOperationPath $Root
        if (-not (Test-Path -LiteralPath $path -PathType Leaf) -or (Get-Item -LiteralPath $path).Length -gt 16384) { return $null }
        Assert-QStudyNetworkOperationFile $Root $path $TargetUserSid
        $report = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json
        $checked = [DateTimeOffset]::MinValue
        if ($report.version -ne 1 -or $report.root_owner -cne [IO.Path]::GetFullPath($Root) -or
            $report.target_user_sid -cne $TargetUserSid -or $report.action -cne $Action -or
            $report.code -isnot [int] -or $report.code -notin @(0, 1, 2) -or $report.message -isnot [string] -or
            $report.message -cne (ConvertTo-QStudyNetworkOperationMessage $report.message) -or
            -not [DateTimeOffset]::TryParse([string]$report.checked_utc, [ref]$checked) -or
            $checked -lt $MinimumUtc -or $checked -gt [DateTimeOffset]::UtcNow.AddSeconds(5)) { return $null }
        return $report
    } catch { return $null }
}
