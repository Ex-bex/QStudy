Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'Manage-QStudyDuckDNS.ps1')
$passed = 0
function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAIL: ' + $Message) }
    $script:passed++
    Write-Host ('PASS: ' + $Message)
}
function Assert-Throws([scriptblock]$Operation, [string]$Message) {
    $caught = $false
    try { & $Operation | Out-Null } catch { $caught = $true }
    Assert-Test $caught $Message
}
Assert-Test ((ConvertTo-QStudyDuckLabel 'TEST-LABEL.DUCKDNS.ORG') -eq 'test-label') 'Only the selected DuckDNS label is canonicalized'
foreach ($value in @('other.example.org', 'test,other', 'test&token=other', '../test', 'https://test.duckdns.org', '-test', 'test_1')) {
    Assert-Throws { ConvertTo-QStudyDuckLabel $value } 'A domain/query/path cannot redirect or expand DDNS updates'
}
$testToken = '12345678-abcd-1234-abcd-123456789abc'
$uri = New-QStudyDuckUpdateUri 'test' $testToken '8.8.8.8'
Assert-Test ($uri.Scheme -eq 'https' -and $uri.Host -eq 'www.duckdns.org' -and $uri.Port -eq 443 -and $uri.AbsolutePath -eq '/update') 'Tokens are sent only to the documented HTTPS DuckDNS endpoint'
Assert-Throws { New-QStudyDuckUpdateUri 'test' $testToken '192.168.1.1' } 'Private IP cannot replace the public DNS record'
Assert-Throws { New-QStudyDuckUpdateUri 'test' ($testToken + '&domains=other') '8.8.8.8' } 'Token query injection is rejected'
Assert-Throws { New-QStudyDuckUpdateUri 'test' $testToken '100.70.1.2' } 'CGNAT address cannot replace public DNS'
$definition = Get-QStudyDuckTaskDefinition
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $sid = $identity.User.Value } finally { $identity.Dispose() }
$owned = [PSCustomObject]@{ Actions = @([PSCustomObject]@{ Execute = $definition.executable; Arguments = $definition.arguments }); Principal = [PSCustomObject]@{ UserId = $sid } }
Assert-QStudyDuckTaskOwned $owned $definition
Assert-Test $true 'An existing task must match the exact executable, arguments and user'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
try { $shortName = $identity.Name.Split('\')[-1] } finally { $identity.Dispose() }
$canonicalized = [PSCustomObject]@{ Actions = $owned.Actions; Principal = [PSCustomObject]@{ UserId = $shortName } }
Assert-QStudyDuckTaskOwned $canonicalized $definition
Assert-Test $true 'A Scheduler-normalized local username resolves back to the owning SID'
$foreign = [PSCustomObject]@{ Actions = @([PSCustomObject]@{ Execute = 'other.exe'; Arguments = '' }); Principal = [PSCustomObject]@{ UserId = $sid } }
Assert-Throws { Assert-QStudyDuckTaskOwned $foreign $definition } 'A foreign task cannot be overwritten or removed'
$wrongUser = [PSCustomObject]@{ Actions = $owned.Actions; Principal = [PSCustomObject]@{ UserId = 'S-1-5-18' } }
Assert-Throws { Assert-QStudyDuckTaskOwned $wrongUser $definition } 'Another user or SYSTEM cannot be substituted for the token owner'

$repository = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$fixture = Join-Path $repository ('.local\duckdns-tests\' + [Guid]::NewGuid().ToString('N') + '\Проект с пробелами')
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$originalRoot = $script:QStudyDuckRoot
$script:QStudyDuckRoot = $fixture
try {
    $secureToken = ConvertTo-SecureString $testToken -AsPlainText -Force
    try { Save-QStudyDuckConfiguration 'test' $secureToken } finally { $secureToken.Dispose() }
    $path = Get-QStudyDuckConfigurationPath
    $serialized = [IO.File]::ReadAllText($path)
    Assert-Test (-not $serialized.Contains($testToken)) 'The synthetic token is encrypted rather than stored as plaintext'
    $acl = Get-Acl -LiteralPath $path
    Assert-Test $acl.AreAccessRulesProtected 'Token file does not inherit broad access permissions'
    $allowed = @($sid, 'S-1-5-18', 'S-1-5-32-544')
    $actual = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object { $_.IdentityReference.Value })
    Assert-Test (@($actual | Where-Object { $allowed -notcontains $_ }).Count -eq 0 -and $actual.Count -eq 3) 'Only the current user, SYSTEM and Administrators can access the token'
    $configuration = Read-QStudyDuckConfiguration
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($configuration.token)
    try { Assert-Test ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) -ceq $testToken) 'Windows DPAPI round-trip works for the owning user' }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer); $configuration.token.Dispose() }
    $before = [IO.File]::ReadAllText($path)
    $invalid = ConvertTo-SecureString 'invalid-token' -AsPlainText -Force
    try { Assert-Throws { Save-QStudyDuckConfiguration 'test' $invalid } 'Invalid token is rejected before replacing an existing configuration' }
    finally { $invalid.Dispose() }
    Assert-Test ([IO.File]::ReadAllText($path) -ceq $before) 'Rejected configuration preserves existing credentials'
    $json = $before | ConvertFrom-Json
    $json.protectedToken = 'corrupted-dpapi-data'
    [IO.File]::WriteAllText($path, ($json | ConvertTo-Json))
    Assert-Throws { Read-QStudyDuckConfiguration } 'Corrupted or foreign-machine DPAPI data fails without disclosing encrypted contents'

    $secureToken = ConvertTo-SecureString $testToken -AsPlainText -Force
    try { Save-QStudyDuckConfiguration 'test' $secureToken } finally { $secureToken.Dispose() }
    # Preload CIM wrapper functions before installing mocks: automatic import
    # during New-ScheduledTaskAction would replace a mock Register-ScheduledTask.
    Import-Module ScheduledTasks -ErrorAction Stop
    $script:registered = $null
    function Get-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction) return $null }
    function Register-ScheduledTask {
        param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, [switch]$Force)
        $script:registered = [PSCustomObject]@{ Name = $TaskName; Path = $TaskPath; Actions = $Action; Triggers = $Trigger; Principal = $Principal; Settings = $Settings }
    }
    $Action = 'install-autostart'; $Domain = ''
    Invoke-QStudyDuckMain
    Assert-Test ($script:registered.Triggers.Count -eq 2) 'Validated Scheduler triggers include sign-in and periodic refresh without registering a real task'
    $periodic = @($script:registered.Triggers | Where-Object { $null -ne $_.Repetition -and $_.Repetition.Interval })
    Assert-Test ($periodic.Count -eq 1 -and $periodic[0].Repetition.Interval -eq 'PT5M' -and -not $periodic[0].Repetition.Duration) 'Five-minute refresh repeats indefinitely rather than expiring after a day'
    Assert-Test ($script:registered.Principal.LogonType -eq 'Interactive' -and $script:registered.Principal.RunLevel -eq 'Limited') 'DDNS task uses the signed-in token owner without administrator privileges or a stored Windows password'
} finally { $script:QStudyDuckRoot = $originalRoot }

function New-QStudyDuckHttpClient {
    $fake = [PSCustomObject]@{}
    $fake | Add-Member ScriptMethod GetAsync { param($requestUri) throw ('Synthetic network error at ' + $requestUri.AbsoluteUri) }
    $fake | Add-Member ScriptMethod Dispose {}
    return $fake
}
$caughtMessage = ''
try { Invoke-QStudyDuckHttps $uri } catch { $caughtMessage = $_.Exception.Message }
Assert-Test ($caughtMessage -and -not $caughtMessage.Contains($testToken) -and -not $caughtMessage.Contains('/update?')) 'A network exception containing a token URI is redacted before reaching CLI output'
Write-Host ('DuckDNS checks passed: ' + $passed + '; no network updates or real tasks were performed.')
