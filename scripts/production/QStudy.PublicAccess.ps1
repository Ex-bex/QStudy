# Windows host networking only. No commands run when this file is dot-sourced.
. (Join-Path $PSScriptRoot 'QStudy.HostSetup.ps1')
. (Join-Path $PSScriptRoot '..\QStudy.HomeNetwork.ps1')
. (Join-Path $PSScriptRoot 'QStudy.PortMapping.ps1')
. (Join-Path $PSScriptRoot 'QStudy.PublicPortOwner.ps1')

function Get-QStudyPublicAccessSpec([string]$Root) {
    $id = (Get-QStudyHostTaskName $Root).Substring('QStudy-Internet-'.Length)
    $path = Assert-QStudyHostPath $Root (Join-Path $Root 'scripts\production\Manage-QStudyPublicAccess.ps1')
    return [PSCustomObject]@{
        name = 'QStudy-Port-' + $id
        rule = 'QStudy-HTTP-' + $id
        description = 'QStudy public access: ' + [IO.Path]::GetFullPath($Root)
        mappingDescription = 'QStudy-' + $id
        executable = (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')
        arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $path + '" -Action renew -NoPause'
        userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
}

function Get-QStudyPublicAccessConfiguration([string]$Root) {
    $values = Read-QStudyHostEnvironment $Root
    try {
        if (-not $values.Count -or $values['QSTUDY_HOST_MODE'] -cne 'http' -or $values['ALLOW_PUBLIC_HTTP'] -cne 'true') {
            throw 'QStudy: initialize HTTP IP:port first. This command does not change HTTPS installations.'
        }
        $ip = [string]$values['QSTUDY_PUBLIC_IP']; $rawPort = [string]$values['QSTUDY_HTTP_PORT']
        if ((Get-QStudyIPv4Kind $ip) -ne 'public' -or $rawPort -notmatch '^[1-9][0-9]{0,4}$' -or [int]$rawPort -gt 65535) {
            throw 'QStudy: invalid public IPv4 or TCP port in deployment/.env; values are hidden.'
        }
        $url = 'http://' + $ip + ':' + $rawPort
        if ($values['PUBLIC_BASE_URL'] -cne $url) { throw 'QStudy: public URL must match the saved IPv4 and port exactly.' }
        return [PSCustomObject]@{ public_ip = $ip; port = [int]$rawPort; public_url = $url }
    } finally { $values.Clear() }
}

function Get-QStudyPublicAccessRoute {
    $routes = @(Get-NetRoute -AddressFamily IPv4 -DestinationPrefix '0.0.0.0/0' -ErrorAction Stop |
        Where-Object { $_.NextHop -and $_.NextHop -ne '0.0.0.0' })
    $candidates = @()
    foreach ($route in $routes) {
        $interface = Get-NetIPInterface -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop
        if ($interface.ConnectionState -ne 'Connected') { continue }
        $addresses = @(Get-NetIPAddress -AddressFamily IPv4 -InterfaceIndex $route.InterfaceIndex -ErrorAction Stop |
            Where-Object { $_.AddressState -eq 'Preferred' -and -not $_.SkipAsSource -and (Get-QStudyIPv4Kind $_.IPAddress) -in @('private', 'public') })
        foreach ($address in $addresses) {
            $candidates += [PSCustomObject]@{ client_ip = [string]$address.IPAddress; gateway = [string]$route.NextHop; metric = [int]$route.RouteMetric + [int]$interface.InterfaceMetric }
        }
    }
    $selected = $candidates | Sort-Object metric | Select-Object -First 1
    if ($null -eq $selected) { throw 'QStudy: active Windows IPv4 route not found. Check Ethernet/Wi-Fi and VPN.' }
    if ((Get-QStudyIPv4Kind $selected.gateway) -notin @('private', 'public')) { throw 'QStudy: default gateway is unsuitable for direct hosting.' }
    return $selected
}

function Assert-QStudyPublicAccessExternalIP([string]$PublicIP) {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    try { $observed = [string](Invoke-RestMethod -Uri 'https://api.ipify.org?format=json' -TimeoutSec 12).ip }
    catch { throw 'QStudy: external IPv4 could not be checked. No firewall or router changes were made.' }
    if ($observed -cne $PublicIP) { throw 'QStudy: this connection does not match the configured public IPv4. Check VPN or a changed IP before enabling access.' }
}

function Assert-QStudyPublicAccessPreflight($Spec, [int]$Port) {
    $rules = @(Get-NetFirewallRule -Name $Spec.rule -ErrorAction SilentlyContinue)
    if ($rules.Count -gt 1 -or ($rules.Count -eq 1 -and -not (Test-QStudyPublicAccessFirewallOwned $rules[0] $Spec $Port))) {
        throw 'QStudy: firewall rule belongs to another configuration; no router changes made.'
    }
    $task = Get-ScheduledTask -TaskName $Spec.name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $task -and -not (Test-QStudyPublicAccessTaskOwned $task $Spec)) {
        throw 'QStudy: renewal task belongs to another configuration; no router changes made.'
    }
}

function Get-QStudyPublicAccessStatePath([string]$Root) {
    return Assert-QStudyHostPath $Root (Join-Path $Root '.local\public-access\state.json')
}

function Read-QStudyPublicAccessState([string]$Root, $Spec) {
    $path = Get-QStudyPublicAccessStatePath $Root
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $null }
    if ((Get-Item -LiteralPath $path).Length -gt 65536) { throw 'QStudy: public-access state exceeds its size limit.' }
    try { $state = [IO.File]::ReadAllText($path, [Text.Encoding]::UTF8) | ConvertFrom-Json }
    catch { throw 'QStudy: public-access state is damaged. Inspect .local/public-access privately.' }
    foreach ($property in @('version', 'owner', 'owner_sid', 'enabled', 'public_ip', 'port', 'client_ip', 'gateway', 'method', 'record', 'status', 'checked_utc', 'external_reachability_proven')) {
        if ($null -eq $state.PSObject.Properties[$property]) { throw 'QStudy: incomplete public-access state; no network changes made.' }
    }
    if ($state.version -ne 1 -or $state.owner -cne $Spec.description -or $state.owner_sid -cne $Spec.userSid -or $state.enabled -isnot [bool] -or
        (Get-QStudyIPv4Kind ([string]$state.public_ip)) -ne 'public' -or $state.port -isnot [int] -or $state.port -lt 1 -or $state.port -gt 65535 -or
        $state.method -notin @('upnp', 'nat-pmp', 'manual', 'direct', 'none') -or $state.external_reachability_proven -ne $false) {
        throw 'QStudy: public-access state belongs to another installation or is invalid.'
    }
    return $state
}

