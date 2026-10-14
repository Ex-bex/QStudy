# Real instructions and private files; no router, firewall, task or external calls.
param()
. (Join-Path $PSScriptRoot '..\production\QStudy.NetworkGuide.ps1')
$checks = 0
$script:hostMessages = [Collections.Generic.List[string]]::new()
function Write-Host { param($Object); $script:hostMessages.Add([string]$Object) }
function Assert-Guide([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-GuideThrows([scriptblock]$Operation, [string]$Message) {
    $caught = $false
    try { & $Operation | Out-Null } catch { $caught = $true }
    Assert-Guide $caught $Message
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixtureBase = Join-Path $workspace ('.local\network-guide-tests\' + [Guid]::NewGuid().ToString('N'))
$fixture = Join-Path $fixtureBase 'Project with spaces'
[IO.Directory]::CreateDirectory((Join-Path $fixture 'deployment')) | Out-Null
$secretPath = Join-Path $fixture 'deployment\.env'
[IO.File]::WriteAllText($secretPath, "SMTP_PASSWORD='synthetic-must-not-be-read'`nQSTUDY_HTTP_PORT='9999'`n")
$route = [PSCustomObject]@{ client_ip = '192.168.1.55'; gateway = '192.168.1.1'; metric = 1 }
$script:route = $route; $script:routeCalls = 0
function Get-QStudyPublicAccessRoute { $script:routeCalls++; return $script:route }
try {
    $report = Write-QStudyManualNetworkGuide -Root $fixture -PublicIP '94.125.99.135' -Port 8080 -Route $route -Reason 'unsupported'
    Assert-Guide ($report.manual_ready -and -not $report.external_reachability_proven -and -not $report.provider_action_required) 'manual guide does not claim external reachability'
    Assert-Guide ($report.port -eq 8080 -and $report.public_url -ceq 'http://94.125.99.135:8080' -and $report.router_url -ceq 'http://192.168.1.1') 'uses exact supplied public port and real gateway'
    Assert-Guide ($report.guide_path -ceq (Join-Path $fixture '.local\internet-launch\router-instructions.txt')) 'fixed instruction path stays inside project'
    $text = [IO.File]::ReadAllText($report.guide_path, [Text.Encoding]::UTF8)
    foreach ($needle in @('External / WAN port: 8080', 'Internal / LAN port: 8080', 'Server IP: 192.168.1.55', 'Protocol: TCP', 'Enabled: включено', 'а не 94.125.99.135', 'Address Reservation', 'выключенным Wi-Fi', 'Enter', 'выберите 0')) {
        Assert-Guide ($text.Contains($needle)) ('clear manual instructions contain ' + $needle)
    }
    Assert-Guide ($text -notmatch '9999|synthetic-must-not-be-read') 'never reads .env or exposes private data'
    Assert-Guide ($script:hostMessages.Count -eq 2 -and $script:hostMessages[0].Contains('External / WAN port: 8080')) 'instructions are printed without polluting the returned report'
    Assert-Guide (($script:hostMessages -join '') -notmatch 'synthetic-must-not-be-read') 'console contains no private settings'
    Assert-Guide ($script:routeCalls -eq 0) 'supplied route does not inspect live network'
    $bytes = [IO.File]::ReadAllBytes($report.guide_path)
    Assert-Guide ($bytes.Length -gt 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf) 'Russian instructions carry UTF-8 BOM for Windows Notepad'
    Assert-Guide ((Get-Acl -LiteralPath $report.guide_path).AreAccessRulesProtected) 'instructions have private Windows ACL'
    Assert-Guide ((Get-Acl -LiteralPath (Split-Path -Parent $report.guide_path)).AreAccessRulesProtected) 'instruction folder has private Windows ACL'
    $report = Write-QStudyManualNetworkGuide -Root $fixture -PublicIP '94.125.99.135' -Port 8080 -Reason 'manual_required'
    Assert-Guide ($script:routeCalls -eq 1 -and $report.client_ip -ceq '192.168.1.55') 'optional route uses read-only route discovery'
    $alternate = Write-QStudyManualNetworkGuide -Root $fixture -PublicIP '94.125.99.135' -Port 18080 -Route $route -Reason 'unsupported'
    Assert-Guide ($alternate.port -eq 18080 -and ([IO.File]::ReadAllText($alternate.guide_path)).Contains('External / WAN port: 18080')) 'saved nondefault port is retained without automatic reassignment'
    Assert-Guide (@(Get-ChildItem -LiteralPath (Split-Path -Parent $alternate.guide_path) -Filter '*.tmp').Count -eq 0) 'atomic update leaves no temporary files'
    foreach ($reason in @('wan_mismatch', 'provider_action_required', 'cgnat', 'private_wan', 'invalid_wan')) {
        $blocked = Write-QStudyManualNetworkGuide -Root $fixture -PublicIP '94.125.99.135' -Port 8080 -Route $route -Reason $reason
        $blockedText = [IO.File]::ReadAllText($blocked.guide_path)
        Assert-Guide (-not $blocked.manual_ready -and $blocked.provider_action_required) ('WAN evidence blocks manual shortcut: ' + $reason)
        Assert-Guide ($blockedText.Contains('на WAN этого роутера') -and $blockedText.Contains('100.64–127') -and $blockedText.Contains('порт 8080')) 'provider instructions distinguish WAN/CGNAT from forwarding'
        Assert-Guide (-not $blockedText.Contains('Добавьте и сохраните одно правило')) 'known unsuitable WAN does not present forwarding as solution'
    }
    foreach ($reason in @('conflict', 'stale_record', 'router_cleanup_pending', 'foreignport', 'foreign_port', 'port_occupied', 'unknown')) {
        $friendly = Get-QStudyFriendlyNetworkReason -Status $reason
        Assert-Guide (-not $friendly.manual_allowed -and -not $friendly.provider_action_required) ('ownership or unknown reason cannot be bypassed: ' + $reason)
    }
    foreach ($reason in @('manual_required', 'unsupported', 'absent', 'not_configured')) {
        Assert-Guide (Get-QStudyFriendlyNetworkReason -Reason $reason).manual_allowed ('unavailable automation allows deliberate manual setup: ' + $reason)
    }
    Assert-Guide ((Get-QStudyFriendlyNetworkReason -Reason "unsupported`nSMTP_PASSWORD=x").code -ceq 'unknown') 'unknown or multiline reason is reduced to a safe fixed code'
    foreach ($ip in @('100.64.0.1', '192.168.1.1', '127.0.0.1', '94.125.99.135:8080', '094.125.99.135', "94.125.99.135`n", 'https://94.125.99.135', '203.0.113.1', '192.88.99.1')) {
        Assert-GuideThrows { Write-QStudyManualNetworkGuide -Root $fixture -PublicIP $ip -Port 8080 -Route $route } 'noncanonical or unsuitable public IP is rejected'
    }
    foreach ($port in @(0, 65536, -1)) {
        Assert-GuideThrows { Write-QStudyManualNetworkGuide -Root $fixture -PublicIP '94.125.99.135' -Port $port -Route $route } 'invalid port is rejected'
    }
    foreach ($badRoute in @($null, [PSCustomObject]@{}, [PSCustomObject]@{ client_ip = '100.64.1.1'; gateway = '192.168.1.1' }, [PSCustomObject]@{ client_ip = '192.168.1.55'; gateway = '0.0.0.0' }, [PSCustomObject]@{ client_ip = '192.168.1.55'; gateway = '192.168.1.55' }, [PSCustomObject]@{ client_ip = '192.168.1.55'; gateway = 'http://192.168.1.1' })) {
        $script:route = $badRoute
        Assert-GuideThrows { Write-QStudyManualNetworkGuide -Root $fixture -PublicIP '94.125.99.135' -Port 8080 -Route $badRoute } 'invalid or missing route never fabricates LAN values'
    }
    $script:route = $route
    $path = Join-Path $fixture '.local\internet-launch\router-instructions.txt'
    $original = [IO.File]::ReadAllText($path)
    $lock = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try { Assert-GuideThrows { Write-QStudyManualNetworkGuide -Root $fixture -PublicIP '94.125.99.135' -Port 8080 -Route $route } 'locked instruction file cannot be partially overwritten' }
    finally { $lock.Dispose() }
    Assert-Guide ([IO.File]::ReadAllText($path) -ceq $original) 'failed atomic write leaves original instructions intact'
    Assert-Guide (@(Get-ChildItem -LiteralPath (Split-Path -Parent $path) -Filter '*.tmp').Count -eq 0) 'failed atomic write removes temporary file'
    Assert-Guide ([IO.File]::ReadAllText($secretPath).Contains('synthetic-must-not-be-read')) 'private settings are unchanged'
    $outside = Join-Path $fixtureBase 'Outside'
    [IO.Directory]::CreateDirectory($outside) | Out-Null
    $linked = Join-Path $fixtureBase 'Linked Project'
    New-Item -ItemType Junction -Path $linked -Target $outside | Out-Null
    Assert-GuideThrows { Write-QStudyManualNetworkGuide -Root $linked -PublicIP '94.125.99.135' -Port 8080 -Route $route } 'root junction cannot redirect guide outside project'
    Assert-Guide (-not (Test-Path -LiteralPath (Join-Path $outside '.local'))) 'linked external target is untouched'
    # Remove only the junction itself before the checked fixture cleanup.
    [IO.Directory]::Delete($linked)
    $nestedProject = Join-Path $fixtureBase 'Nested Project'
    [IO.Directory]::CreateDirectory($nestedProject) | Out-Null
    $nestedLink = Join-Path $nestedProject '.local'
    New-Item -ItemType Junction -Path $nestedLink -Target $outside | Out-Null
    try {
        Assert-GuideThrows { Write-QStudyManualNetworkGuide -Root $nestedProject -PublicIP '94.125.99.135' -Port 8080 -Route $route } 'nested junction cannot redirect instructions outside project'
        Assert-Guide (-not (Test-Path -LiteralPath (Join-Path $outside 'internet-launch'))) 'nested external target is untouched'
    } finally { [IO.Directory]::Delete($nestedLink) }
    [Console]::WriteLine('QStudy network guide: ' + $checks + ' assertions passed.')
} finally {
    $target = [IO.Path]::GetFullPath($fixtureBase)
    $allowed = [IO.Path]::GetFullPath((Join-Path $workspace '.local\network-guide-tests')).TrimEnd('\') + '\'
    if (-not $target.StartsWith($allowed, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path.' }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
}
