# Router helpers have no side effects until an Enable/Disable function is called.
# NAT-PMP identifies mappings by source IPv4 + internal port, not by description.
# Its enable operation therefore assumes that the caller has reserved this local
# TCP port for QStudy. NAT-PMP cannot inventory unrelated mappings on that same
# client/port key; use UPnP or manual forwarding if this assumption is uncertain.
Set-StrictMode -Version Latest
if (-not (Get-Command Get-QStudyIPv4Kind -ErrorAction SilentlyContinue)) {
    . (Join-Path (Split-Path -Parent $PSScriptRoot) 'QStudy.HomeNetwork.ps1')
}

function New-QStudyPortResult {
    param([bool]$Ok, [string]$Method, [string]$Status, [string]$Message, [object]$Record = $null, [string]$PublicIP = '')
    [pscustomobject]@{ ok = $Ok; method = $Method; status = $Status; message = $Message; record = $Record; public_ip = $PublicIP }
}

function Get-QStudyRecordValue([object]$Record, [string]$Name) {
    if ($null -eq $Record) { return $null }
    if ($Record -is [Collections.IDictionary]) { return $Record[$Name] }
    $property = $Record.PSObject.Properties[$Name]
    if ($null -ne $property) { return $property.Value }
    return $null
}

function Assert-QStudyPortContext {
    param([string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description)
    if ((Get-QStudyIPv4Kind $Gateway) -notin @('private', 'public') -or
        (Get-QStudyIPv4Kind $ClientIP) -notin @('private', 'public')) { throw 'Router and client must be canonical usable IPv4 addresses.' }
    if ((Get-QStudyIPv4Kind $PublicIP) -ne 'public') { throw 'A canonical public IPv4 is required.' }
    if ($Port -lt 1 -or $Port -gt 65535) { throw 'The TCP port must be between 1 and 65535.' }
    if ($Description -notmatch '^QStudy-[A-Za-z0-9][A-Za-z0-9_.-]{3,111}$') { throw 'An installation-specific QStudy mapping description is required.' }
}

function Test-QStudyPortRecord {
    param([object]$Record, [string]$Method, [string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description)
    if ($null -eq $Record) { return $false }
    foreach ($pair in @(@('method', $Method), @('gateway', $Gateway), @('client_ip', $ClientIP), @('public_ip', $PublicIP), @('description', $Description))) {
        if ([string](Get-QStudyRecordValue $Record $pair[0]) -cne $pair[1]) { return $false }
    }
    $recordPort = 0
    if (-not [int]::TryParse([string](Get-QStudyRecordValue $Record 'port'), [ref]$recordPort) -or $recordPort -ne $Port) { return $false }
    $created = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string](Get-QStudyRecordValue $Record 'created_utc'), [ref]$created) -or
        $created -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) { return $false }
    if ($Method -eq 'nat-pmp') {
        $expires = [DateTimeOffset]::MinValue
        $epoch = [uint32]0
        $lifetime = 0
        if (-not [DateTimeOffset]::TryParse([string](Get-QStudyRecordValue $Record 'expires_utc'), [ref]$expires) -or
            -not [uint32]::TryParse([string](Get-QStudyRecordValue $Record 'epoch'), [ref]$epoch) -or
            -not [int]::TryParse([string](Get-QStudyRecordValue $Record 'lifetime_seconds'), [ref]$lifetime) -or
            $lifetime -lt 1800 -or $lifetime -gt 86400 -or $expires -le $created -or
            [Math]::Abs(($expires - $created).TotalSeconds - $lifetime) -gt 1) { return $false }
    }
    return $true
}

