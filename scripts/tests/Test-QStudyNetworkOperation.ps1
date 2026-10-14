# Real private ACLs/atomic files, disposable reports only; no UAC or network calls.
param()
. (Join-Path $PSScriptRoot '..\production\QStudy.NetworkOperation.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$prefix = Join-Path $workspace '.local\network-operation-tests'
$fixture = Join-Path $prefix ([Guid]::NewGuid().ToString('N'))
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$checks = 0
function Assert-Operation([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-OperationThrows([scriptblock]$Operation, [string]$Message) {
    $caught = $false
    try { & $Operation | Out-Null } catch { $caught = $true }
    Assert-Operation $caught $Message
}
try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    Initialize-QStudyNetworkOperationStore $fixture $sid
    $path = Get-QStudyNetworkOperationPath $fixture
    $directory = Split-Path -Parent $path
    Assert-Operation ((Get-Item -LiteralPath $directory).GetAccessControl().AreAccessRulesProtected) 'private report directory does not inherit broad permissions'
    $minimum = [DateTimeOffset]::UtcNow.AddSeconds(-1)
    Save-QStudyNetworkOperation -Root $fixture -Action enable -Code 1 -Message 'QStudy: safe original UAC failure.' -TargetUserSid $sid
    $report = Read-QStudyNetworkOperation -Root $fixture -Action enable -TargetUserSid $sid -MinimumUtc $minimum
    Assert-Operation ($null -ne $report -and $report.code -eq 1 -and $report.message -ceq 'QStudy: safe original UAC failure.') 'fresh child failure is available to the original user'
    Assert-Operation ($report.root_owner -ceq $fixture -and $report.target_user_sid -ceq $sid) 'report belongs to the exact installation and original Windows SID'
    Assert-Operation ($null -eq (Read-QStudyNetworkOperation -Root $fixture -Action manual -TargetUserSid $sid -MinimumUtc $minimum)) 'a different action cannot reuse the child result'
    Assert-Operation ($null -eq (Read-QStudyNetworkOperation -Root $fixture -Action enable -TargetUserSid 'S-1-5-21-0-0-0-1234' -MinimumUtc $minimum)) 'another Windows account cannot reuse the result'
    Assert-Operation ($null -eq (Read-QStudyNetworkOperation -Root $fixture -Action enable -TargetUserSid $sid -MinimumUtc ([DateTimeOffset]::UtcNow.AddMinutes(1)))) 'a previous result cannot be mistaken for a new UAC operation'
    $raw = [IO.File]::ReadAllText($path)
    foreach ($variant in @('version', 'owner', 'sid', 'code-string', 'code-invalid', 'future', 'invalid-time', 'missing', 'arbitrary-message', 'message-control')) {
        $changed = $raw | ConvertFrom-Json
        switch ($variant) {
            'version' { $changed.version = 2 }
            'owner' { $changed.root_owner = Join-Path $fixture 'other-project' }
            'sid' { $changed.target_user_sid = 'S-1-5-21-0-0-0-1234' }
            'code-string' { $changed.code = '1' }
            'code-invalid' { $changed.code = 42 }
            'future' { $changed.checked_utc = [DateTimeOffset]::UtcNow.AddMinutes(1).ToString('o') }
            'invalid-time' { $changed.checked_utc = 'invalid' }
            'missing' { $changed.PSObject.Properties.Remove('action') }
            'arbitrary-message' { $changed.message = 'synthetic SMTP_PASSWORD=do-not-print' }
            'message-control' { $changed.message = "QStudy: bad`nmessage" }
        }
        [IO.File]::WriteAllText($path, ($changed | ConvertTo-Json))
        Assert-Operation ($null -eq (Read-QStudyNetworkOperation -Root $fixture -Action enable -TargetUserSid $sid -MinimumUtc $minimum)) ($variant + ' report is rejected')
    }
    [IO.File]::WriteAllText($path, '{broken-json')
    Assert-Operation ($null -eq (Read-QStudyNetworkOperation -Root $fixture -Action enable -TargetUserSid $sid -MinimumUtc $minimum)) 'damaged JSON is not printed or used'
    [IO.File]::WriteAllText($path, ('x' * 16385))
    Assert-Operation ($null -eq (Read-QStudyNetworkOperation -Root $fixture -Action enable -TargetUserSid $sid -MinimumUtc $minimum)) 'oversized report is rejected'
    [IO.File]::WriteAllText($path, $raw)

    Save-QStudyNetworkOperation -Root $fixture -Action manual -Code 2 -Message 'synthetic SMTP_PASSWORD=do-not-print' -ExceptionType IOException -TargetUserSid $sid
    $sanitized = Read-QStudyNetworkOperation -Root $fixture -Action manual -TargetUserSid $sid -MinimumUtc $minimum
    Assert-Operation ($null -ne $sanitized -and $sanitized.message -match 'IOException' -and $sanitized.message -notmatch 'SMTP_PASSWORD|do-not-print') 'arbitrary exception text is discarded while safe exception type remains'
    Assert-Operation ((ConvertTo-QStudyNetworkOperationMessage 'arbitrary secret' 'Injected(secret)') -notmatch 'secret|Injected') 'untrusted exception types are also discarded'
    Assert-Operation ((ConvertTo-QStudyNetworkOperationMessage ('QStudy:' + ('x' * 2049))) -notmatch 'xxx') 'long supposedly safe error text is discarded'
    Assert-Operation (@((Get-Item -LiteralPath $path).GetAccessControl().Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin @($sid, 'S-1-5-18', 'S-1-5-32-544') }).Count -eq 0) 'report file inherits permissions only for original user, SYSTEM and Administrators'

    $unchanged = [IO.File]::ReadAllBytes($path)
    $lock = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-OperationThrows { Save-QStudyNetworkOperation -Root $fixture -Action enable -Code 0 -Message 'QStudy: done.' -TargetUserSid $sid } 'locked destination fails without unsafe replacement' }
    finally { $lock.Dispose() }
    Assert-Operation ([Convert]::ToBase64String([IO.File]::ReadAllBytes($path)) -ceq [Convert]::ToBase64String($unchanged)) 'failed atomic save preserves previous report bytes'
    Assert-Operation (@(Get-ChildItem -LiteralPath $directory -Filter 'operation-*.tmp').Count -eq 0) 'failed atomic save cleans its temporary file'

    $file = Get-Item -LiteralPath $path
    $privateAcl = $file.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $publicAcl = $file.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $publicAcl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('S-1-1-0'), [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow))
    $file.SetAccessControl($publicAcl)
    Assert-Operation ($null -eq (Read-QStudyNetworkOperation -Root $fixture -Action manual -TargetUserSid $sid -MinimumUtc $minimum)) 'world-readable report is not trusted'
    Assert-OperationThrows { Save-QStudyNetworkOperation -Root $fixture -Action enable -Code 0 -Message 'QStudy: done.' -TargetUserSid $sid } 'world-readable destination is not replaced while preserving unsafe ACLs'
    $file.SetAccessControl($privateAcl)
    Assert-OperationThrows { Initialize-QStudyNetworkOperationStore $fixture 'S-1-5-21-0-0-0-1234' } 'another user cannot reset directory ownership'
    Assert-OperationThrows { Get-QStudyNetworkOperationPath (Join-Path $fixture 'sub\..\..\outside') | Out-Null; Assert-QStudyHostPath $fixture (Join-Path $fixture '..\outside') } 'out-of-project report paths are rejected'

    $outside = Join-Path $fixture 'outside'
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $linkedRoot = Join-Path $fixture 'linked-project'
    [IO.Directory]::CreateDirectory((Join-Path $linkedRoot '.local')) | Out-Null
    $junction = Join-Path $linkedRoot '.local\public-access'
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    try {
        Assert-OperationThrows { Initialize-QStudyNetworkOperationStore $linkedRoot $sid } 'linked report directory is rejected before creating or changing outside files'
        Assert-Operation (@(Get-ChildItem -LiteralPath $outside -Force).Count -eq 0) 'linked target stays untouched'
    } finally { (Get-Item -LiteralPath $junction -Force).Delete() }

    # Exercise the real CLI, including its hidden-child return path. Only the
    # OS identity/admin-branch decision and networking core are fixture stubs;
    # report creation, ACLs, freshness checks and safe console output are real.
    $cliRoot = Join-Path $fixture 'cli-project'
    $cliScripts = Join-Path $cliRoot 'scripts\production'
    [IO.Directory]::CreateDirectory($cliScripts) | Out-Null
    $realScripts = Join-Path $workspace 'scripts\production'
    foreach ($name in @('QStudy.NetworkOperation.ps1', 'QStudy.WindowsHost.ps1')) { Copy-Item -LiteralPath (Join-Path $realScripts $name) -Destination $cliScripts }
    $managerText = [IO.File]::ReadAllText((Join-Path $realScripts 'Manage-QStudyPublicAccess.ps1'), [Text.Encoding]::UTF8)
    $managerText = $managerText.Replace('$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value', '$currentSid = if ($env:QSTUDY_NETWORK_OPERATION_TEST -eq ''wrong-uac-account'') { ''S-1-5-21-0-0-0-1234'' } else { [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }')
    $managerText = $managerText.Replace('$administrator = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)', '$administrator = $false')
    [IO.File]::WriteAllText((Join-Path $cliScripts 'Manage-QStudyPublicAccess.ps1'), $managerText, [Text.UTF8Encoding]::new($true))
    $fakeCore = @'
