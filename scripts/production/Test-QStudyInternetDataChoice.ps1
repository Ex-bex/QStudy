# Disposable dummy files only; no ZIP extraction, database, network or UI calls.
. (Join-Path $PSScriptRoot 'QStudy.InternetDataChoice.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixturePrefix = Join-Path $workspace '.local\internet-data-choice-tests'
$fixture = Join-Path $fixturePrefix ([Guid]::NewGuid().ToString('N'))
$hostRoot = Join-Path $fixture 'host'
$outside = Join-Path $fixture 'selected-outside-project'
$checks = 0; $script:promptCount = 0; $script:pickerCount = 0
$script:answers = [Collections.Generic.Queue[string]]::new()
$script:selectedFile = ''; $script:pickerError = $false; $script:hashFailure = ''
$script:fixedImportName = ''
$script:originalHash = ${function:Get-QStudyInternetBackupHash}
$script:originalImportName = ${function:Get-QStudyInternetBackupImportName}
function Assert-InternetDataChoice([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-InternetDataChoiceThrows([scriptblock]$Operation, [string]$Message) {
    $thrown = $false
    try { & $Operation | Out-Null } catch {
        $thrown = $true
        Assert-InternetDataChoice ($_.Exception.Message -notmatch 'FixtureSecret') 'errors redact private source details'
    }
    Assert-InternetDataChoice $thrown $Message
}
function Read-Host([string]$Prompt) {
    $script:promptCount++
    if (-not $script:answers.Count) { throw 'Unexpected fixture prompt.' }
    return $script:answers.Dequeue()
}
function Select-QStudyInternetBackupFile {
    $script:pickerCount++
    if ($script:pickerError) { throw 'FixtureSecretFilePickerError' }
    return $script:selectedFile
}
function Get-QStudyInternetBackupHash([string]$Path) {
    if ($script:hashFailure -eq 'mismatch') { return 'DifferentChecksum' }
    if ($script:hashFailure -eq 'permission') { throw [UnauthorizedAccessException]::new('FixtureSecretUnreadableDestination') }
    return (& $script:originalHash $Path)
}
function Get-QStudyInternetBackupImportName {
    if ($script:fixedImportName) { return $script:fixedImportName }
    return (& $script:originalImportName)
}
function Remove-InternetDataChoiceFixtureJunction([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($fixture) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing junction cleanup outside this fixture.' }
    if ((Get-Item -LiteralPath $resolved -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
        # Windows PowerShell Remove-Item can throw for nonempty junction targets.
        # Nonrecursive Directory.Delete removes the link itself, never its target.
        [IO.Directory]::Delete($resolved, $false)
    } else { throw 'Refusing to remove a fixture junction that is not a link.' }
}
$sourceJunction = Join-Path $fixture 'linked-source'
$targetJunction = Join-Path $fixture 'linked-host\deployment\data\backups'
try {
    foreach ($path in @((Join-Path $hostRoot 'backend'), (Join-Path $hostRoot 'deployment\data\backend'), $outside)) { [IO.Directory]::CreateDirectory($path) | Out-Null }
    $legacy = Join-Path $hostRoot 'backend\studyhub.db'
    $production = Join-Path $hostRoot 'deployment\data\backend\studyhub.db'
    $result = Resolve-QStudyInternetDataChoice -Root $hostRoot
    Assert-InternetDataChoice (-not $result.legacy_detected -and -not $result.new_installation -and -not $result.archive) 'fresh empty checkout needs no data-choice prompt'
    Assert-InternetDataChoice ($script:promptCount -eq 0 -and $script:pickerCount -eq 0) 'fresh launch neither prompts nor opens a dialog'
    [IO.File]::WriteAllText($legacy, 'FixtureSecretLegacyDatabaseNeverParsed')
    $legacyBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($legacy))
    $script:answers.Enqueue('2')
    $result = Resolve-QStudyInternetDataChoice -Root $hostRoot
    Assert-InternetDataChoice ($result.legacy_detected -and $result.new_installation -and -not $result.archive) 'choice 2 explicitly creates a separate empty production installation'
    Assert-InternetDataChoice (-not (Test-Path -LiteralPath $production)) 'data choice creates no production database'
    Assert-InternetDataChoice ([Convert]::ToBase64String([IO.File]::ReadAllBytes($legacy)) -ceq $legacyBytes) 'legacy database content is untouched'
    $script:answers.Enqueue('0')
    Assert-InternetDataChoiceThrows { Resolve-QStudyInternetDataChoice -Root $hostRoot } 'choice 0 stops safely'
    $script:answers.Enqueue('')
    Assert-InternetDataChoiceThrows { Resolve-QStudyInternetDataChoice -Root $hostRoot } 'empty input cancels safely'
    $script:answers.Enqueue('wrong'); $script:answers.Enqueue('2')
    $beforePrompts = $script:promptCount
    $result = Resolve-QStudyInternetDataChoice -Root $hostRoot
    Assert-InternetDataChoice ($result.new_installation -and $script:promptCount -eq $beforePrompts + 2) 'invalid input retries with numeric choices; commands are unnecessary'
    $script:answers.Enqueue('1'); $script:selectedFile = ''
    Assert-InternetDataChoiceThrows { Resolve-QStudyInternetDataChoice -Root $hostRoot } 'file-picker cancellation stops without choosing a blank installation'
    $script:answers.Enqueue('1'); $script:pickerError = $true
    Assert-InternetDataChoiceThrows { Resolve-QStudyInternetDataChoice -Root $hostRoot } 'file-picker errors provide a safe clear stop'
    $script:pickerError = $false
    $source = Join-Path $outside 'chosen-backup.zip'
    $payload = [Text.Encoding]::UTF8.GetBytes('FixtureSecretDummyZipOnly_NotExtracted_письмо')
    [IO.File]::WriteAllBytes($source, $payload)
    $sourceBytes = [Convert]::ToBase64String($payload)
    $script:answers.Enqueue('1'); $script:selectedFile = $source
    $result = Resolve-QStudyInternetDataChoice -Root $hostRoot
    Assert-InternetDataChoice ($result.archive -cmatch '^qstudy-\d{8}-\d{6}-[a-f0-9]{8}\.zip$' -and -not $result.new_installation -and $result.legacy_detected) 'choice 1 copies explicitly selected external ZIP under a core-compatible generated basename'
    $backupFolder = Join-Path $hostRoot 'deployment\data\backups'
    $copied = Join-Path $backupFolder $result.archive
    Assert-InternetDataChoice ([Convert]::ToBase64String([IO.File]::ReadAllBytes($copied)) -ceq $sourceBytes) 'copied archive bytes match the selected file'
    Assert-InternetDataChoice ([Convert]::ToBase64String([IO.File]::ReadAllBytes($source)) -ceq $sourceBytes) 'selected source file is preserved'
    Assert-InternetDataChoice (-not (Test-Path -LiteralPath $production)) 'copy never restores or parses archive/database contents'
    $acl = Get-Acl -LiteralPath $copied
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    Assert-InternetDataChoice ($acl.AreAccessRulesProtected -and @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed }).Count -eq 0) 'copied backup remains private'
    $beforePrompts = $script:promptCount
    $explicit = Resolve-QStudyInternetDataChoice -Root $hostRoot -Archive $result.archive
    Assert-InternetDataChoice ($explicit.archive -ceq $result.archive -and -not $explicit.new_installation -and $script:promptCount -eq $beforePrompts) 'an explicit existing archive is returned for mandatory later verification without reprompting'
    $explicit = Resolve-QStudyInternetDataChoice -Root $hostRoot -NewInstallation
    Assert-InternetDataChoice ($explicit.new_installation -and $script:promptCount -eq $beforePrompts) 'explicit new installation avoids prompts'
    Assert-InternetDataChoiceThrows { Resolve-QStudyInternetDataChoice -Root $hostRoot -Archive $result.archive -NewInstallation } 'conflicting restore/new flags are refused'
    foreach ($invalid in @('..\outside.zip', 'plain.zip', 'qstudy-20261014-120000-12345678.zip', 'qstudy-20261014-120000-ABCDEFGH.zip')) {
        Assert-InternetDataChoiceThrows { Resolve-QStudyInternetDataChoice -Root $hostRoot -Archive $invalid } 'invalid/missing explicit archive is refused'
    }
    [IO.File]::WriteAllText($production, 'FixtureSecretExistingProductionNeverParsed')
    $result = Resolve-QStudyInternetDataChoice -Root $hostRoot
    Assert-InternetDataChoice ($result.legacy_detected -and -not $result.archive -and -not $result.new_installation -and $script:promptCount -eq $beforePrompts) 'existing production database suppresses legacy choice and remains untouched'
    Assert-InternetDataChoice ([IO.File]::ReadAllText($production) -ceq 'FixtureSecretExistingProductionNeverParsed') 'no existing production account content is modified'
    Remove-Item -LiteralPath $production -Force
    $directoryZIP = Join-Path $outside 'folder.zip'; [IO.Directory]::CreateDirectory($directoryZIP) | Out-Null
    $nonZIP = Join-Path $outside 'backup.txt'; [IO.File]::WriteAllBytes($nonZIP, $payload)
    foreach ($invalidSource in @($directoryZIP, $nonZIP, (Join-Path $outside 'missing.zip'))) {
        Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root $hostRoot -SourcePath $invalidSource } 'directories/non-ZIP/unreadable sources cannot be imported'
    }
    $busySource = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root $hostRoot -SourcePath $source } 'unreadable locked source is rejected without importing anything' }
    finally { $busySource.Dispose() }
    $script:fixedImportName = Split-Path -Leaf $copied
    Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root $hostRoot -SourcePath $source } 'generated archive collision never overwrites a previous backup'
    Assert-InternetDataChoice ([Convert]::ToBase64String([IO.File]::ReadAllBytes($copied)) -ceq $sourceBytes) 'colliding existing archive bytes are preserved'
    $script:fixedImportName = ''
    foreach ($failure in @('mismatch', 'permission')) {
        $script:hashFailure = $failure
        $beforeArchives = @(Get-ChildItem -LiteralPath $backupFolder -Filter '*.zip').Count
        Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root $hostRoot -SourcePath $source } 'checksum/permission failure refuses the copied archive'
        Assert-InternetDataChoice (@(Get-ChildItem -LiteralPath $backupFolder -Filter '*.zip').Count -eq $beforeArchives -and @(Get-ChildItem -LiteralPath $backupFolder -Force -Filter '.import-*.tmp').Count -eq 0) 'failed copy adds no archives and removes only its own temporary file'
    }
    $script:hashFailure = ''
    $lock = [IO.File]::Open((Join-Path $hostRoot '.local\internet-host.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root $hostRoot -SourcePath $source } 'concurrent host operation prevents copy' }
    finally { $lock.Dispose() }
    New-Item -ItemType Junction -Path $sourceJunction -Target $outside | Out-Null
    Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root $hostRoot -SourcePath (Join-Path $sourceJunction 'chosen-backup.zip') } 'linked source parent is refused'
    Remove-InternetDataChoiceFixtureJunction $sourceJunction
    [IO.Directory]::CreateDirectory((Split-Path -Parent $targetJunction)) | Out-Null
    New-Item -ItemType Junction -Path $targetJunction -Target $outside | Out-Null
    Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root (Join-Path $fixture 'linked-host') -SourcePath $source } 'linked backup destination is refused before any copy'
    Remove-InternetDataChoiceFixtureJunction $targetJunction
    # Exercise the real >2 GB bound without allocating/writing a 2 GB payload.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class QStudyDataChoiceSparseFixture {
    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool DeviceIoControl(SafeFileHandle file, uint code,
        IntPtr input, uint inputSize, IntPtr output, uint outputSize,
        out uint bytesReturned, IntPtr overlapped);
}
'@
    $largeSource = Join-Path $outside 'too-large.zip'
    $large = [IO.File]::Open($largeSource, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try {
        [uint32]$returned = 0
        if (-not [QStudyDataChoiceSparseFixture]::DeviceIoControl($large.SafeFileHandle, 0x900c4, [IntPtr]::Zero, 0, [IntPtr]::Zero, 0, [ref]$returned, [IntPtr]::Zero)) { throw 'Could not create bounded sparse test fixture.' }
        $large.SetLength([long]2147483649)
    } finally { $large.Dispose() }
    Assert-InternetDataChoiceThrows { Copy-QStudyInternetSelectedBackup -Root $hostRoot -SourcePath $largeSource } 'source over 2 GB is rejected before hashing/copying'
    Assert-InternetDataChoice ([Convert]::ToBase64String([IO.File]::ReadAllBytes($legacy)) -ceq $legacyBytes) 'all selections and failures preserve the original local database'
    Assert-InternetDataChoice (@(Get-ChildItem -LiteralPath $backupFolder -Force -Filter '.import-*.tmp').Count -eq 0) 'no unfinished private import file remains'
    Write-Host ('Internet data-choice checks passed (' + $checks + ' assertions). Disposable files; no UI/database/ZIP execution.')
} finally {
    foreach ($junction in @($sourceJunction, $targetJunction)) { if (Test-Path -LiteralPath $junction) { Remove-InternetDataChoiceFixtureJunction $junction } }
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($fixturePrefix) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside Internet data-choice fixtures.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
