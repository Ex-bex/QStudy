# Disposable secrets, real ACLs, no Docker, DNS, mail, or real configuration reads.
. (Join-Path $PSScriptRoot 'QStudy.HostSetup.ps1')
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixturePrefix = Join-Path $workspace '.local\host-setup-tests'
$fixture = Join-Path $fixturePrefix ([Guid]::NewGuid().ToString('N'))
$checks = 0
function Assert-Setup([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-SetupThrows([scriptblock]$Operation, [string]$Message) {
    $thrown = $false
    try { & $Operation } catch {
        $thrown = $true
        Assert-Setup ($_.Exception.Message -notmatch 'FixtureSecret|FixturePassword') 'failures redact private values'
    }
    Assert-Setup $thrown $Message
}
$junction = Join-Path $fixture 'deployment\data\linked'
try {
    [IO.Directory]::CreateDirectory((Join-Path $fixture 'deployment')) | Out-Null
    Assert-Setup ((Read-QStudyHostEnvironment $fixture).Count -eq 0) 'missing configuration is read without creation'
    Assert-Setup (-not (Test-Path -LiteralPath (Join-Path $fixture 'deployment\.env'))) 'read-only helper creates no settings'
    $environment = Join-Path $fixture 'deployment\.env'
    $template = [IO.File]::ReadAllText((Join-Path $workspace 'deployment\.env.example'))
    $template = $template.Replace("SECRET_KEY=''", "SECRET_KEY='FixtureSecretApplication0123456789012345'").Replace("BFF_PROXY_SECRET=''", "BFF_PROXY_SECRET='FixtureSecretProxy98765432109876543210'")
    [IO.File]::WriteAllText($environment, $template, [Text.UTF8Encoding]::new($false))
    $before = Read-QStudyHostEnvironment $fixture
    Assert-Setup ($before['REGISTRATION_ENABLED'] -eq 'false') 'fresh deployment has registration closed until administrator setup'
    $password = 'FixturePassword$Literal${not_env}\письмо'
    $output = @(Set-QStudyHostSettings $fixture @{
        SMTP_HOST = 'smtp.example.org'; SMTP_PORT = '465'; SMTP_SECURITY = 'ssl'
        SMTP_USERNAME = 'owner@example.org'; SMTP_PASSWORD = $password; SMTP_FROM = 'owner@example.org'; RECOVERY_DELIVERY = 'smtp'
        GEMINI_API_KEY = 'FixtureSecretGemini$Literal'
    })
    Assert-Setup ($output.Count -eq 0) 'private updates emit no secret output'
    $after = Read-QStudyHostEnvironment $fixture
    Assert-Setup ($after['SMTP_PASSWORD'] -ceq $password) 'Unicode, dollars, braces and backslashes are saved literally'
    Assert-Setup ($after['SECRET_KEY'] -ceq $before['SECRET_KEY'] -and $after['BFF_PROXY_SECRET'] -ceq $before['BFF_PROXY_SECRET']) 'application and proxy secrets are preserved'
    Assert-Setup ($after['QSTUDY_DOMAIN'] -ceq $before['QSTUDY_DOMAIN'] -and $after['PUBLIC_BASE_URL'] -ceq $before['PUBLIC_BASE_URL']) 'domain/origin cannot be silently changed'
    $acl = Get-Acl -LiteralPath $environment
    $allowed = @([Security.Principal.WindowsIdentity]::GetCurrent().User.Value, 'S-1-5-18', 'S-1-5-32-544')
    Assert-Setup ($acl.AreAccessRulesProtected -and @($acl.Access | Where-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed }).Count -eq 0) 'atomic update preserves private file ACL'
    Assert-Setup (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'deployment') -Force -Filter '.env.setup-*.tmp').Count -eq 0) 'temporary credential file is removed after success'
    foreach ($invalid in @(
        @{ SECRET_KEY = 'FixtureSecretOverride' }, @{ SMTP_PASSWORD = "FixturePassword'bad" },
        @{ SMTP_PASSWORD = "FixturePassword`nmalicious" }, @{ SMTP_PORT = '0' },
        @{ SMTP_PORT = '65536' }, @{ SMTP_SECURITY = 'none' }, @{ REGISTRATION_ENABLED = 'maybe' },
        @{ RECOVERY_DELIVERY = 'local' }, @{ SMTP_PASSWORD = '' }, @{ GEMINI_API_KEY = 42 }
    )) {
        $bytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($environment))
        Assert-SetupThrows { Set-QStudyHostSettings $fixture $invalid } 'invalid settings are refused'
        Assert-Setup ([Convert]::ToBase64String([IO.File]::ReadAllBytes($environment)) -ceq $bytes) 'invalid update leaves existing configuration unchanged'
    }
    $lock = [IO.File]::Open((Join-Path $fixture '.local\internet-host.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-SetupThrows { Set-QStudyHostSettings $fixture @{ GEMINI_API_KEY = 'FixtureSecretNew' } } 'concurrent manager lock prevents private changes' }
    finally { $lock.Dispose() }
    $previousBytes = [Convert]::ToBase64String([IO.File]::ReadAllBytes($environment))
    $busyFile = [IO.File]::Open($environment, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try { Assert-SetupThrows { Set-QStudyHostSettings $fixture @{ GEMINI_API_KEY = 'FixtureSecretCannotReplace' } } 'busy settings file causes atomic replacement failure' }
    finally { $busyFile.Dispose() }
    Assert-Setup ([Convert]::ToBase64String([IO.File]::ReadAllBytes($environment)) -ceq $previousBytes) 'failed atomic replacement preserves old configuration byte for byte'
    Assert-Setup (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'deployment') -Force -Filter '.env.setup-*.tmp').Count -eq 0) 'failed atomic replacement removes private temporary file'
    $outside = Join-Path $fixture 'outside'
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    [IO.Directory]::CreateDirectory((Split-Path -Parent $junction)) | Out-Null
    New-Item -ItemType Junction -Path $junction -Target $outside | Out-Null
    Assert-SetupThrows { Set-QStudyHostSettings $fixture @{ GEMINI_API_KEY = 'FixtureSecretNew' } } 'linked production storage is rejected'
    Remove-Item -LiteralPath $junction -Force
    $report = [PSCustomObject]@{
        version = 1; offline = $false; checkedUtc = [DateTime]::UtcNow.ToString('o'); domain = 'qstudy.example.org'
        dnsAssessment = 'ipv4_matches'; wanAssessment = 'public_wan_matches'; externalReachabilityProven = $false
    }
    Assert-QStudyHostNetworkForStart $report 'qstudy.example.org'
    Assert-Setup (-not $report.externalReachabilityProven) 'local readiness never proves independent Internet reachability'
    foreach ($assessment in @('cgnat', 'private_wan', 'invalid_wan', 'wan_mismatch')) {
        $report.wanAssessment = $assessment
        Assert-SetupThrows { Assert-QStudyHostNetworkForStart $report 'qstudy.example.org' } 'known direct hosting blockers prevent wizard startup'
    }
    $report.wanAssessment = 'wan_unknown'
    $report.dnsAssessment = 'ipv4_mismatch'
    Assert-SetupThrows { Assert-QStudyHostNetworkForStart $report 'qstudy.example.org' } 'domain pointing at another host cannot pass'
    $report.dnsAssessment = 'ipv4_matches'
    Assert-SetupThrows { Assert-QStudyHostNetworkForStart $report 'another.example.org' } 'report must match requested domain'
    $report.checkedUtc = [DateTime]::UtcNow.AddHours(-1).ToString('o')
    Assert-SetupThrows { Assert-QStudyHostNetworkForStart $report 'qstudy.example.org' } 'old reports cannot authorize startup'
    $report.checkedUtc = [DateTime]::UtcNow.ToString('o'); $report.offline = $true
    Assert-SetupThrows { Assert-QStudyHostNetworkForStart $report 'qstudy.example.org' } 'offline reports cannot pass live startup checks'
    Write-Host ('Host setup checks passed (' + $checks + ' assertions). Disposable private settings only.')
} finally {
    if (Test-Path -LiteralPath $junction) { Remove-Item -LiteralPath $junction -Force }
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith([IO.Path]::GetFullPath($fixturePrefix) + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) { throw 'Refusing cleanup outside setup test fixtures.' }
    if (Test-Path -LiteralPath $resolved) { Remove-Item -LiteralPath $resolved -Recurse -Force }
}
