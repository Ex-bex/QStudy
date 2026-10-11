param([switch]$KeepFixtures)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'QStudy.Install.ps1')

$repository = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixtureParent = Join-Path $repository ".local\installer-tests\$([Guid]::NewGuid().ToString('N'))"
$fixture = Join-Path $fixtureParent 'Проект QStudy с пробелами'
[IO.Directory]::CreateDirectory((Join-Path $fixture 'backend')) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $fixture 'frontend')) | Out-Null
foreach ($relative in @('backend\requirements.txt', 'backend\.env.example', 'frontend\package.json', 'frontend\package-lock.json')) {
    Copy-Item -LiteralPath (Join-Path $repository $relative) -Destination (Join-Path $fixture $relative)
}
if (Test-Path -LiteralPath (Join-Path $repository 'backend\requirements.lock.txt')) {
    Copy-Item -LiteralPath (Join-Path $repository 'backend\requirements.lock.txt') -Destination (Join-Path $fixture 'backend\requirements.lock.txt')
}
$script:passed = 0
function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAIL: $Message" }
    $script:passed++
    Write-Host "PASS: $Message"
}
function Assert-Throws([scriptblock]$Operation, [string]$Message) {
    $caught = $false
    try { & $Operation | Out-Null } catch { $caught = $true }
    Assert-Test $caught $Message
}

$status = Get-QStudyInstallationStatus $fixture
Assert-Test (-not $status.ready) 'A copied source tree without markers requires installation'
Assert-Test (-not (Test-Path -LiteralPath (Join-Path $fixture '.local'))) 'Read-only status creates no files'
Initialize-QStudySecret $fixture
$envPath = Join-Path $fixture 'backend\.env'
$envBefore = [IO.File]::ReadAllText($envPath)
Assert-Test (Test-QStudySecret $fixture) 'First run creates a valid random secret'
Initialize-QStudySecret $fixture
Assert-Test ([IO.File]::ReadAllText($envPath) -ceq $envBefore) 'Existing credentials remain byte-for-byte unchanged'

$basePython = Find-QStudyBasePython $repository -Offline
$node = Find-QStudyNode $repository -Offline
Assert-Test ($null -ne $basePython -and $null -ne $node) 'Existing compatible Python and Node are detected without downloads'
$warningCode = "import sys; sys.stderr.write('harmless warning'+chr(10)); sys.exit(0)"
Invoke-QStudyInstallCommand $basePython.path @('-I', '-c', $warningCode) $fixture 'Native warning test'
Assert-Test $true 'Native stderr warnings do not abort successful pip/npm commands in PowerShell 5.1'
Assert-Throws { Invoke-QStudyInstallCommand $basePython.path @('-I', '-c', 'import sys; sys.exit(7)') $fixture 'Native failure test' } 'Native nonzero exit codes remain failures'
$venv = Join-Path $fixture 'backend\.venv'
Invoke-QStudyInstallCommand $basePython.path @('-I', '-m', 'venv', $venv) $fixture 'Fixture venv creation'
$venvPython = Join-Path $venv 'Scripts\python.exe'
foreach ($package in @('fastapi', 'uvicorn', 'sqlalchemy', 'pydantic', 'pydantic_settings', 'jwt', 'bcrypt', 'httpx', 'pymupdf', 'docx', 'openpyxl', 'pptx', 'multipart')) {
    [IO.Directory]::CreateDirectory((Join-Path $venv "Lib\site-packages\$package")) | Out-Null
}
[IO.Directory]::CreateDirectory((Join-Path $fixture 'frontend\node_modules\next\dist\bin')) | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture 'frontend\node_modules\next\dist\bin\next'), '')
[IO.File]::WriteAllText((Join-Path $fixture 'frontend\node_modules\.package-lock.json'), '{}')
$runtime = [PSCustomObject]@{
    version = 1; workspace = $fixture; machineName = [Environment]::MachineName
    machineFingerprint = (Get-QStudyInstallComputerFingerprint)
    python = $venvPython; basePython = $basePython.path; pythonVersion = $basePython.version
    node = $node.path; nodeVersion = $node.version; npm = $node.npm
    requirementsHash = (Get-QStudyDependencyHash $fixture)
    lockHash = (Get-QStudyInstallHash (Join-Path $fixture 'frontend\package-lock.json'))
}
Write-QStudyInstallJson (Join-Path $fixture '.local\runtime.json') $runtime
Assert-Test (Get-QStudyInstallationStatus $fixture).ready 'Markers and runtimes work with Cyrillic and spaces under PowerShell 5.1'
$beforeRuntime = [IO.File]::ReadAllText((Join-Path $fixture '.local\runtime.json'))
[void](Ensure-QStudyInstallation $fixture -Offline)
Assert-Test ([IO.File]::ReadAllText((Join-Path $fixture '.local\runtime.json')) -ceq $beforeRuntime) 'A ready offline launch is idempotent'
$runtime.machineName = 'A-DIFFERENT-COMPUTER'
Write-QStudyInstallJson (Join-Path $fixture '.local\runtime.json') $runtime
$status = Get-QStudyInstallationStatus $fixture
Assert-Test ($status.moved -and -not $status.backendReady -and -not $status.frontendReady) 'Same-path transfer to another computer rebuilds both dependency environments'
Assert-Throws { Ensure-QStudyInstallation $fixture -Offline } 'An offline move reports the Internet requirement before altering copied dependencies'
Assert-Test ([IO.File]::ReadAllText($envPath) -ceq $envBefore) 'Offline failure preserves existing credentials'
$runtime.machineName = [Environment]::MachineName
$runtime.machineFingerprint = ('0' * 64)
Write-QStudyInstallJson (Join-Path $fixture '.local\runtime.json') $runtime
Assert-Test (Get-QStudyInstallationStatus $fixture).moved 'Different machine identifiers invalidate copied environments even with the same hostname'
$runtime.machineFingerprint = Get-QStudyInstallComputerFingerprint
Write-QStudyInstallJson (Join-Path $fixture '.local\runtime.json') $runtime
[IO.File]::WriteAllText((Join-Path $fixture 'backend\requirements.lock.txt'), 'fastapi==0.141.1')
$status = Get-QStudyInstallationStatus $fixture
Assert-Test (-not $status.backendReady -and $status.frontendReady) 'A changed Python constraints lock invalidates only backend dependencies'
$runtime.requirementsHash = Get-QStudyDependencyHash $fixture
Write-QStudyInstallJson (Join-Path $fixture '.local\runtime.json') $runtime
[IO.File]::AppendAllText((Join-Path $fixture 'backend\requirements.txt'), "`r`n# changed lock`r`n")
$status = Get-QStudyInstallationStatus $fixture
Assert-Test (-not $status.backendReady -and $status.frontendReady) 'A changed requirements hash invalidates only backend dependencies'