function Save-QStudyPublicAccessState([string]$Root, $State) {
    $path = Get-QStudyPublicAccessStatePath $Root
    $folder = Split-Path -Parent $path
    [IO.Directory]::CreateDirectory($folder) | Out-Null
    (Get-Item -LiteralPath $folder).SetAccessControl((New-QStudyPrivateAcl $true $folder))
    $temporary = Assert-QStudyHostPath $Root (Join-Path $folder ([Guid]::NewGuid().ToString('N') + '.tmp'))
    try {
        [IO.File]::WriteAllText($temporary, ($State | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
        (Get-Item -LiteralPath $temporary).SetAccessControl((New-QStudyPrivateAcl $false $temporary))
        if (Test-Path -LiteralPath $path) { [IO.File]::Replace($temporary, $path, [NullString]::Value) }
        else { [IO.File]::Move($temporary, $path) }
    } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force } }
}

function Test-QStudyPublicAccessFirewallOwned($Rule, $Spec, [int]$Port) {
    if ($null -eq $Rule -or $Rule.Name -cne $Spec.rule -or $Rule.Description -cne $Spec.description -or
        [string]$Rule.Direction -ne 'Inbound' -or [string]$Rule.Action -ne 'Allow') { return $false }
    $filters = @($Rule | Get-NetFirewallPortFilter -ErrorAction Stop)
    return $filters.Count -eq 1 -and [string]$filters[0].Protocol -in @('TCP', '6') -and [string]$filters[0].LocalPort -ceq [string]$Port
}

