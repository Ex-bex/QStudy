# Disposable settings/state only; no network discovery, router or firewall calls.
. (Join-Path $PSScriptRoot 'QStudy.InternetConfiguration.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixturePrefix = Join-Path $workspace '.local\internet-configuration-tests'
$fixture = Join-Path $fixturePrefix ([Guid]::NewGuid().ToString('N'))
$checks = 0
function Assert-InternetConfiguration([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-InternetConfigurationThrows([scriptblock]$Operation, [string]$Message) {
    $thrown = $false
    try { & $Operation | Out-Null } catch {
        $thrown = $true
        Assert-InternetConfiguration ($_.Exception.Message -notmatch 'FixtureSecret|FixturePassword') 'errors hide private values'
    }
    Assert-InternetConfiguration $thrown $Message
}
function Get-FixtureEnvironmentBytes {
    return [Convert]::ToBase64String([IO.File]::ReadAllBytes($script:environment))
}
function Write-FixtureEnvironment([string]$Text, [bool]$Bom = $false) {
    [IO.File]::WriteAllText($script:environment, $Text, [Text.UTF8Encoding]::new($Bom))
}
try {
    [IO.Directory]::CreateDirectory((Join-Path $fixture 'deployment')) | Out-Null
    $environment = Join-Path $fixture 'deployment\.env'
    $text = @"
# Fixture comments stay byte for byte, including `$ and Unicode письмо.
QSTUDY_HOST_MODE='http'
QSTUDY_PUBLIC_IP='8.8.8.8' # Previous observed address
QSTUDY_HTTP_PORT = '3000' # Preserve spacing
PUBLIC_BASE_URL='http://8.8.8.8:3000'
ALLOW_PUBLIC_HTTP='true'
SECRET_KEY='FixtureSecretApplication0123456789'
BFF_PROXY_SECRET='FixtureSecretProxy9876543210'
SMTP_PASSWORD='FixturePassword`$Literal`${not_env}\письмо'
GEMINI_API_KEY='FixtureSecretGemini`$Literal'
REGISTRATION_ENABLED='false'
RECOVERY_DELIVERY='smtp'
CUSTOM_SETTING='custom-unchanged'
"@.Replace("`r`n", "`n").Replace("`n", "`r`n") + "`r`n"
    Write-FixtureEnvironment $text $true
    $expected = $text.Replace("QSTUDY_PUBLIC_IP='8.8.8.8'", "QSTUDY_PUBLIC_IP='94.125.99.135'").Replace("QSTUDY_HTTP_PORT = '3000'", "QSTUDY_HTTP_PORT = '8080'").Replace("PUBLIC_BASE_URL='http://8.8.8.8:3000'", "PUBLIC_BASE_URL='http://94.125.99.135:8080'")
    $result = @(Set-QStudyInternetAddress -Root $fixture -PublicIP '94.125.99.135')
    Assert-InternetConfiguration ($result.Count -eq 1 -and $result[0].changed -and $result[0].port -eq 8080) 'default address refresh chooses the requested public port 8080'
    Assert-InternetConfiguration ($result[0].public_url -ceq 'http://94.125.99.135:8080' -and $result[0].previous_public_url -ceq 'http://8.8.8.8:3000') 'report contains only exact old/new public origins'
    Assert-InternetConfiguration (($result | ConvertTo-Json -Depth 5) -notmatch 'FixtureSecret|FixturePassword') 'refresh emits no credentials'
    $expectedBytes = [Text.UTF8Encoding]::new($true).GetPreamble() + [Text.UTF8Encoding]::new($false).GetBytes($expected)
    Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq [Convert]::ToBase64String($expectedBytes)) 'only the three address values change; BOM, CRLF, comments, spacing, unknown settings and secrets remain identical'
    $savedBytes = Get-FixtureEnvironmentBytes
    $result = Set-QStudyInternetAddress -Root $fixture -PublicIP '94.125.99.135' -Port 8080
    Assert-InternetConfiguration (-not $result.changed -and (Get-FixtureEnvironmentBytes) -ceq $savedBytes) 'same address is an exact byte-preserving no-op'
    $acl = Get-Acl -LiteralPath $environment
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    Assert-InternetConfiguration ($acl.AreAccessRulesProtected -and @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed }).Count -eq 0) 'refreshed environment keeps private ACLs'
    foreach ($invalidIP in @('192.168.1.1', '100.64.0.1', '127.0.0.1', '8.8.8.08', '94.125.99.135 ', '203.0.113.1', '192.88.99.1', '224.0.0.1', 'https://94.125.99.135', '::1')) {
        Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP $invalidIP } 'noncanonical/nonpublic address is refused'
        Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq $savedBytes) 'invalid address changes no existing bytes'
    }
    foreach ($invalidPort in @(0, 65536, -1)) {
        Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '94.125.99.135' -Port $invalidPort } 'out-of-range port is refused'
        Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq $savedBytes) 'invalid port changes no existing bytes'
    }
    foreach ($invalidText in @(
        $expected.Replace("QSTUDY_HOST_MODE='http'", "QSTUDY_HOST_MODE='https'"),
        $expected.Replace("ALLOW_PUBLIC_HTTP='true'", "ALLOW_PUBLIC_HTTP='false'"),
        $expected.Replace("ALLOW_PUBLIC_HTTP='true'", "ALLOW_PUBLIC_HTTP='True'"),
        ($expected + "QSTUDY_HTTP_PORT='3000'`r`n"),
        ($expected + "smtp_password='FixturePasswordDuplicate'`r`n"),
        $expected.Replace("CUSTOM_SETTING='custom-unchanged'", 'CUSTOM_SETTING=FixtureSecretUnquoted'),
        $expected.Replace("QSTUDY_PUBLIC_IP='94.125.99.135'", "qstudy_public_ip='94.125.99.135'")
    )) {
        Write-FixtureEnvironment $invalidText
        $before = Get-FixtureEnvironmentBytes
        Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '1.1.1.1' } 'invalid/HTTPS/duplicate/imported settings cannot be silently rewritten'
        Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq $before) 'invalid format never changes private settings'
    }
    foreach ($manualEdit in @(
        $expected.Replace("PUBLIC_BASE_URL='http://94.125.99.135:8080'", "PUBLIC_BASE_URL='http://94.125.99.135:3000'"),
        $expected.Replace("QSTUDY_PUBLIC_IP='94.125.99.135'", "QSTUDY_PUBLIC_IP='100.64.0.1'"),
        $expected.Replace("QSTUDY_HTTP_PORT = '8080'", "QSTUDY_HTTP_PORT = '08080'"),
        $expected.Replace("QSTUDY_HTTP_PORT = '8080'", "QSTUDY_HTTP_PORT = 'FixtureSecretMistakenValue'"),
        $expected.Replace("PUBLIC_BASE_URL='http://94.125.99.135:8080'", "PUBLIC_BASE_URL='FixtureSecretMistakenValue'"),
        $expected.Replace("QSTUDY_PUBLIC_IP='94.125.99.135'", "QSTUDY_PUBLIC_IP='FixtureSecretMistakenValue'")
    )) {
        Write-FixtureEnvironment $manualEdit
        $result = Set-QStudyInternetAddress -Root $fixture -PublicIP '94.125.99.135'
        Assert-InternetConfiguration ($result.changed -and $result.previous_public_url -ceq '' -and $result.public_url -ceq 'http://94.125.99.135:8080') 'manual address mismatch repairs to canonical HTTP origin without exposing old malformed fields'
        Assert-InternetConfiguration (($result | ConvertTo-Json) -notmatch 'FixtureSecret|FixturePassword') 'repair report never contains malformed old fields or credentials'
        Assert-InternetConfiguration ([IO.File]::ReadAllText($environment, [Text.Encoding]::UTF8) -ceq $expected) 'manual repair changes only the three address values'
    }
    Write-FixtureEnvironment $expected
    $stateFolder = Join-Path $fixture '.local\public-access'
    [IO.Directory]::CreateDirectory($stateFolder) | Out-Null
    $statePath = Join-Path $stateFolder 'state.json'
    $spec = Get-QStudyPublicAccessSpec $fixture
    $state = [PSCustomObject]@{
        version = 1; owner = $spec.description; owner_sid = $spec.userSid; enabled = $true
        public_ip = '94.125.99.135'; port = 8080; client_ip = '192.168.1.9'; gateway = '192.168.1.1'
        method = 'manual'; record = $null; status = 'manual'; checked_utc = [DateTime]::UtcNow.ToString('o'); external_reachability_proven = $false
    }
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10))
    $before = Get-FixtureEnvironmentBytes
    Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '1.1.1.1' } 'enabled public mapping blocks an address change'
    Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq $before) 'active state refusal preserves existing settings'
    $result = Set-QStudyInternetAddress -Root $fixture -PublicIP '94.125.99.135' -Port 8080
    Assert-InternetConfiguration (-not $result.changed) 'same address can be reused with an owned active mapping'
    Write-FixtureEnvironment ($expected.Replace("PUBLIC_BASE_URL='http://94.125.99.135:8080'", "PUBLIC_BASE_URL='http://94.125.99.135:3000'"))
    $mismatchedBytes = Get-FixtureEnvironmentBytes
    Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '94.125.99.135' } 'even a base-URL-only repair requires active mapping cleanup'
    Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq $mismatchedBytes) 'active mapping blocks all three kinds of address edits'
    Write-FixtureEnvironment $expected
    $state.enabled = $false; $state.method = 'nat-pmp'; $state.record = [PSCustomObject]@{ epoch = 1 }
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10))
    Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '1.1.1.1' } 'stale disabled router record blocks unsafe address changes'
    $state.method = 'none'; $state.record = $null; $state.owner_sid = 'S-1-5-18'
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10))
    Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '1.1.1.1' } 'foreign state owner blocks configuration changes'
    $state.owner_sid = $spec.userSid; $state.owner = 'Foreign project'
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10))
    Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '1.1.1.1' } 'foreign state root blocks configuration changes'
    [IO.File]::WriteAllText($statePath, '{bad-json')
    Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '1.1.1.1' } 'corrupt state blocks configuration changes'
    $state.owner = $spec.description
    [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 10))
    $result = Set-QStudyInternetAddress -Root $fixture -PublicIP '1.1.1.1' -Port 8080
    Assert-InternetConfiguration ($result.changed -and $result.public_url -ceq 'http://1.1.1.1:8080') 'clean disabled owned state allows address refresh'
    Assert-InternetConfiguration ([IO.File]::ReadAllText($statePath) -ceq ($state | ConvertTo-Json -Depth 10)) 'configuration refresh never modifies network ownership state'
    $before = Get-FixtureEnvironmentBytes
    $lock = [IO.File]::Open((Join-Path $fixture '.local\internet-host.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '8.8.8.8' } 'concurrent host operation prevents refresh' }
    finally { $lock.Dispose() }
    Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq $before) 'lock conflict leaves settings unchanged'
    $busyFile = [IO.File]::Open($environment, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try { Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '8.8.8.8' } 'busy destination makes atomic replacement fail safely' }
    finally { $busyFile.Dispose() }
    Assert-InternetConfiguration ((Get-FixtureEnvironmentBytes) -ceq $before) 'failed atomic replacement preserves old configuration bytes'
    Assert-InternetConfiguration (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'deployment') -Force -Filter '.env.internet-*.tmp').Count -eq 0) 'temporary private files are removed after success/failure'
    Remove-Item -LiteralPath $environment -Force
    Assert-InternetConfigurationThrows { Set-QStudyInternetAddress -Root $fixture -PublicIP '94.125.99.135' } 'fresh installation must initialize through the manager'
    Assert-InternetConfiguration (-not (Test-Path -LiteralPath $environment)) 'address refresh never creates credentials or a fresh .env'
    Write-Host ('Internet configuration checks passed (' + $checks + ' assertions). Disposable private settings only.')
} finally {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($fixturePrefix) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside Internet configuration test fixtures.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
