# Real configuration/state/ACL/locking; fake OS networking and mapper functions.
# No firewall, task, router or external-service mutation is performed.
param()
. (Join-Path $PSScriptRoot '..\production\QStudy.PublicAccess.ps1')
$checks = 0
function Assert-Access([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
function Assert-AccessThrows([scriptblock]$Operation, [string]$Message) {
    $caught = $false
    try { & $Operation | Out-Null } catch { $caught = $true }
    Assert-Access $caught $Message
}
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$fixture = Join-Path $workspace ('.local\public-access-tests\' + [Guid]::NewGuid().ToString('N') + '\Project with spaces')
[IO.Directory]::CreateDirectory((Join-Path $fixture 'deployment')) | Out-Null
$envPath = Join-Path $fixture 'deployment\.env'
$text = "QSTUDY_HOST_MODE='http'`nALLOW_PUBLIC_HTTP='true'`nQSTUDY_PUBLIC_IP='8.8.8.8'`nQSTUDY_HTTP_PORT='18080'`nPUBLIC_BASE_URL='http://8.8.8.8:18080'`nSMTP_PASSWORD='synthetic-private-value'`n"
[IO.File]::WriteAllText($envPath, $text)
$script:calls = [Collections.Generic.List[string]]::new()
$script:rule = $null; $script:task = $null
$script:gateway = '192.168.1.1'; $script:client = '192.168.1.50'; $script:external = '8.8.8.8'
$script:mapperStatus = 'ready'; $script:mapperMethod = 'upnp'; $script:cleanupOk = $true
$script:portForeign = $false

function Get-QStudyPublicAccessRoute { return [PSCustomObject]@{ gateway = $script:gateway; client_ip = $script:client; metric = 1 } }
function Assert-QStudyPublicPortOwner { param([string]$Root, [int]$Port); if ($script:portForeign) { throw 'QStudy: configured port is occupied by another server.' } }
function Invoke-RestMethod { param($Uri, $TimeoutSec); $script:calls.Add('ipify'); return [PSCustomObject]@{ ip = $script:external } }
function Get-NetFirewallRule { param($Name, $ErrorAction); if ($null -ne $script:rule) { return $script:rule } }
function Get-NetFirewallPortFilter { param([Parameter(ValueFromPipeline)]$InputObject); process { return [PSCustomObject]@{ Protocol = 'TCP'; LocalPort = $script:filterPort } } }
function New-NetFirewallRule { param($Name, $DisplayName, $Description, $Direction, $Action, $Protocol, $LocalPort, $RemoteAddress, $Profile, $EdgeTraversalPolicy, $ErrorAction)
    $script:calls.Add('firewall-enable'); $script:filterPort = $LocalPort
    $script:rule = [PSCustomObject]@{ Name = $Name; Description = $Description; Direction = $Direction; Action = $Action }
    Assert-Access ($Protocol -eq 'TCP' -and $LocalPort -eq 18080 -and $EdgeTraversalPolicy -eq 'Block') 'only saved TCP port opened without edge traversal'
}
function Set-NetFirewallRule { param([Parameter(ValueFromPipeline)]$InputObject, $Enabled, $Profile, $RemoteAddress, $EdgeTraversalPolicy); process { $script:calls.Add('firewall-enable') } }
function Remove-NetFirewallRule { param([Parameter(ValueFromPipeline)]$InputObject); process { $script:calls.Add('firewall-disable'); $script:rule = $null } }
function Get-ScheduledTask { param($TaskName, $TaskPath, $ErrorAction); return $script:task }
function Unregister-ScheduledTask { param($TaskName, $TaskPath, $Confirm, $ErrorAction); $script:calls.Add('task-disable'); $script:task = $null }
function New-ScheduledTaskAction { param($Execute, $Argument, $WorkingDirectory); return [PSCustomObject]@{ Execute = $Execute; Arguments = $Argument } }
function New-ScheduledTaskTrigger { param([switch]$AtLogOn, $User, [switch]$Once, $At, $RepetitionInterval); return [PSCustomObject]@{ atLogOn = [bool]$AtLogOn; interval = $RepetitionInterval } }
function New-ScheduledTaskPrincipal { param($UserId, $LogonType, $RunLevel); return [PSCustomObject]@{ UserId = $UserId; LogonType = $LogonType; RunLevel = $RunLevel } }
function New-ScheduledTaskSettingsSet { param([switch]$StartWhenAvailable, [switch]$AllowStartIfOnBatteries, [switch]$DontStopIfGoingOnBatteries, $ExecutionTimeLimit, $MultipleInstances, $RestartCount, $RestartInterval); return @{} }
function Register-ScheduledTask { param($TaskName, $TaskPath, $Action, $Trigger, $Principal, $Settings, $Description, [switch]$Force, $ErrorAction)
    $script:calls.Add('task-enable'); $script:task = [PSCustomObject]@{ Actions = @($Action); Description = $Description; Principal = $Principal }
    Assert-Access ($Principal.LogonType -eq 'Interactive' -and $Principal.RunLevel -eq 'Limited') 'renewal never executes as SYSTEM or elevated admin'
    Assert-Access (@($Trigger).Count -eq 2 -and $Trigger[1].interval.TotalMinutes -eq 15) 'renewal at sign-in and every fifteen minutes'
}
function New-FakeMapping($Gateway, $ClientIP, $PublicIP, $Port, $Description, $PreviousRecord, [string]$Method) {
    $script:calls.Add('map-' + $Method)
    return [PSCustomObject]@{ ok = ($script:mapperStatus -eq 'ready' -and $script:mapperMethod -eq $Method); status = $(if ($script:mapperMethod -ne $Method) { 'unsupported' } else { $script:mapperStatus }); public_ip = $(if ($script:mapperStatus -eq 'wan_mismatch') { '100.64.1.1' } else { $PublicIP }); method = $Method; record = [PSCustomObject]@{ method = $Method; gateway = $Gateway; client_ip = $ClientIP; public_ip = $PublicIP; port = $Port; description = $Description } }
}
function Get-QStudyUpnpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description); $script:calls.Add('probe-upnp'); return [PSCustomObject]@{ status = 'absent'; public_ip = '' } }
function Get-QStudyNatPmpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description); $script:calls.Add('probe-nat-pmp'); return [PSCustomObject]@{ status = 'available'; public_ip = $(if ($script:mapperStatus -eq 'wan_mismatch') { '100.64.1.1' } else { $PublicIP }) } }
function Enable-QStudyUpnpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description, $PreviousRecord); return New-FakeMapping $Gateway $ClientIP $PublicIP $Port $Description $PreviousRecord 'upnp' }
function Enable-QStudyNatPmpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description, $PreviousRecord); return New-FakeMapping $Gateway $ClientIP $PublicIP $Port $Description $PreviousRecord 'nat-pmp' }
function Disable-QStudyUpnpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description, $PreviousRecord); $script:calls.Add('unmap-upnp'); return [PSCustomObject]@{ ok = $script:cleanupOk } }
function Disable-QStudyNatPmpPort { param($Gateway, $ClientIP, $PublicIP, $Port, $Description, $PreviousRecord); $script:calls.Add('unmap-nat-pmp'); return [PSCustomObject]@{ ok = $script:cleanupOk } }

