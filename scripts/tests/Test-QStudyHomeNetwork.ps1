Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'QStudy.HomeNetwork.ps1')
$passed = 0
function Assert-Test([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAIL: ' + $Message) }
    $script:passed++
    Write-Host ('PASS: ' + $Message)
}
foreach ($case in @(
    @('100.64.0.0', 'cgnat'), @('100.127.255.255', 'cgnat'), @('100.63.255.255', 'public'), @('100.128.0.0', 'public'),
    @('10.20.30.40', 'private'), @('172.16.0.1', 'private'), @('172.31.255.254', 'private'), @('172.32.0.1', 'public'),
    @('192.168.1.1', 'private'), @('127.0.0.1', 'loopback'), @('169.254.1.2', 'link_local'),
    @('203.0.113.10', 'reserved'), @('224.0.0.1', 'reserved'), @('8.8.8.8', 'public'),
    @('192.0.0.9', 'public'), @('192.0.0.10', 'public'), @('192.0.0.8', 'reserved'),
    @('8.8.8.8:443', 'invalid'), @('localhost', 'invalid'), @('::1', 'invalid'), @('127.1', 'invalid')
)) { Assert-Test ((Get-QStudyIPv4Kind $case[0]) -eq $case[1]) ('IPv4 classification: ' + $case[0]) }
Assert-Test ((Get-QStudyWanAssessment '' '8.8.8.8') -eq 'wan_unknown') 'An external echo cannot prove router WAN or public reachability'
Assert-Test ((Get-QStudyWanAssessment '100.70.1.2' '8.8.8.8') -eq 'cgnat') 'CGNAT remains CGNAT even when the external echo is public'
Assert-Test ((Get-QStudyWanAssessment '192.168.1.2' '8.8.8.8') -eq 'private_wan') 'Private WAN requires upstream investigation'
Assert-Test ((Get-QStudyWanAssessment '8.8.8.8' '1.1.1.1') -eq 'wan_mismatch') 'VPN or upstream mismatch is not incorrectly confirmed'
Assert-Test ((Get-QStudyWanAssessment '8.8.8.8' '') -eq 'public_wan_unconfirmed') 'Offline public WAN is not claimed externally verified'
Assert-Test ((Get-QStudyWanAssessment '8.8.8.8' '8.8.8.8') -eq 'public_wan_matches') 'Matching public WAN is a prerequisite, not an external port test'
Assert-Test ((Get-QStudyDnsAssessment @('8.8.8.8') @() '8.8.8.8') -eq 'ipv4_matches') 'DNS matching the external IPv4 is recognized'
Assert-Test ((Get-QStudyDnsAssessment @('8.8.8.8', '1.1.1.1') @() '8.8.8.8') -eq 'ipv4_mismatch') 'A second wrong A record is not ignored'
Assert-Test ((Get-QStudyDnsAssessment @('192.168.1.3') @() '8.8.8.8') -eq 'non_public_ipv4') 'Private DNS record cannot pass a public setup check'
Assert-Test ((Get-QStudyDnsAssessment @('8.8.8.8') @('2001:db8::1') '8.8.8.8') -eq 'ipv4_matches_verify_ipv6') 'AAAA requires independent IPv6 verification'
Assert-Test ((Get-QStudyDnsAssessment @() @() '8.8.8.8') -eq 'unresolved') 'Unresolved DNS never passes'
Assert-Test ((ConvertTo-QStudyHomeDomain 'EXAMPLE.DUCKDNS.ORG.') -eq 'example.duckdns.org') 'DNS domains are canonicalized'
foreach ($value in @('https://example.org', 'example.org/path', 'example.org:443', 'example.org?token=secret', 'localhost', '192.168.1.1')) {
    $caught = $false
    try { [void](ConvertTo-QStudyHomeDomain $value) } catch { $caught = $true }
    Assert-Test $caught 'URLs, paths, ports and IP literals are not accepted as DNS names'
}
$fixture = Join-Path (Split-Path -Parent (Split-Path -Parent $PSScriptRoot)) ('.local\home-network-tests\' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($fixture) | Out-Null
$safe = Assert-QStudyHomePath $fixture '.local\report.json'
Assert-Test ($safe.StartsWith($fixture + '\', [StringComparison]::OrdinalIgnoreCase)) 'Report path remains inside the project'
$caught = $false
try { [void](Assert-QStudyHomePath $fixture '..\outside.json') } catch { $caught = $true }
Assert-Test $caught 'Path traversal is rejected before writing'
Write-Host ('Home network checks passed: ' + $passed)