$data = Join-Path $fixture 'backend\studyhub.db'
[IO.File]::WriteAllText($data, 'sentinel user data')
Assert-Throws { Retire-QStudyGeneratedDirectory $fixture 'backend\studyhub.db' } 'Repair refuses to move the database'
Assert-Throws { Retire-QStudyGeneratedDirectory $fixture '..\outside' } 'Repair refuses paths outside the project'
$retired = Retire-QStudyGeneratedDirectory $fixture 'frontend\node_modules'
Assert-Test ((Test-Path -LiteralPath $retired) -and [IO.File]::ReadAllText($data) -ceq 'sentinel user data') 'Only generated dependencies move into a recoverable retired folder'

$artifact = [PSCustomObject]@{ url = 'https://nodejs.org/dist/example.zip'; fileName = 'example.zip'; algorithm = 'SHA256'; hash = ('a' * 64) }
[IO.Directory]::CreateDirectory((Join-Path $fixture '.local\downloads')) | Out-Null
[IO.File]::WriteAllText((Join-Path $fixture '.local\downloads\example.zip'), 'corrupt')
Assert-Throws { Get-QStudyVerifiedDownload $fixture $artifact -Offline } 'Corrupt downloaded archives are rejected before extraction'
$artifact.url = 'https://untrusted.example/runtime.zip'
Assert-Throws { Get-QStudyVerifiedDownload $fixture $artifact } 'Runtime downloads reject nonofficial domains'
Assert-Throws { Expand-QStudyRuntime 'unused' (Join-Path $fixtureParent 'outside') $fixture } 'Runtime extraction refuses destinations outside its designated directory'
Assert-Test ([IO.File]::ReadAllText($envPath) -ceq $envBefore) 'All repair and verification operations preserve the original secret'

# Model a running QStudy identity with this fixture's own test process.
# The standalone installer must refuse to touch its dependencies and never stop it.
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'QStudy.Common.ps1')
$script:QStudyRoot = $fixture
$script:QStudyLocal = Join-Path $fixture '.local'
$script:QStudyStateFile = Join-Path $script:QStudyLocal 'processes.json'
$state = New-QStudyState
$ownIdentity = New-QStudyProcessIdentity (Get-QStudyProcess $PID)
$state.backend = [PSCustomObject]@{ name = 'backend'; identity = $ownIdentity; descendants = @() }
Write-QStudyState $state
$installer = Join-Path (Split-Path -Parent $PSScriptRoot) 'Install-QStudy.ps1'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$guardOutput = @(& $powershell -NoProfile -ExecutionPolicy Bypass -File $installer -RootPath $fixture -ForceRepair -NoPause 2>&1)
$guardExit = $LASTEXITCODE
Assert-Test ($guardExit -eq 1 -and ($guardOutput -join ' ') -like '*Stop-QStudy.cmd*') 'Standalone repair refuses to replace dependencies of a running managed process'
Assert-Test ($null -ne (Get-QStudyOwnedProcess $ownIdentity)) 'Repair refusal leaves the running managed process untouched'
Assert-Test ([IO.File]::ReadAllText($envPath) -ceq $envBefore) 'Repair refusal preserves account secrets and user data'

Write-Host "Installer checks passed: $script:passed. Fixtures: $fixtureParent"
if (-not $KeepFixtures) {
    $resolved = [IO.Path]::GetFullPath($fixtureParent)
    $allowed = [IO.Path]::GetFullPath((Join-Path $repository '.local\installer-tests')) + '\'
    if (-not $resolved.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture cleanup path escaped its test directory.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
}
