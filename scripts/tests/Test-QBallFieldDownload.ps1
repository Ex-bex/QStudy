param([ValidateSet('field', 'physics', 'maps')][string]$Variant = 'field', [switch]$SimulateEnglishOem)
# PowerShell 5.1 fixtures for the pinned downloaders. No download, runtime, or live data.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$physics = $Variant -ceq 'physics'
$maps = $Variant -ceq 'maps'
$cmdName = if ($maps) { 'Update-QBall-Maps.cmd' } elseif ($physics) { 'Update-QBall-Physics.cmd' } else { 'Update-QBall-Field.cmd' }
$archiveName = if ($maps) { 'QStudy-QBall-Maps-Fix.zip' } elseif ($physics) { 'QStudy-QBall-Original-Physics.zip' } else { 'QStudy-QBall-Browser-Fix.zip' }
$bootstrapRelative = 'assets/distribution/' + $cmdName
$bootstrapPath = Join-Path $workspace $bootstrapRelative
$bootstrap = [IO.File]::ReadAllText($bootstrapPath)
$marker = '#==QBALL_FIELD_POWERSHELL=='
$offset = $bootstrap.LastIndexOf($marker, [StringComparison]::Ordinal)
if ($offset -lt 0) { throw 'Missing QBall field downloader marker.' }
. ([scriptblock]::Create($bootstrap.Substring($offset + $marker.Length))) -Library
Add-Type -AssemblyName System.IO.Compression
if ($SimulateEnglishOem) {
    # A fixture-only OEM437 provider proves UTF-8 physics output does not depend
    # on the Windows system language. No console or OS code-page setting changes.
    Add-Type -TypeDefinition 'public static class QBallFieldConsoleEncoding { public static uint GetOEMCP() { return 437; } }'
}
$prefix = [IO.Path]::GetFullPath((Join-Path $workspace '.local/field-download-tests'))
$fixture = Join-Path $prefix ([Guid]::NewGuid().ToString('N'))
$script:fieldChecks = 0; $script:fieldArchiveNumber = 0
$junctions = [Collections.Generic.List[string]]::new()
function Assert-Field([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }; $script:fieldChecks++
}
function Assert-FieldThrows([scriptblock]$Operation, [string]$Message) {
    $failed = $false; try { & $Operation } catch { $failed = $true }
    Assert-Field $failed $Message
}
function Assert-FieldChildText([string]$Actual, [string]$Russian, [string]$Ascii, [string]$Message) {
    $checkRussian = $physics -or $maps
    if (-not $checkRussian) {
        $oem = [Text.Encoding]::GetEncoding([int][QBallFieldConsoleEncoding]::GetOEMCP())
        $checkRussian = $oem.GetString($oem.GetBytes($Russian)) -ceq $Russian
        if (-not $checkRussian) {
            Write-Host ('Legacy field OEM ' + $oem.CodePage + ' cannot represent Cyrillic; its ASCII output and exit status are verified instead.')
        }
    }
    $valid = $Actual.Contains($Ascii) -and (-not $checkRussian -or $Actual.Contains($Russian)) -and -not $Actual.Contains('#< CLIXML')
    if (-not $valid) { Write-Host ('Fixture child output: ' + $Actual) }
    Assert-Field $valid $Message
}
function New-FieldProject([string]$Name) {
    $project = Join-Path $fixture $Name
    foreach ($directory in @('frontend', 'backend', 'scripts')) { [IO.Directory]::CreateDirectory((Join-Path $project $directory)) | Out-Null }
    foreach ($relative in @('Start-QStudy-Internet.cmd', 'scripts/Start-QStudy.ps1', 'backend/studyhub.db', 'backend/.env', 'frontend/existing-source.ts')) {
        [IO.File]::WriteAllText((Join-Path $project $relative), ('UNCHANGED fixture ' + $relative), [Text.UTF8Encoding]::new($false))
    }
    return $project
}
function New-FieldArchive([string[]]$Additional) {
    $script:fieldArchiveNumber++
    $path = Join-Path $fixture ('malformed-' + $script:fieldArchiveNumber + '.zip')
    $stream = [IO.File]::Open($path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    $zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create, $false)
    try {
        foreach ($name in @('Apply-QBall-Fix.cmd', '.qstudy-fix/Apply.ps1', '.qstudy-fix/manifest.json') + $Additional) {
            $entry = $zip.CreateEntry($name)
            $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
            try { $writer.Write('fixture content, never executed') } finally { $writer.Dispose() }
        }
    } finally { $zip.Dispose(); $stream.Dispose() }
    return $path
}
function Assert-FieldOriginal([string]$Project) {
    foreach ($relative in @('Start-QStudy-Internet.cmd', 'scripts/Start-QStudy.ps1', 'backend/studyhub.db', 'backend/.env', 'frontend/existing-source.ts')) {
        Assert-Field ([IO.File]::ReadAllText((Join-Path $Project $relative)) -ceq ('UNCHANGED fixture ' + $relative)) ('preserve original application/data/settings: ' + $relative)
    }
}
try {
    [IO.Directory]::CreateDirectory($fixture) | Out-Null
    $bootstrapBytes = [IO.File]::ReadAllBytes($bootstrapPath)
    Assert-Field (-not ($bootstrapBytes[0] -eq 239 -and $bootstrapBytes[1] -eq 187 -and $bootstrapBytes[2] -eq 191)) 'raw hybrid CMD has no UTF-8 BOM before @echo'
    Assert-Field ([Text.Encoding]::ASCII.GetString($bootstrapBytes, 0, 9) -ceq '@echo off') 'raw hybrid starts with a CMD instruction'
    $bareLineBreak = $false
    for ($index = 0; $index -lt $bootstrapBytes.Length; $index++) {
        if (($bootstrapBytes[$index] -eq 10 -and ($index -eq 0 -or $bootstrapBytes[$index - 1] -ne 13)) -or
            ($bootstrapBytes[$index] -eq 13 -and ($index + 1 -ge $bootstrapBytes.Length -or $bootstrapBytes[$index + 1] -ne 10))) { $bareLineBreak = $true; break }
    }
    Assert-Field (-not $bareLineBreak) 'every hybrid CMD line break is raw CRLF, including the embedded PowerShell body'
    $attributePattern = '(?m)^' + [regex]::Escape($bootstrapRelative) + '[ \t]+-text(?:[ \t]+whitespace=cr-at-eol)?[ \t]*\r?$'
    Assert-Field ([IO.File]::ReadAllText((Join-Path $workspace '.gitattributes')) -match $attributePattern) 'Git preserves hybrid CMD raw bytes in the downloadable artifact'
    $archive = Join-Path $workspace ('assets/distribution/' + $archiveName)
    $actualHash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Assert-Field ($actualHash -ceq $script:QBallFieldHash) 'bundled bootstrap pins the real repository package SHA256'
    $urlPattern = '^https://github\.com/Ex-bex/QStudy/raw/[a-f0-9]{40}/assets/distribution/' + [regex]::Escape($archiveName) + '$'
    Assert-Field ($script:QBallFieldUrl -match $urlPattern) 'download URL pins a complete immutable commit'
    $project = New-FieldProject 'valid'
    Assert-Field (Test-QBallFieldRoot $project) 'existing fixture installation is recognized'
    Install-QBallFieldPackage $project $archive $actualHash
    Assert-Field (Test-Path -LiteralPath (Join-Path $project '.qstudy-fix/Apply.ps1') -PathType Leaf) 'real package prepares the preserving apply helper'
    Assert-Field (Test-Path -LiteralPath (Join-Path $project 'Apply-QBall-Fix.cmd') -PathType Leaf) 'real package prepares its manual retry button'
    $expectedHelperHash = if ($maps) {
        (Get-FileHash -LiteralPath (Join-Path $workspace 'scripts/maintenance/Apply-QBallFix.ps1') -Algorithm SHA256).Hash.ToLowerInvariant()
    } elseif ($physics) {
        # Original physics stays pinned to its reviewed immutable release helper.
        '9c6ce201bb743b7217f28addfa4a75419770d11307e0a2bccae69e53eae3c19b'
    } else {
        # The field launcher pins the unchanged d3fc338c729ab0845831b8038c0e77613bcc2dce release.
        # Later source-updater revisions must not silently change that immutable payload.
        '04e8fc690e483b0bb709dca289bf472162797bdd5d41b69f366e8e63684c4211'
    }
    Assert-Field ((Get-FileHash -LiteralPath (Join-Path $project '.qstudy-fix/Apply.ps1') -Algorithm SHA256).Hash.ToLowerInvariant() -ceq $expectedHelperHash) 'extracted helper matches its reviewed release source'
    Assert-FieldOriginal $project
    Install-QBallFieldPackage $project $archive $actualHash
    Assert-FieldOriginal $project
    Assert-Field (-not (Test-Path -LiteralPath (Join-Path $project '.local'))) 'library extraction neither launches the app nor creates runtime state'

    $badHashProject = New-FieldProject 'bad-hash'
    Assert-FieldThrows { Install-QBallFieldPackage $badHashProject $archive ('0' * 64) } 'wrong SHA256 fails before preparing any update files'
    Assert-Field (-not (Test-Path -LiteralPath (Join-Path $badHashProject '.qstudy-fix'))) 'hash mismatch writes no package directory'
    Assert-FieldOriginal $badHashProject
    foreach ($badName in @('../outside.txt', '.qstudy-fix/../backend/config.ts', 'backend/.env', '.qstudy-fix/.env', '.qstudy-fix/payload/frontend/.env.local', '.qstudy-fix//alias.ts', '.qstudy-fix/./alias.ts', '.qstudy-fix\wrong.ts', 'C:/outside.txt')) {
        $badArchive = New-FieldArchive @($badName)
        $target = New-FieldProject ('unsafe-' + $script:fieldArchiveNumber)
        $hash = (Get-FileHash -LiteralPath $badArchive -Algorithm SHA256).Hash.ToLowerInvariant()
        Assert-FieldThrows { Install-QBallFieldPackage $target $badArchive $hash } ('reject archive path: ' + $badName)
        Assert-Field (-not (Test-Path -LiteralPath (Join-Path $target 'Apply-QBall-Fix.cmd'))) 'all archive paths are validated before the first extracted file'
        Assert-FieldOriginal $target
    }
    $duplicates = New-FieldArchive @('.qstudy-fix/README.txt', '.qstudy-fix/readme.txt')
    $duplicateProject = New-FieldProject 'duplicates'
    Assert-FieldThrows { Install-QBallFieldPackage $duplicateProject $duplicates ((Get-FileHash -LiteralPath $duplicates).Hash.ToLowerInvariant()) } 'case-insensitive duplicate ZIP entries are rejected before extraction'
    Assert-Field (-not (Test-Path -LiteralPath (Join-Path $duplicateProject '.qstudy-fix'))) 'duplicate package cannot leave a partial helper'
    $linkedProject = New-FieldProject 'junction'
    $outside = New-FieldProject 'junction-target'
    $junction = Join-Path $linkedProject '.qstudy-fix'; $junctions.Add($junction)
    New-Item -ItemType Junction -Path $junction -Value $outside | Out-Null
    Assert-FieldThrows { Install-QBallFieldPackage $linkedProject $archive $actualHash } 'junction destination cannot redirect extraction outside the installation'
    Assert-Field (-not (Test-Path -LiteralPath (Join-Path $outside 'Apply.ps1'))) 'junction target receives no package files'
    Assert-FieldOriginal $linkedProject; Assert-FieldOriginal $outside
    foreach ($relative in @('../outside', '/outside', 'C:\outside', '.qstudy-fix/../../outside')) {
        Assert-FieldThrows { Resolve-QBallFieldPath $project $relative } ('standalone resolver rejects outside path: ' + $relative)
    }
    # Execute only this tiny fixture child, never the package's real Apply or
    # any runtime. It proves module discovery, text encoding and exit propagation.
    $invokeProject = New-FieldProject 'invoke child ''Кириллица $literal; с пробелом'
    [IO.Directory]::CreateDirectory((Join-Path $invokeProject '.qstudy-fix')) | Out-Null
    $fakeApply = @'
param([string]$Root, [switch]$NoPause)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
if (-not $NoPause -or -not (Test-Path -LiteralPath (Join-Path $Root 'frontend/existing-source.ts'))) { exit 22 }
[void](Get-Command Get-FileHash -ErrorAction Stop)
Write-Host 'QBALL_FIXTURE_GET_FILE_HASH_OK'
Write-Host 'Обновление поля завершено. Аккаунты сохранены.'
if (Test-Path -LiteralPath (Join-Path $Root 'expected-failure.fixture')) {
    [Console]::Error.WriteLine('QBALL_FIXTURE_EXPECTED_FAILURE_SETTINGS_SAFE')
    [Console]::Error.WriteLine('Проверка ожидаемого отказа. Настройки сохранены.')
    exit 19
}
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $invokeProject '.qstudy-fix/Apply.ps1'), $fakeApply, [Text.UTF8Encoding]::new($true))
    $modulePathBefore = $env:PSModulePath
    $success = @(Invoke-QBallFieldApply $invokeProject 6>&1)
    $successText = ($success | ForEach-Object { $_.ToString() }) -join "`n"
    Assert-Field ($success[-1] -is [int] -and $success[-1] -eq 0) 'sanitized nested PS5.1 resolves Get-FileHash and returns success'
    Assert-FieldChildText $successText 'Обновление поля завершено. Аккаунты сохранены.' 'QBALL_FIXTURE_GET_FILE_HASH_OK' 'NoWindow child stdout retains its ASCII marker and every representable Russian character'
    Assert-Field ($env:PSModulePath -ceq $modulePathBefore) 'module path sanitization affects only the child process environment'
    [IO.File]::WriteAllText((Join-Path $invokeProject 'expected-failure.fixture'), 'fixture only')
    $failure = @(Invoke-QBallFieldApply $invokeProject 6>&1)
    $failureText = ($failure | ForEach-Object { $_.ToString() }) -join "`n"
    Assert-Field ($failure[-1] -is [int] -and $failure[-1] -eq 19) 'nonzero child exit remains a failure for the downloader'
    Assert-FieldChildText $failureText 'Проверка ожидаемого отказа. Настройки сохранены.' 'QBALL_FIXTURE_EXPECTED_FAILURE_SETTINGS_SAFE' 'child stderr retains its ASCII marker and every representable Russian character on failure'
    Assert-FieldOriginal $invokeProject

    $descendantProject = New-FieldProject 'descendant holds inherited output'
    [IO.Directory]::CreateDirectory((Join-Path $descendantProject '.qstudy-fix')) | Out-Null
    $descendantApply = @'