function New-QStudyPortRecord {
    param([string]$Method, [string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description, [int]$LifetimeSeconds = 0, [uint32]$Epoch = 0)
    $created = [DateTimeOffset]::UtcNow
    [pscustomobject]@{
        method = $Method; gateway = $Gateway; client_ip = $ClientIP; public_ip = $PublicIP
        port = $Port; description = $Description; created_utc = $created.ToString('o')
        expires_utc = $(if ($LifetimeSeconds -gt 0) { $created.AddSeconds($LifetimeSeconds).ToString('o') } else { $null })
        lifetime_seconds = $LifetimeSeconds; epoch = $Epoch
    }
}

function Get-QStudyUpnpCollection {
    param([scriptblock]$CollectionFactory)
    if ($null -ne $CollectionFactory) { return ,(& $CollectionFactory) }
    $nat = New-Object -ComObject HNetCfg.NATUPnP -ErrorAction Stop
    return ,($nat.StaticPortMappingCollection)
}

function Find-QStudyUpnpPort {
    param([object]$Collection, [int]$Port)
    # Enumerate first: a failed Item lookup must never be interpreted as permission
    # to overwrite an existing mapping. Enumeration failure aborts the operation.
    foreach ($entry in $Collection) {
        if ([int]$entry.ExternalPort -eq $Port -and [string]$entry.Protocol -ieq 'TCP') { return $entry }
    }
    return $null
}

function Test-QStudyOwnedUpnpPort {
    param([object]$Mapping, [int]$Port, [string]$ClientIP, [string]$Description)
    if ($null -eq $Mapping) { return $false }
    return ([int]$Mapping.ExternalPort -eq $Port -and [string]$Mapping.Protocol -ieq 'TCP' -and
        [int]$Mapping.InternalPort -eq $Port -and [string]$Mapping.InternalClient -ceq $ClientIP -and
        [string]$Mapping.Description -ceq $Description -and [bool]$Mapping.Enabled)
}

function Get-QStudyUpnpPublicIP([object]$Mapping) {
    if ($null -eq $Mapping) { return '' }
    try { return [string]$Mapping.ExternalIPAddress } catch { return '' }
}

function Get-QStudyUpnpPort {
    param([string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description, [object]$PreviousRecord = $null, [scriptblock]$CollectionFactory)
    Assert-QStudyPortContext $Gateway $ClientIP $PublicIP $Port $Description
    try {
        $collection = Get-QStudyUpnpCollection $CollectionFactory
        if ($null -eq $collection) { return New-QStudyPortResult $false 'upnp' 'unsupported' 'UPnP is unavailable; use a manual TCP forwarding rule.' }
        $mapping = Find-QStudyUpnpPort $collection $Port
        if ($null -eq $mapping) { return New-QStudyPortResult $false 'upnp' 'absent' 'No TCP forwarding rule exists on this port.' }
        $routerIP = Get-QStudyUpnpPublicIP $mapping
        if (-not (Test-QStudyOwnedUpnpPort $mapping $Port $ClientIP $Description)) {
            return New-QStudyPortResult $false 'upnp' 'conflict' 'This TCP port belongs to another router rule; it was left unchanged.' $null $routerIP
        }
        if ($routerIP -and ((Get-QStudyIPv4Kind $routerIP) -ne 'public' -or $routerIP -cne $PublicIP)) {
            return New-QStudyPortResult $false 'upnp' 'wan_mismatch' 'The router WAN IPv4 does not match the configured public IPv4.' $null $routerIP
        }
        return New-QStudyPortResult $true 'upnp' 'owned' 'The existing TCP forwarding rule belongs to this installation.' $PreviousRecord $routerIP
    } catch { return New-QStudyPortResult $false 'upnp' 'unsupported' 'UPnP could not be inspected; use manual TCP forwarding.' }
}

function Enable-QStudyUpnpPort {
    param([string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description, [object]$PreviousRecord = $null, [scriptblock]$CollectionFactory)
    Assert-QStudyPortContext $Gateway $ClientIP $PublicIP $Port $Description
    if ($null -ne $PreviousRecord -and -not (Test-QStudyPortRecord $PreviousRecord 'upnp' $Gateway $ClientIP $PublicIP $Port $Description)) {
        return New-QStudyPortResult $false 'upnp' 'stale_record' 'The saved router/client identity changed; the old mapping was left unchanged.'
    }
    try {
        $collection = Get-QStudyUpnpCollection $CollectionFactory
        if ($null -eq $collection) { return New-QStudyPortResult $false 'upnp' 'unsupported' 'UPnP is unavailable; use manual TCP forwarding.' }
        $mapping = Find-QStudyUpnpPort $collection $Port
        if ($null -ne $mapping -and -not (Test-QStudyOwnedUpnpPort $mapping $Port $ClientIP $Description)) {
            return New-QStudyPortResult $false 'upnp' 'conflict' 'This TCP port belongs to another router rule; it was left unchanged.' $null (Get-QStudyUpnpPublicIP $mapping)
        }
        $created = $false
        if ($null -eq $mapping) {
            $null = $collection.Add($Port, 'TCP', $Port, $ClientIP, $true, $Description)
            $created = $true
            $mapping = Find-QStudyUpnpPort $collection $Port
        }
        if (-not (Test-QStudyOwnedUpnpPort $mapping $Port $ClientIP $Description)) {
            return New-QStudyPortResult $false 'upnp' 'conflict' 'The router did not retain this installation identity; no foreign rule was removed.'
        }
        $routerIP = Get-QStudyUpnpPublicIP $mapping
        if ($routerIP -and ((Get-QStudyIPv4Kind $routerIP) -ne 'public' -or $routerIP -cne $PublicIP)) {
            # Only undo a mapping created by this call, after re-checking its owner.
            if ($created -and (Test-QStudyOwnedUpnpPort (Find-QStudyUpnpPort $collection $Port) $Port $ClientIP $Description)) { $null = $collection.Remove($Port, 'TCP') }
            return New-QStudyPortResult $false 'upnp' 'wan_mismatch' 'The router WAN is private, CGNAT, or differs from the configured public IPv4.' $null $routerIP
        }
        $record = New-QStudyPortRecord 'upnp' $Gateway $ClientIP $PublicIP $Port $Description
        return New-QStudyPortResult $true 'upnp' 'enabled' 'The installation TCP forwarding rule is ready; external reachability still needs an external check.' $record $routerIP
    } catch { return New-QStudyPortResult $false 'upnp' 'unsupported' 'UPnP could not create or inspect the forwarding rule; use manual TCP forwarding.' }
}

function Disable-QStudyUpnpPort {
    param([string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description, [object]$PreviousRecord = $null, [scriptblock]$CollectionFactory)
    Assert-QStudyPortContext $Gateway $ClientIP $PublicIP $Port $Description
    if (-not (Test-QStudyPortRecord $PreviousRecord 'upnp' $Gateway $ClientIP $PublicIP $Port $Description)) {
        return New-QStudyPortResult $false 'upnp' 'stale_record' 'Deletion requires the original matching router/client ownership record.'
    }
    try {
        $collection = Get-QStudyUpnpCollection $CollectionFactory
        if ($null -eq $collection) { return New-QStudyPortResult $false 'upnp' 'unsupported' 'UPnP is unavailable; verify the original router rule manually.' }
        $mapping = Find-QStudyUpnpPort $collection $Port
        if ($null -eq $mapping) { return New-QStudyPortResult $true 'upnp' 'disabled' 'The original forwarding rule is already absent.' }
        if (-not (Test-QStudyOwnedUpnpPort $mapping $Port $ClientIP $Description)) {
            return New-QStudyPortResult $false 'upnp' 'conflict' 'The router rule now belongs to another application; it was left unchanged.'
        }
        $routerIP = Get-QStudyUpnpPublicIP $mapping
        if ($routerIP -and $routerIP -cne $PublicIP) { return New-QStudyPortResult $false 'upnp' 'wan_mismatch' 'The router identity changed; the mapping was left unchanged.' $null $routerIP }
        $null = $collection.Remove($Port, 'TCP')
        return New-QStudyPortResult $true 'upnp' 'disabled' 'Only the matching installation forwarding rule was removed.'
    } catch { return New-QStudyPortResult $false 'upnp' 'unsupported' 'UPnP deletion could not be completed; verify the original rule manually.' }
}

function Send-QStudyNatPmpRequest {
    param([string]$Gateway, [string]$ClientIP, [byte[]]$Request, [ValidateRange(100, 10000)][int]$TimeoutMs = 1200, [ValidateRange(1, 65535)][int]$GatewayPort = 5351)
    $gatewayAddress = [Net.IPAddress]::Parse($Gateway)
    $clientAddress = [Net.IPAddress]::Parse($ClientIP)
    if ($gatewayAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or $clientAddress.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { throw 'NAT-PMP supports IPv4 only.' }
    # Bind the recorded LAN address and connect UDP to reject packets from other
    # senders. No DNS resolution and no retries or unlimited receive waits.
    $socket = New-Object Net.Sockets.UdpClient ([Net.IPEndPoint]::new($clientAddress, 0))
    try {
        $socket.Client.ReceiveTimeout = $TimeoutMs
        $socket.Client.SendTimeout = $TimeoutMs
        $socket.Connect($gatewayAddress, $GatewayPort)
        $null = $socket.Send($Request, $Request.Length)
        $sender = [Net.IPEndPoint]::new([Net.IPAddress]::Any, 0)
        $response = $socket.Receive([ref]$sender)
        if (-not $sender.Address.Equals($gatewayAddress) -or $sender.Port -ne $GatewayPort) { throw 'Unexpected NAT-PMP sender.' }
        return ,$response
    } finally { $socket.Dispose() }
}

function Read-QStudyNetworkUInt {
    param([byte[]]$Bytes, [int]$Offset, [int]$Count)
    $value = [uint64]0
    for ($index = 0; $index -lt $Count; $index++) { $value = ($value -shl 8) -bor [uint64]$Bytes[$Offset + $index] }
    return $value
}

function New-QStudyNatPmpMapRequest {
    param([int]$InternalPort, [int]$ExternalPort, [uint32]$LifetimeSeconds)
    if ($InternalPort -lt 1 -or $InternalPort -gt 65535 -or $ExternalPort -lt 0 -or $ExternalPort -gt 65535) { throw 'Invalid NAT-PMP port; deleting all client mappings is forbidden.' }
    # RFC 6886 section 3.4: destruction is keyed by the bound source address,
    # protocol and nonzero internal port. Suggested external port MUST be zero.
    if ($LifetimeSeconds -eq 0) { $ExternalPort = 0 }
    $request = New-Object byte[] 12
    $request[1] = 2
    $request[4] = [byte](($InternalPort -shr 8) -band 255); $request[5] = [byte]($InternalPort -band 255)
    $request[6] = [byte](($ExternalPort -shr 8) -band 255); $request[7] = [byte]($ExternalPort -band 255)
    for ($index = 0; $index -lt 4; $index++) { $request[8 + $index] = [byte](($LifetimeSeconds -shr (24 - 8 * $index)) -band 255) }
    return ,$request
}

function Invoke-QStudyNatPmpExchange {
    param([string]$Gateway, [string]$ClientIP, [byte[]]$Request, [int]$TimeoutMs, [scriptblock]$Exchange)
    if ($null -ne $Exchange) { return ,([byte[]](& $Exchange $Gateway $ClientIP $Request $TimeoutMs)) }
    return ,(Send-QStudyNatPmpRequest -Gateway $Gateway -ClientIP $ClientIP -Request $Request -TimeoutMs $TimeoutMs)
}

function Get-QStudyNatPmpAddress {
    param([string]$Gateway, [string]$ClientIP, [int]$TimeoutMs, [scriptblock]$Exchange)
    $response = Invoke-QStudyNatPmpExchange $Gateway $ClientIP ([byte[]]@(0, 0)) $TimeoutMs $Exchange
    if ($response.Length -ne 12 -or $response[0] -ne 0 -or $response[1] -ne 128 -or (Read-QStudyNetworkUInt $response 2 2) -ne 0) { throw 'The router did not return a valid NAT-PMP public-address response.' }
    [pscustomobject]@{ public_ip = [string]::Join('.', [string[]]$response[8..11]); epoch = [uint32](Read-QStudyNetworkUInt $response 4 4) }
}

function Invoke-QStudyNatPmpMap {
    param([string]$Gateway, [string]$ClientIP, [int]$Port, [int]$ExternalPort, [uint32]$LifetimeSeconds, [int]$TimeoutMs, [scriptblock]$Exchange)
    $request = New-QStudyNatPmpMapRequest $Port $ExternalPort $LifetimeSeconds
    $response = Invoke-QStudyNatPmpExchange $Gateway $ClientIP $request $TimeoutMs $Exchange
    if ($response.Length -ne 16 -or $response[0] -ne 0 -or $response[1] -ne 130 -or (Read-QStudyNetworkUInt $response 2 2) -ne 0 -or
        (Read-QStudyNetworkUInt $response 8 2) -ne $Port) { throw 'The router did not return a matching successful TCP NAT-PMP response.' }
    [pscustomobject]@{
        epoch = [uint32](Read-QStudyNetworkUInt $response 4 4); external_port = [int](Read-QStudyNetworkUInt $response 10 2)
        lifetime_seconds = [uint32](Read-QStudyNetworkUInt $response 12 4)
    }
}

function Get-QStudyNatPmpPort {
    param([string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description, [object]$PreviousRecord = $null, [ValidateRange(100, 10000)][int]$TimeoutMs = 1200, [scriptblock]$Exchange)
    Assert-QStudyPortContext $Gateway $ClientIP $PublicIP $Port $Description
    try {
        $address = Get-QStudyNatPmpAddress $Gateway $ClientIP $TimeoutMs $Exchange
        if ((Get-QStudyIPv4Kind $address.public_ip) -ne 'public' -or $address.public_ip -cne $PublicIP) {
            return New-QStudyPortResult $false 'nat-pmp' 'wan_mismatch' 'The router WAN is private, CGNAT, or differs from the configured public IPv4.' $null $address.public_ip
        }
        # NAT-PMP has no read-only mapping inventory. A successful address probe
        # confirms router capability only, never ownership or Internet reachability.
        return New-QStudyPortResult $true 'nat-pmp' 'available' 'NAT-PMP is available; mapping and external reachability are not verified by this read-only probe.' $PreviousRecord $address.public_ip
    } catch { return New-QStudyPortResult $false 'nat-pmp' 'unsupported' 'The router did not answer a valid NAT-PMP public-address probe.' }
}

function Enable-QStudyNatPmpPort {
    param([string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description, [object]$PreviousRecord = $null, [ValidateRange(1800, 86400)][int]$LifetimeSeconds = 3600, [ValidateRange(100, 10000)][int]$TimeoutMs = 1200, [scriptblock]$Exchange)
    Assert-QStudyPortContext $Gateway $ClientIP $PublicIP $Port $Description
    if ($null -ne $PreviousRecord -and -not (Test-QStudyPortRecord $PreviousRecord 'nat-pmp' $Gateway $ClientIP $PublicIP $Port $Description)) {
        return New-QStudyPortResult $false 'nat-pmp' 'stale_record' 'The original router/client identity changed; no renewal was attempted.'
    }
    try {
        $address = Get-QStudyNatPmpAddress $Gateway $ClientIP $TimeoutMs $Exchange
        if ((Get-QStudyIPv4Kind $address.public_ip) -ne 'public' -or $address.public_ip -cne $PublicIP) {
            return New-QStudyPortResult $false 'nat-pmp' 'wan_mismatch' 'The router WAN is private, CGNAT, or differs from the configured public IPv4; no mapping request was sent.' $null $address.public_ip
        }
        # Expiration or router reboot permits reacquiring the same source-client /
        # internal-port key. A changed client, gateway, port or installation never does.
        $mapped = Invoke-QStudyNatPmpMap $Gateway $ClientIP $Port $Port $LifetimeSeconds $TimeoutMs $Exchange
        if ($mapped.external_port -lt 1 -or $mapped.lifetime_seconds -eq 0) { return New-QStudyPortResult $false 'nat-pmp' 'unsupported' 'The router did not grant a usable TCP mapping.' }
        if ($mapped.external_port -ne $Port -or $mapped.lifetime_seconds -lt 1800 -or $mapped.lifetime_seconds -gt 86400) {
            # This response matches our reserved source-client/internal-port key.
            # Destroy only that key. The requested external port may be held by
            # another client and is never the target of a deletion request.
            $rollback = $false
            try {
                $removed = Invoke-QStudyNatPmpMap $Gateway $ClientIP $Port $mapped.external_port 0 $TimeoutMs $Exchange
                $rollback = $removed.lifetime_seconds -eq 0 -and $removed.external_port -eq 0
            } catch { }
            $status = $(if ($mapped.external_port -ne $Port) { 'conflict' } else { 'unsupported' })
            $message = $(if ($rollback) { 'The router granted a different port or too short a lease; that newly granted mapping was removed.' } else { 'The router granted a different port or too short a lease; cleanup could not be confirmed and the temporary lease will expire.' })
            return New-QStudyPortResult $false 'nat-pmp' $status $message $null $address.public_ip
        }
        $record = New-QStudyPortRecord 'nat-pmp' $Gateway $ClientIP $PublicIP $Port $Description ([int]$mapped.lifetime_seconds) $mapped.epoch
        return New-QStudyPortResult $true 'nat-pmp' 'enabled' 'The TCP lease is ready and must be renewed; external reachability still needs an external check.' $record $address.public_ip
    } catch { return New-QStudyPortResult $false 'nat-pmp' 'unsupported' 'The router did not answer a valid bounded NAT-PMP TCP mapping request.' }
}

function Disable-QStudyNatPmpPort {
    param([string]$Gateway, [string]$ClientIP, [string]$PublicIP, [int]$Port, [string]$Description, [object]$PreviousRecord = $null, [ValidateRange(100, 10000)][int]$TimeoutMs = 1200, [scriptblock]$Exchange)
    Assert-QStudyPortContext $Gateway $ClientIP $PublicIP $Port $Description
    if (-not (Test-QStudyPortRecord $PreviousRecord 'nat-pmp' $Gateway $ClientIP $PublicIP $Port $Description)) {
        return New-QStudyPortResult $false 'nat-pmp' 'stale_record' 'Deletion requires the original matching router/client ownership record.'
    }
    if ([DateTimeOffset]::Parse([string](Get-QStudyRecordValue $PreviousRecord 'expires_utc')) -le [DateTimeOffset]::UtcNow) {
        return New-QStudyPortResult $false 'nat-pmp' 'stale_record' 'The recorded NAT-PMP lease expired; no possibly unrelated mapping was deleted.'
    }
    try {
        $address = Get-QStudyNatPmpAddress $Gateway $ClientIP $TimeoutMs $Exchange
        if ((Get-QStudyIPv4Kind $address.public_ip) -ne 'public' -or $address.public_ip -cne $PublicIP) {
            return New-QStudyPortResult $false 'nat-pmp' 'wan_mismatch' 'The router WAN changed; no deletion request was sent.' $null $address.public_ip
        }
        if ($address.epoch -lt [uint32](Get-QStudyRecordValue $PreviousRecord 'epoch')) {
            return New-QStudyPortResult $false 'nat-pmp' 'stale_record' 'The router restarted since the recorded lease; no deletion request was sent.'
        }
        $removed = Invoke-QStudyNatPmpMap $Gateway $ClientIP $Port $Port 0 $TimeoutMs $Exchange
        if ($removed.lifetime_seconds -ne 0 -or $removed.external_port -ne 0) { return New-QStudyPortResult $false 'nat-pmp' 'unsupported' 'The router did not confirm removal of the recorded lease.' }
        return New-QStudyPortResult $true 'nat-pmp' 'disabled' 'Only the recorded source-client TCP lease was removed.'
    } catch { return New-QStudyPortResult $false 'nat-pmp' 'unsupported' 'NAT-PMP deletion could not be confirmed; the lease will expire automatically.' }
}