try {
    $spec = Get-QStudyPublicAccessSpec $fixture
    $config = Get-QStudyPublicAccessConfiguration $fixture
    Assert-Access ($config.port -eq 18080 -and $config.public_url -ceq 'http://8.8.8.8:18080') 'network configuration uses only saved public origin/port'
    Assert-Access (($config | ConvertTo-Json) -notmatch 'synthetic-private-value') 'configuration result contains no SMTP secret'
    foreach ($mutation in @(@("QSTUDY_HOST_MODE='http'", "QSTUDY_HOST_MODE='https'"), @("ALLOW_PUBLIC_HTTP='true'", "ALLOW_PUBLIC_HTTP='false'"), @("QSTUDY_PUBLIC_IP='8.8.8.8'", "QSTUDY_PUBLIC_IP='100.64.1.1'"), @("QSTUDY_HTTP_PORT='18080'", "QSTUDY_HTTP_PORT='0'"), @("PUBLIC_BASE_URL='http://8.8.8.8:18080'", "PUBLIC_BASE_URL='http://8.8.8.8:8080'"))) {
        [IO.File]::WriteAllText($envPath, $text.Replace($mutation[0], $mutation[1]))
        Assert-AccessThrows { Get-QStudyPublicAccessConfiguration $fixture } 'invalid mode, opt-in, IPv4, port or mismatching URL rejected'
    }
    [IO.File]::WriteAllText($envPath, $text)
    $result = Invoke-QStudyPublicAccess $fixture 'status'
    Assert-Access ($result.report.status -eq 'not_configured' -and $script:calls.Count -eq 0) 'status is read-only and makes no external request'
    Invoke-QStudyPublicAccess $fixture 'renew' | Out-Null
    Assert-Access ($script:calls.Count -eq 0) 'absent/disabled setup cannot be enabled by renewal'
    $script:external = '8.8.4.4'
    Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'enable' } 'IP mismatch blocks all router/firewall changes'
    Assert-Access (($script:calls -join ',') -eq 'ipify') 'mismatch only performs read-only IP probe'
    $script:external = '8.8.8.8'; $script:calls.Clear()
    $script:rule = [PSCustomObject]@{ Name = $spec.rule; Description = 'Other app'; Direction = 'Inbound'; Action = 'Allow' }; $script:filterPort = 18080
    Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'enable' } 'foreign firewall rule cannot be replaced'
    Assert-Access ($script:calls.Count -eq 0) 'foreign rule is detected before router mutation'
    $script:rule = $null
    $script:task = [PSCustomObject]@{ Actions = @([PSCustomObject]@{ Execute = 'other.exe'; Arguments = '' }); Description = $spec.description; Principal = [PSCustomObject]@{ UserId = $spec.userSid; LogonType = 'Interactive'; RunLevel = 'Limited' } }
    Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'enable' } 'foreign task cannot be replaced'
    Assert-Access ($script:calls.Count -eq 0) 'foreign task is detected before router mutation'
    $script:task = $null
    $script:portForeign = $true
    Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'enable' } 'occupied foreign TCP port cannot be exposed'
    Assert-Access ($script:calls.Count -eq 0) 'port ownership checked before router or firewall mutation'
    $script:portForeign = $false
    $result = Invoke-QStudyPublicAccess $fixture 'enable'
    Assert-Access ($result.code -eq 0 -and $result.report.method -eq 'upnp' -and -not $result.report.external_reachability_proven) 'UPnP setup never claims independent Internet reachability'
    Assert-Access (($script:calls -join ',') -eq 'ipify,map-upnp,firewall-enable,task-enable') 'mapping, owned firewall and current-user renewal configured in order'
    $saved = [IO.File]::ReadAllText((Get-QStudyPublicAccessStatePath $fixture))
    Assert-Access ($saved -notmatch 'synthetic-private-value' -and $saved -match 'QStudy-') 'only network ownership is persisted, no private credentials'
    Assert-Access ((Get-Acl -LiteralPath (Get-QStudyPublicAccessStatePath $fixture)).AreAccessRulesProtected) 'state uses a private Windows ACL'
    $foreignSpec = Get-QStudyPublicAccessSpec $fixture
    $foreignSpec.userSid = 'S-1-5-18'
    Assert-AccessThrows { Read-QStudyPublicAccessState $fixture $foreignSpec } 'another Windows account cannot take over the saved network state'
    $script:calls.Clear()
    $result = Invoke-QStudyPublicAccess $fixture 'renew'
    Assert-Access (($script:calls -join ',') -eq 'ipify,map-upnp') 'limited renewal never writes firewall or task'
    $script:client = '192.168.1.51'; $script:calls.Clear()
    Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'renew' } 'changed LAN address blocks unsafe renewal'
    Assert-Access ($script:calls.Count -eq 0) 'changed network never touches the old or new mapping'
    $result = Invoke-QStudyPublicAccess $fixture 'disable'
    Assert-Access ($result.code -eq 2 -and $result.report.status -eq 'router_cleanup_pending' -and -not $result.report.enabled) 'changed network disables local exposure and records pending router cleanup'
    Assert-Access (($script:calls -join ',') -eq 'task-disable,firewall-disable') 'cleanup with uncertain router ownership does not delete mapping'
    $script:client = '192.168.1.50'; $script:calls.Clear()
    $result = Invoke-QStudyPublicAccess $fixture 'disable'
    Assert-Access ($result.code -eq 0 -and $result.report.record -eq $null) 'owned mapping cleanup can be retried on original network'
    Assert-Access (($script:calls -join ',') -eq 'unmap-upnp') 'second cleanup deletes only saved mapping'
    $script:calls.Clear(); $script:mapperMethod = 'nat-pmp'
    $result = Invoke-QStudyPublicAccess $fixture 'enable'
    Assert-Access ($result.code -eq 0 -and $result.report.method -eq 'nat-pmp') 'NAT-PMP fallback used only after unsupported UPnP'
    Assert-Access (($script:calls -join ',') -eq 'ipify,map-upnp,map-nat-pmp,firewall-enable,task-enable') 'fallback does not change public TCP port'
    Invoke-QStudyPublicAccess $fixture 'disable' | Out-Null
    $script:mapperMethod = 'upnp'; $script:mapperStatus = 'conflict'; $script:calls.Clear()
    $result = Invoke-QStudyPublicAccess $fixture 'enable'
    Assert-Access ($result.code -eq 2 -and $result.report.status -eq 'manual_required') 'foreign UPnP port requires manual attention'
    Assert-Access (-not $script:calls.Contains('map-nat-pmp')) 'UPnP conflict is never bypassed by NAT-PMP'
    Invoke-QStudyPublicAccess $fixture 'disable' | Out-Null
    $script:calls.Clear()
    $result = Invoke-QStudyPublicAccess $fixture 'manual'
    Assert-Access ($result.code -eq 0 -and $result.report.method -eq 'manual') 'explicit manual forwarding prepares only Windows firewall'
    Assert-Access (($script:calls -join ',') -eq 'ipify,probe-upnp,probe-nat-pmp,firewall-enable') 'manual mode performs only read-only router probes, no mapping or renewal registration'
    $script:calls.Clear()
    Invoke-QStudyPublicAccess $fixture 'status' | Out-Null
    Assert-Access ($script:calls.Count -eq 0) 'saved status never opens, renews or deletes a port'
    $lock = [IO.File]::Open((Join-Path $fixture '.local\internet-host.lock'), [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    try { Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'disable' } 'network and production-manager operations share an exclusive lock' }
    finally { $lock.Dispose() }
    Invoke-QStudyPublicAccess $fixture 'disable' | Out-Null
    $script:mapperStatus = 'wan_mismatch'; $script:calls.Clear()
    $result = Invoke-QStudyPublicAccess $fixture 'enable'
    Assert-Access ($result.code -eq 2 -and $result.report.provider_action_required -and $result.report.router_public_ip -eq '100.64.1.1') 'known CGNAT/WAN evidence is preserved instead of generic manual fallback'
    Assert-Access (-not $script:calls.Contains('firewall-enable') -and -not $script:calls.Contains('task-enable')) 'known unsuitable WAN does not open firewall or register renewal'
    Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'manual' } 'manual forwarding cannot bypass known CGNAT'
    Invoke-QStudyPublicAccess $fixture 'disable' | Out-Null
    $script:mapperStatus = 'ready'; $script:calls.Clear()
    Invoke-QStudyPublicAccess $fixture 'enable' | Out-Null
    Assert-AccessThrows { Invoke-QStudyPublicAccess $fixture 'disable' -RouterCleanupConfirmed } 'manual cleanup acknowledgement requires previously disabled local access'
    $script:cleanupOk = $false
    $result = Invoke-QStudyPublicAccess $fixture 'disable'
    Assert-Access ($result.code -eq 2 -and $result.report.record -ne $null) 'unconfirmed router cleanup retains ownership record for safe retry'
    $script:calls.Clear()
    $result = Invoke-QStudyPublicAccess $fixture 'disable' -RouterCleanupConfirmed
    Assert-Access ($result.code -eq 0 -and $result.report.record -eq $null -and $script:calls.Count -eq 0) 'explicit manual cleanup acknowledgement clears only the disabled local record, no router request'
    Write-Host ('Public access checks passed (' + $checks + ' assertions). No real firewall, router, tasks or Internet calls.')
} finally {
    $target = [IO.Path]::GetFullPath($fixture)
    $prefix = [IO.Path]::GetFullPath((Join-Path $workspace '.local\public-access-tests')) + [IO.Path]::DirectorySeparatorChar
    if (-not $target.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe fixture cleanup path.' }
    Remove-Item -LiteralPath $target -Recurse -Force
}