function Set-QStudyPublicAccessFirewall($Spec, [int]$Port, [bool]$Enable) {
    $rules = @(Get-NetFirewallRule -Name $Spec.rule -ErrorAction SilentlyContinue)
    if ($rules.Count -gt 1 -or ($rules.Count -eq 1 -and -not (Test-QStudyPublicAccessFirewallOwned $rules[0] $Spec $Port))) {
        throw 'QStudy: firewall rule name is occupied by another configuration. No foreign rule was changed.'
    }
    if (-not $Enable) {
        if ($rules.Count) { $rules[0] | Remove-NetFirewallRule -ErrorAction Stop }
        return
    }
    if ($rules.Count) { $rules[0] | Set-NetFirewallRule -Enabled True -Profile Any -RemoteAddress Any -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null }
    else {
        New-NetFirewallRule -Name $Spec.rule -DisplayName ('QStudy HTTP TCP ' + $Port) -Description $Spec.description -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port -RemoteAddress Any -Profile Any -EdgeTraversalPolicy Block -ErrorAction Stop | Out-Null
    }
}

function Test-QStudyPublicAccessTaskOwned($Task, $Spec) {
    return (Test-QStudyHostTaskOwned $Task $Spec) -and [string]$Task.Principal.RunLevel -eq 'Limited' -and [string]$Task.Principal.LogonType -eq 'Interactive'
}

function Set-QStudyPublicAccessTask([string]$Root, $Spec, [bool]$Enable) {
    $existing = Get-ScheduledTask -TaskName $Spec.name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $existing -and -not (Test-QStudyPublicAccessTaskOwned $existing $Spec)) { throw 'QStudy: renewal task belongs to another configuration. It was not changed.' }
    if (-not $Enable) {
        if ($null -ne $existing) { Unregister-ScheduledTask -TaskName $Spec.name -TaskPath '\' -Confirm:$false -ErrorAction Stop }
        return
    }
    $action = New-ScheduledTaskAction -Execute $Spec.executable -Argument $Spec.arguments -WorkingDirectory $Root
    $triggers = @(
        New-ScheduledTaskTrigger -AtLogOn -User $Spec.userSid
        New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(15) -RepetitionInterval (New-TimeSpan -Minutes 15)
    )
    $principal = New-ScheduledTaskPrincipal -UserId $Spec.userSid -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 1)
    Register-ScheduledTask -TaskName $Spec.name -TaskPath '\' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Description $Spec.description -Force -ErrorAction Stop | Out-Null
}

function Get-QStudyPublicAccessContext($Configuration, $Route, $Spec) {
    return @{ Gateway = [string]$Route.gateway; ClientIP = [string]$Route.client_ip; PublicIP = [string]$Configuration.public_ip; Port = [int]$Configuration.port; Description = [string]$Spec.mappingDescription }
}

function Assert-QStudyPublicAccessStateMatches($State, $Configuration, $Route) {
    if ($null -eq $State) { return }
    if ($State.public_ip -cne $Configuration.public_ip -or $State.port -ne $Configuration.port -or
        $State.client_ip -cne $Route.client_ip -or $State.gateway -cne $Route.gateway) {
        throw 'QStudy: saved network/IP/port changed. Disable the old setup before enabling a new one; renewal made no changes.'
    }
}