. (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')
function Get-QStudyPublicAccessConfiguration {
    param($Root)
    if ($env:QSTUDY_NETWORK_OPERATION_TEST -eq 'safe-core-error') { throw 'QStudy: выбранный порт занят другим приложением.' }
    if ($env:QSTUDY_NETWORK_OPERATION_TEST -eq 'private-core-error') { throw 'SyntheticException SMTP_PASSWORD=do-not-print C:\private\secret.env' }
    return @{}
}
function Invoke-QStudyPublicAccess {
    param($Root, $Action, [switch]$RouterCleanupConfirmed)
    if ($Action -ne 'status') { throw 'No actual network mutation is allowed in this fixture.' }
    return [PSCustomObject]@{ code = 0; report = [PSCustomObject]@{ status = 'old_saved_state' } }
}
function Start-Process {
    param($FilePath, $Verb, $WindowStyle, $ArgumentList, [switch]$Wait, [switch]$PassThru)
    $fixtureRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
    $fixtureSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    Save-QStudyNetworkOperation -Root $fixtureRoot -Action enable -Code 1 -Message 'QStudy: подтверждение Windows не завершилось; повторите эту же кнопку.' -TargetUserSid $fixtureSid
    $reportPath = Get-QStudyNetworkOperationPath $fixtureRoot
    $operation = [IO.File]::ReadAllText($reportPath) | ConvertFrom-Json
    if ($env:QSTUDY_NETWORK_OPERATION_TEST -eq 'stale-child') { $operation.checked_utc = [DateTimeOffset]::UtcNow.AddMinutes(-1).ToString('o') }
    if ($env:QSTUDY_NETWORK_OPERATION_TEST -eq 'wrong-action-child') { $operation.action = 'manual' }
    if ($env:QSTUDY_NETWORK_OPERATION_TEST -eq 'wrong-code-child') { $operation.code = 0 }
    [IO.File]::WriteAllText($reportPath, ($operation | ConvertTo-Json))
    return [PSCustomObject]@{ ExitCode = 1 }
}
'@
    [IO.File]::WriteAllText((Join-Path $cliScripts 'QStudy.PublicAccess.ps1'), $fakeCore, [Text.UTF8Encoding]::new($true))
    $powershell = (Get-Command powershell.exe -CommandType Application).Source
    $oldScenario = $env:QSTUDY_NETWORK_OPERATION_TEST
    try {
        foreach ($scenario in @('safe-core-error', 'private-core-error', 'fresh-child', 'stale-child', 'wrong-action-child', 'wrong-code-child', 'wrong-uac-account')) {
            Initialize-QStudyNetworkOperationStore $cliRoot $sid
            $env:QSTUDY_NETWORK_OPERATION_TEST = $scenario
            $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $cliScripts 'Manage-QStudyPublicAccess.ps1'), '-Action', 'enable', '-NoPause')
            if ($scenario -eq 'wrong-uac-account') { $arguments += @('-ExpectedUserSid', $sid) }
            $started = [DateTimeOffset]::UtcNow
            $oldPreference = $ErrorActionPreference
            try { $ErrorActionPreference = 'Continue'; $output = (@(& $powershell @arguments 2>&1) -join "`n"); $exitCode = $LASTEXITCODE }
            finally { $ErrorActionPreference = $oldPreference }
            Assert-Operation ($exitCode -eq 1) ($scenario + ' returns failure instead of claiming network success')
            Assert-Operation ($output -notmatch 'SMTP_PASSWORD|do-not-print|secret.env|root_owner|target_user_sid') ($scenario + ' console reveals no private exception text or report ownership metadata')
            $operation = Read-QStudyNetworkOperation -Root $cliRoot -Action enable -TargetUserSid $sid -MinimumUtc $started
            Assert-Operation ($null -ne $operation -and $operation.code -eq 1) ($scenario + ' stores a fresh safe report readable by the original user')
            switch ($scenario) {
                'safe-core-error' { Assert-Operation ($output -match 'выбранный порт занят') 'known safe core error survives the hidden-report handover' }
                'private-core-error' { Assert-Operation ($output -match 'настройка сети не завершилась') 'arbitrary core error uses Russian generic guidance' }
                'fresh-child' { Assert-Operation ($output -match 'подтверждение Windows не завершилось') 'fresh hidden child failure is visible in the parent console' }
                'wrong-uac-account' { Assert-Operation ($output -match 'другой аккаунт администратора') 'wrong UAC account explains that both actions require the same Windows user' }
                default { Assert-Operation ($output -match 'Старый отчёт не использовался' -and $output -notmatch 'подтверждение Windows не завершилось') ($scenario + ' cannot reuse unconfirmed or mismatched child output') }
            }
        }
    } finally { $env:QSTUDY_NETWORK_OPERATION_TEST = $oldScenario }
    Write-Host ('Network operation checks passed (' + $checks + ' assertions). Private disposable ACL/files only; no UAC, firewall, router, mail or account operations.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    $expected = [IO.Path]::GetFullPath($prefix).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside network operation fixtures.' }
    if (Test-Path -LiteralPath $resolved) {
        if (((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Refusing cleanup of linked network operation fixture.' }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
exit 0