param([string]$Root, [switch]$NoPause)
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
$info.Arguments = '-NoProfile -NonInteractive -Command "[Threading.Thread]::Sleep(8000)"'
$info.UseShellExecute = $false; $info.CreateNoWindow = $true
# Redirect stdin alone forces STARTF_USESTDHANDLES, forwarding this child's
# inherited stdout/stderr pipes to the sleeping grandchild without a new UI.
$info.RedirectStandardInput = $true
$child = [Diagnostics.Process]::Start($info)
$child.StandardInput.Close()
[IO.File]::WriteAllText((Join-Path $Root 'descendant-pid.fixture'), [string]$child.Id)
$child.Dispose()
Write-Host 'Тестовый потомок запущен; обновление завершено.'
exit 0
'@
    [IO.File]::WriteAllText((Join-Path $descendantProject '.qstudy-fix/Apply.ps1'), $descendantApply, [Text.UTF8Encoding]::new($true))
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $descendantResult = @(Invoke-QBallFieldApply $descendantProject 6>&1)
    $clock.Stop()
    $descendantProcess = $null
    try {
        $descendantPid = [int][IO.File]::ReadAllText((Join-Path $descendantProject 'descendant-pid.fixture'))
        try { $descendantProcess = [Diagnostics.Process]::GetProcessById($descendantPid) } catch { }
        Assert-Field ($descendantResult[-1] -is [int] -and $descendantResult[-1] -eq 0) 'updater success is independent of a detached grandchild holding its output pipe'
        Assert-Field ($clock.ElapsedMilliseconds -lt 6000) 'completed updater returns within six seconds instead of waiting for inherited-pipe EOF'
        Assert-Field ($null -ne $descendantProcess -and -not $descendantProcess.HasExited) 'the eight-second fixture grandchild remains alive when the updater has already returned'
    } finally {
        if ($null -ne $descendantProcess) {
            [void]$descendantProcess.WaitForExit(11000)
            $descendantProcess.Dispose()
        }
    }
    Assert-FieldOriginal $descendantProject
    Write-Host ('QBall pinned ' + $Variant + ' download: ' + $script:fieldChecks + ' assertions passed.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith($prefix + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the field download fixture.' }
    foreach ($junction in $junctions) { if (Test-Path -LiteralPath $junction) { [IO.Directory]::Delete($junction) } }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