function Invoke-QStudyPublicAccess([string]$Root, [ValidateSet('enable', 'manual', 'disable', 'renew', 'status')][string]$Action, [switch]$RouterCleanupConfirmed) {
    if ($RouterCleanupConfirmed -and $Action -ne 'disable') { throw 'QStudy: router cleanup confirmation is allowed only for disable.' }
    $spec = Get-QStudyPublicAccessSpec $Root
    $state = Read-QStudyPublicAccessState $Root $spec
    if ($Action -eq 'status') {
        if ($null -eq $state) { return [PSCustomObject]@{ code = 0; report = @{ enabled = $false; status = 'not_configured'; external_reachability_proven = $false } } }
        # This is saved configuration status, not a live independent Internet test.
        return [PSCustomObject]@{ code = 0; report = $state }
    }
    $local = Assert-QStudyHostPath $Root (Join-Path $Root '.local\public-access')
    [IO.Directory]::CreateDirectory($local) | Out-Null
    $lockPath = Assert-QStudyHostPath $Root (Join-Path $Root '.local\internet-host.lock')
    $lock = $null
    try {
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch { throw 'QStudy: another public-access operation is running.' }
        # Read again under the lock, including a concurrently disabled renewal.
        $state = Read-QStudyPublicAccessState $Root $spec
        if ($Action -eq 'renew' -and ($null -eq $state -or -not $state.enabled)) {
            return [PSCustomObject]@{ code = 0; report = @{ enabled = $false; status = 'disabled'; external_reachability_proven = $false } }
        }
        if ($Action -eq 'disable') {
            if ($null -eq $state) { return [PSCustomObject]@{ code = 0; report = @{ enabled = $false; status = 'not_configured'; external_reachability_proven = $false } } }
            if ($RouterCleanupConfirmed -and $state.enabled) { throw 'QStudy: first disable local access, then confirm manual router cleanup or lease expiry.' }
            Set-QStudyPublicAccessTask $Root $spec $false
            Set-QStudyPublicAccessFirewall $spec ([int]$state.port) $false
            $cleanup = $true
            if (-not $RouterCleanupConfirmed -and $state.method -in @('upnp', 'nat-pmp') -and $null -ne $state.record) {
                try {
                    $route = Get-QStudyPublicAccessRoute
                    $configuration = [PSCustomObject]@{ public_ip = $state.public_ip; port = $state.port }
                    Assert-QStudyPublicAccessStateMatches $state $configuration $route
                    $context = Get-QStudyPublicAccessContext $configuration $route $spec
                    $result = if ($state.method -eq 'upnp') { Disable-QStudyUpnpPort @context -PreviousRecord $state.record } else { Disable-QStudyNatPmpPort @context -PreviousRecord $state.record }
                    $cleanup = [bool]$result.ok
                } catch { $cleanup = $false }
            }
            $state.enabled = $false; $state.checked_utc = [DateTime]::UtcNow.ToString('o')
            $state.status = if ($cleanup) { 'disabled' } else { 'router_cleanup_pending' }
            if ($cleanup) { $state.method = 'none'; $state.record = $null }
            Save-QStudyPublicAccessState $Root $state
            return [PSCustomObject]@{ code = $(if ($cleanup) { 0 } else { 2 }); report = $state }
        }
        $configuration = Get-QStudyPublicAccessConfiguration $Root
        $route = Get-QStudyPublicAccessRoute
        if ($null -ne $state -and ($state.enabled -or $null -ne $state.record)) { Assert-QStudyPublicAccessStateMatches $state $configuration $route }
        Assert-QStudyPublicAccessPreflight $spec $configuration.port
        Assert-QStudyPublicPortOwner -Root $Root -Port $configuration.port
        Assert-QStudyPublicAccessExternalIP $configuration.public_ip
        $context = Get-QStudyPublicAccessContext $configuration $route $spec
        $previous = if ($null -ne $state) { $state.record } else { $null }
        $method = 'none'; $status = 'manual_required'; $record = $previous
        $mappingStatus = ''; $routerIP = ''; $providerAction = $false
        if ($Action -eq 'manual') {
            if ($null -ne $previous) { throw 'QStudy: disable the owned automatic mapping before choosing manual forwarding.' }
            # Manual selection must not hide WAN/CGNAT evidence already found by
            # the router helper. Re-probe without creating or removing a mapping.
            $probe = Get-QStudyUpnpPort @context
            if ($probe.status -in @('unsupported', 'absent')) { $probe = Get-QStudyNatPmpPort @context }
            $routerIP = [string]$probe.public_ip
            if ($probe.status -eq 'wan_mismatch' -or ($routerIP -and ((Get-QStudyIPv4Kind $routerIP) -ne 'public' -or $routerIP -cne $configuration.public_ip))) {
                throw 'QStudy: router WAN is private/CGNAT or mismatches the configured public IP. Manual forwarding cannot bypass this; resolve it with the provider.'
            }
            if ($null -ne $state -and $null -ne $state.PSObject.Properties['provider_action_required'] -and $state.provider_action_required -and
                $state.gateway -ceq $route.gateway -and $state.client_ip -ceq $route.client_ip -and $state.public_ip -ceq $configuration.public_ip -and $routerIP -cne $configuration.public_ip) {
                throw 'QStudy: previously detected WAN mismatch remains unconfirmed. Verify the router public IPv4 before manual publication.'
            }
            $method = 'manual'; $status = 'manual_forwarding_selected'
        } elseif ((Get-QStudyIPv4Kind $route.client_ip) -eq 'public') {
            if ($route.client_ip -cne $configuration.public_ip) { throw 'QStudy: direct interface IPv4 differs from the configured public IP.' }
            $method = 'direct'; $status = 'direct_interface'
        } else {
            if ($Action -eq 'renew' -and $state.method -in @('manual', 'direct')) { return [PSCustomObject]@{ code = 0; report = $state } }
            $result = if ($null -ne $state -and $state.method -eq 'nat-pmp') { Enable-QStudyNatPmpPort @context -PreviousRecord $previous } else { Enable-QStudyUpnpPort @context -PreviousRecord $previous }
            if (-not $result.ok -and $result.status -eq 'unsupported' -and $null -eq $previous) { $result = Enable-QStudyNatPmpPort @context }
            $mappingStatus = [string]$result.status; $routerIP = [string]$result.public_ip
            $providerAction = $result.status -eq 'wan_mismatch' -or ($routerIP -and ((Get-QStudyIPv4Kind $routerIP) -ne 'public' -or $routerIP -cne $configuration.public_ip))
            if ($result.ok) { $method = [string]$result.method; $status = 'mapping_configured'; $record = $result.record }
            else { $status = 'manual_required'; if ($null -ne $previous) { $method = [string]$state.method } }
        }
        $state = [PSCustomObject]@{
            version = 1; owner = $spec.description; owner_sid = $spec.userSid; enabled = $true; public_ip = $configuration.public_ip; port = [int]$configuration.port
            public_url = $configuration.public_url; client_ip = $route.client_ip; gateway = $route.gateway; method = $method; record = $record
            status = $status; checked_utc = [DateTime]::UtcNow.ToString('o'); external_reachability_proven = $false
            mapping_status = $mappingStatus; router_public_ip = $routerIP; provider_action_required = [bool]$providerAction
        }
        # Persist mapping ownership before firewall/task operations, so a partial
        # setup can always be disabled safely. Renewal never requires elevation.
        Save-QStudyPublicAccessState $Root $state
        if ($providerAction) {
            $state.status = 'provider_action_required'
            Save-QStudyPublicAccessState $Root $state
            return [PSCustomObject]@{ code = 2; report = $state }
        }
        if ($Action -ne 'renew') {
            Set-QStudyPublicAccessFirewall $spec $configuration.port $true
            Set-QStudyPublicAccessTask $Root $spec ($method -in @('upnp', 'nat-pmp'))
        }
        $ready = $status -in @('mapping_configured', 'direct_interface', 'manual_forwarding_selected')
        return [PSCustomObject]@{ code = $(if ($ready) { 0 } else { 2 }); report = $state }
    } finally { if ($null -ne $lock) { $lock.Dispose() } }
}
