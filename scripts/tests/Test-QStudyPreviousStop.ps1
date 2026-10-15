# CLI rejection fixtures only: no application processes, network or real data.
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
. (Join-Path $workspace 'scripts\launcher\Native.ps1')
$prefix = Join-Path $workspace '.local\previous-stop-tests'
$fixture = Join-Path $prefix ([Guid]::NewGuid().ToString('N'))
$checks = 0
function Assert-PreviousStop([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
try {
    foreach ($name in @('backend', 'frontend', 'scripts')) { [void][IO.Directory]::CreateDirectory((Join-Path $fixture $name)) }
    Initialize-QStudyNativeStorage $fixture
    $database = Join-Path $fixture 'backend\studyhub.db'
    $settings = Join-Path $fixture 'backend\.env'
    [IO.File]::WriteAllText($database, 'FixtureExistingAccounts')
    [IO.File]::WriteAllText($settings, 'FixturePrivateSettings')
    $dbHash = Get-QStudyInstallHash $database
    $envHash = Get-QStudyInstallHash $settings
    $acl = (Get-Item -LiteralPath (Join-Path $fixture '.local')).GetAccessControl().Sddl
    $entry = Join-Path $workspace 'scripts\launcher\Stop-Previous.ps1'
    $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $entry -Root $fixture -NoPause 2>&1
    Assert-PreviousStop ($LASTEXITCODE -eq 1 -and ($output -join ' ') -like '*Docker Desktop*' -and ($output -join ' ') -like '*Автоматическая остановка не выполнялась*') 'missing managed state gives Docker/manual guidance instead of false success'
    $statePath = Join-Path $fixture '.local\launcher\state.json'
    Write-QStudyInstallJson $statePath @{ version = 3; root = 'C:\unrelated-qstudy'; computer = (Get-QStudyComputerFingerprint); owner_sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value }
    $stateHash = Get-QStudyInstallHash $statePath
    $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $entry -Root $fixture -NoPause 2>&1
    Assert-PreviousStop ($LASTEXITCODE -eq 1 -and ($output -join ' ') -like '*Чужие процессы не изменены*') 'a copied native state cannot authorize a stop'
    Assert-PreviousStop ((Get-QStudyInstallHash $statePath) -ceq $stateHash) 'rejection does not remove copied process state'
    Remove-Item -LiteralPath $statePath -Force
    $legacyPath = Join-Path $fixture '.local\processes.json'
    Write-QStudyInstallJson $legacyPath @{ version = 2; workspace = 'C:\unrelated-qstudy'; computer = (Get-QStudyComputerFingerprint); frontend = $null; backend = $null }
    $legacyHash = Get-QStudyInstallHash $legacyPath
    $output = & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File $entry -Root $fixture -NoPause 2>&1
    Assert-PreviousStop ($LASTEXITCODE -eq 1 -and ($output -join ' ') -like '*состояние относится к другой установке*') 'copied legacy state is rejected before archiving or process management'
    Assert-PreviousStop ((Get-QStudyInstallHash $legacyPath) -ceq $legacyHash -and -not (Test-Path -LiteralPath (Join-Path $fixture '.local\stale-state'))) 'legacy rejection preserves process-state bytes'
    Assert-PreviousStop ((Get-QStudyInstallHash $database) -ceq $dbHash -and (Get-QStudyInstallHash $settings) -ceq $envHash) 'compatibility stop rejection preserves accounts and private settings'
    Assert-PreviousStop ((Get-Item -LiteralPath (Join-Path $fixture '.local')).GetAccessControl().Sddl -ceq $acl) 'compatibility stop never rewrites existing permissions'
    Write-Host ('QStudy previous-version stop: ' + $checks + ' assertions passed.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($prefix) + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside the previous-stop fixture.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
