Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = 'caller-root-must-survive-dot-sourcing'
. (Join-Path $PSScriptRoot '..\launcher_network.ps1')
$script:checks = 0
function Assert-Native([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message }; $script:checks++ }
function Assert-Rejected([scriptblock]$Body, [string]$Message) {
    $failed = $false
    try { & $Body } catch { $failed = $true }
    Assert-Native $failed $Message
}
Assert-Native ($Root -ceq 'caller-root-must-survive-dot-sourcing') 'Loading network functions must not erase the starter root variable.'
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('qstudy-native-network-' + [Guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixture)
try {
    # Real subprocess, intentionally wrong owner. This branch must exit before
    # querying/changing a firewall, invoking UAC or taking private-folder ACLs.
    $wrongOwnerRoot = Join-Path $fixture 'wrong-owner-child'
    $wrongOwnerFolder = Join-Path $wrongOwnerRoot '.local\launcher'
    [void][IO.Directory]::CreateDirectory($wrongOwnerFolder)
    $wrongOwnerAcl = (Get-Item -LiteralPath $wrongOwnerFolder).GetAccessControl().Sddl
    $networkEntry = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\launcher_network.ps1'))
    $powerShellPath = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $powerShellPath -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $networkEntry -Action EnableFirewall -Root $wrongOwnerRoot -Port 8080 -OwnerSid 'S-1-5-21-123' -Nonce ('a' * 32)
    Assert-Native ($LASTEXITCODE -eq 3) 'A different UAC administrator is rejected with a dedicated exit code before host operations.'
    Assert-Native ((Get-Item -LiteralPath $wrongOwnerFolder).GetAccessControl().Sddl -ceq $wrongOwnerAcl) 'Rejected different-owner child does not change the original private directory ACL.'
    Assert-Native (@(Get-ChildItem -LiteralPath $wrongOwnerFolder -Force).Count -eq 0) 'Rejected different-owner child writes no report or other private file.'
    $context = Get-QStudyNativeNetworkContext -Root $fixture -Mode local -Port 3017
    Assert-Native ($context.site_url -ceq 'http://127.0.0.1:3017' -and $context.bind -ceq '127.0.0.1') 'Local mode must not inspect or open the network.'
    Assert-Rejected { Get-QStudyNativeNetworkSpec $fixture 65536 } 'Invalid port must fail.'
    function Get-QStudyNativeRoute { [pscustomobject]@{ client_ip = '192.168.7.42'; gateway = '192.168.7.1' } }
    function Get-QStudyNativePublicIP { '94.125.99.135' }
    $context = Get-QStudyNativeNetworkContext -Root $fixture -Mode internet -Port 8080
    Assert-Native ($context.site_url -ceq 'http://94.125.99.135:8080' -and $context.lan_ip -ceq '192.168.7.42') 'Internet context keeps public and LAN addresses distinct.'
    $context = Get-QStudyNativeNetworkContext -Root $fixture -Mode lan -Port 3008
    Assert-Native ($context.site_url -ceq 'http://192.168.7.42:3008' -and $context.public_ip -ceq '') 'LAN context must not require public IP.'
    $spec = Get-QStudyNativeNetworkSpec $fixture 8080
    $specOther = Get-QStudyNativeNetworkSpec ($fixture + '-other') 8080
    Assert-Native ($spec.rule -cne $specOther.rule) 'Different checkouts must not share firewall ownership.'

    $state = [ordered]@{ version = 1; root = $spec.root; owner_sid = $spec.sid; computer = [Environment]::MachineName; port = 8080; enabled = $true; method = 'none'; record = $null; public_ip = '94.125.99.135'; client_ip = '192.168.7.42'; gateway = '192.168.7.1' }
    Save-QStudyNativeNetworkJson $fixture 'network.json' $state
    Assert-Native ((Read-QStudyNativeNetworkState $fixture).port -eq 8080) 'Matching network state is reusable.'
    $state.computer = 'ANOTHER-COMPUTER'
    Save-QStudyNativeNetworkJson $fixture 'network.json' $state
    Assert-Native ($null -eq (Read-QStudyNativeNetworkState $fixture)) 'Copied process/network state grants no authority.'
    $state.computer = [Environment]::MachineName; $state.owner_sid = 'S-1-5-21-123'
    Save-QStudyNativeNetworkJson $fixture 'network.json' $state
    Assert-Native ($null -eq (Read-QStudyNativeNetworkState $fixture)) 'A different Windows owner must be rejected.'
    Assert-Rejected { Save-QStudyNativeNetworkJson $fixture '..\unrelated.json' @{} } 'Report names must stay bounded.'

    $script:portFilter = [pscustomobject]@{ Protocol = 'TCP'; LocalPort = '8080' }
    function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline)]$InputObject) process { $script:portFilter } }
    $rule = [pscustomobject]@{ Name = $spec.rule; Description = $spec.description; Direction = 'Inbound'; Action = 'Allow' }
    Assert-Native (Test-QStudyNativeFirewallOwned $rule $spec) 'Exact firewall rule belongs to this instance.'
    $script:portFilter.LocalPort = '8081'
    Assert-Native (-not (Test-QStudyNativeFirewallOwned $rule $spec)) 'A different port must not count as owned.'
    $script:portFilter.LocalPort = '8080'; $rule.Description = 'Another application'
    Assert-Native (-not (Test-QStudyNativeFirewallOwned $rule $spec)) 'A foreign description must not count as owned.'

    $created = [DateTime]::UtcNow
    $instance = [Guid]::NewGuid().ToString('N')
    $script:fakeProcess = [pscustomobject]@{ ExecutablePath = 'C:\Runtime\node.exe'; CreationDate = $created; CommandLine = 'node --title=qstudy-' + $instance + ' next start' }
    $script:fakeListeners = @([pscustomobject]@{ OwningProcess = 12345 })
    function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return $script:fakeProcess }
    function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) return $script:fakeListeners }
    $launcher = [ordered]@{ root = $spec.root; owner_sid = $spec.sid; instance = $instance; frontend_port = 8080; bind = '0.0.0.0'; frontend = @{ pid = 12345; exe = 'C:\Runtime\node.exe'; created = $created.ToString('o'); marker = 'next start' } }
    $launcherPath = Join-Path $fixture '.local\launcher\state.json'
    [IO.File]::WriteAllText($launcherPath, ($launcher | ConvertTo-Json -Depth 6))
    Assert-QStudyNativeListener $fixture 8080
    Assert-Native $true 'Exact PID, creation time, executable and instance marker are accepted.'
    $script:fakeListeners = @([pscustomobject]@{ OwningProcess = 777 })
    Assert-Rejected { Assert-QStudyNativeListener $fixture 8080 } 'Foreign listener must not be exposed.'
    $script:fakeListeners = @([pscustomobject]@{ OwningProcess = 12345 }); $script:fakeProcess.CreationDate = $created.AddSeconds(1)
    Assert-Rejected { Assert-QStudyNativeListener $fixture 8080 } 'Reused PID must not grant port ownership.'
    $script:fakeProcess.CreationDate = $created; $script:fakeProcess.CommandLine = 'unrelated node app'
    Assert-Rejected { Assert-QStudyNativeListener $fixture 8080 } 'Another Node command must be rejected.'
    Assert-Rejected { Assert-QStudyNativeListener $fixture 8081 } 'Wrong public port must be rejected.'

    # Exercise orchestration without touching firewall, router, or real processes.
    function Assert-QStudyNativeListener { param($Root, $Port) }
    $script:firewall = @()
    function Invoke-QStudyNativeFirewall { param($Root, $Port, $Enable) $script:firewall += [bool]$Enable }
    function Read-QStudyNativeNetworkState { param($Root) return $null }
    function Enable-QStudyUpnpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description, $PreviousRecord) [pscustomobject]@{ ok = $false; status = 'unsupported'; record = $null } }
    Set-QStudyNativeNetwork -Root $fixture -Mode internet -Port 8080 -PublicIP '94.125.99.135' -SiteUrl 'http://94.125.99.135:8080'
    $saved = [IO.File]::ReadAllText((Join-Path $fixture '.local\launcher\network.json')) | ConvertFrom-Json
    $guide = [IO.File]::ReadAllText((Join-Path $fixture '.local\launcher\router-instructions.txt'))
    Assert-Native ($script:firewall.Count -eq 1 -and $script:firewall[0]) 'Only the selected site rule is enabled.'
    Assert-Native ($saved.external_reachability_proven -eq $false -and $saved.method -eq 'none') 'Unsupported UPnP must never claim external reachability.'
    Assert-Native ($guide.Contains('192.168.7.42') -and $guide.Contains('8080') -and $guide.Contains('94.125.99.135')) 'Manual guide must contain detected exact addresses and port.'
    Assert-Native (-not $guide.Contains('Docker')) 'Native manual instructions must not require Docker.'
    $beforeFirewall = $script:firewall.Count
    Assert-Rejected { Set-QStudyNativeNetwork -Root $fixture -Mode internet -Port 8080 -PublicIP '192.168.7.42' -SiteUrl 'http://192.168.7.42:8080' } 'A private public address must fail before opening anything.'
    Assert-Native ($script:firewall.Count -eq $beforeFirewall) 'Invalid configuration must not modify the firewall.'

    $script:stored = [pscustomobject]@{ version = 1; root = $spec.root; owner_sid = $spec.sid; computer = [Environment]::MachineName; port = 8080; enabled = $true; method = 'upnp'; record = (New-QStudyPortRecord 'upnp' '192.168.7.1' '192.168.7.42' '94.125.99.135' 8080 $spec.mapping_description); public_ip = '94.125.99.135'; client_ip = '192.168.7.42'; gateway = '192.168.7.1' }
    function Read-QStudyNativeNetworkState { param($Root) return $script:stored }
    $script:ownedMapping = [pscustomobject]@{ ExternalPort = 8080; InternalPort = 8080; Protocol = 'TCP'; InternalClient = '192.168.7.42'; Description = $spec.mapping_description; Enabled = $true; ExternalIPAddress = '94.125.99.136' }
    function Get-QStudyUpnpCollection { return ,@($script:ownedMapping) }
    $script:deletedPublic = ''
    function Disable-QStudyUpnpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description, $PreviousRecord) $script:deletedPublic = $PublicIP; [pscustomobject]@{ ok = $true } }
    Disable-QStudyNativeNetwork $fixture
    Assert-Native ($script:deletedPublic -ceq '94.125.99.136' -and -not $script:stored.enabled) 'Dynamic public IP change can clean up the exact owned rule on the same router.'
    $script:stored.enabled = $true; $script:stored.method = 'upnp'; $script:stored.record = @{ owned = $true }; $script:stored.gateway = '192.168.8.1'; $script:deletedPublic = ''
    Disable-QStudyNativeNetwork $fixture
    Assert-Native ($script:stored.cleanup_pending -and -not $script:stored.enabled) 'Changed router closes the host and preserves an explicit cleanup receipt without blocking local startup.'
    Assert-Native ($script:deletedPublic -ceq '' -and -not $script:firewall[-1]) 'Changed networks close the host first and preserve the old mapping for manual inspection.'
    function Read-QStudyNativeNetworkState { param($Root) return $null }
    function Save-QStudyNativeNetworkJson { param($Root, $Name, $Value) throw 'Fixture: disk or ACL unavailable.' }
    $beforeFirewall = $script:firewall.Count
    Assert-Rejected { Set-QStudyNativeNetwork -Root $fixture -Mode lan -Port 3011 -SiteUrl 'http://192.168.7.42:3011' } 'A failed ownership ledger must abort before opening the host.'
    Assert-Native ($script:firewall.Count -eq $beforeFirewall) 'Disk/permission failure must leave the firewall unchanged.'
    Write-Host ('Native network fixtures passed (' + $script:checks + ' checks). No real network settings changed.')
} finally {
    $resolvedFixture = [IO.Path]::GetFullPath($fixture)
    $tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedFixture.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolvedFixture).StartsWith('qstudy-native-network-')) { Remove-Item -LiteralPath $resolvedFixture -Recurse -Force }
}
