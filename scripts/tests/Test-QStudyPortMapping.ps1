# Pure fixtures: no COM, real router, Windows service, firewall, or scheduled task.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path (Split-Path -Parent $PSScriptRoot) 'production\QStudy.PortMapping.ps1')
$checks = 0
function Assert-Port([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw ('FAILED: ' + $Message) }
    $script:checks++
}
Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Threading;
public sealed class QStudyUpnpRule {
    public int ExternalPort; public string Protocol; public int InternalPort;
    public string InternalClient; public bool Enabled; public string Description;
    public string ExternalIPAddress;
}
public sealed class QStudyUpnpFixture : IEnumerable {
    public readonly List<QStudyUpnpRule> Items = new List<QStudyUpnpRule>();
    public int Adds; public int Removes;
    public string PublicIP = "8.8.8.8";
    public IEnumerator GetEnumerator() { return Items.GetEnumerator(); }
    public QStudyUpnpRule Add(int outside, string protocol, int inside, string client, bool enabled, string description) {
        foreach (QStudyUpnpRule r in Items) { if (r.ExternalPort == outside && r.Protocol == protocol) throw new InvalidOperationException("existing rule"); }
        QStudyUpnpRule rule = new QStudyUpnpRule();
        rule.ExternalPort=outside; rule.Protocol=protocol; rule.InternalPort=inside;
        rule.InternalClient=client; rule.Enabled=enabled; rule.Description=description; rule.ExternalIPAddress=PublicIP;
        Items.Add(rule); Adds++; return rule;
    }
    public void Remove(int port, string protocol) {
        int index = Items.FindIndex(r => r.ExternalPort == port && r.Protocol == protocol);
        if (index < 0) throw new InvalidOperationException("missing rule");
        Items.RemoveAt(index); Removes++;
    }
}
public sealed class QStudyNatFixture : IDisposable {
    private UdpClient server; private Thread worker; private volatile bool stop;
    public int Port; public string PublicIP="8.8.8.8"; public int ExternalPort=8080;
    public uint Epoch=900; public uint GrantedLifetime=3600;
    public byte Version=0; public bool Truncate=false; public bool WrongSender=false;
    public byte Result=0; public byte OpcodeOffset=0; public int InternalOffset=0;
    private readonly List<byte[]> requests = new List<byte[]>();
    public byte[][] Requests { get { lock(requests) { return requests.ToArray(); } } }
    public QStudyNatFixture() {
        server = new UdpClient(new IPEndPoint(IPAddress.Loopback,0));
        Port=((IPEndPoint)server.Client.LocalEndPoint).Port;
        worker=new Thread(Run); worker.IsBackground=true; worker.Start();
    }
    private static void Put(byte[] a, int start, uint value, int count) {
        for(int i=0;i<count;i++) a[start+i]=(byte)(value >> (8*(count-1-i)));
    }
    private void Run() {
        while(!stop) {
            try {
                IPEndPoint remote = new IPEndPoint(IPAddress.Any,0);
                byte[] req=server.Receive(ref remote); lock(requests) { requests.Add(req); }
                byte[] response = new byte[req[1]==0 ? 12 : 16]; response[0]=Version;
                response[1]=(byte)(req[1]+128+OpcodeOffset); response[3]=Result; Put(response,4,Epoch,4);
                if(req[1]==0) { Array.Copy(IPAddress.Parse(PublicIP).GetAddressBytes(),0,response,8,4); }
                else {
                    uint internalPort=(uint)(req[4]*256+req[5]+InternalOffset); Put(response,8,internalPort,2);
                    bool remove = req[8]==0 && req[9]==0 && req[10]==0 && req[11]==0;
                    Put(response,10,remove?0U:(uint)ExternalPort,2);
                    Put(response,12,remove?0U:GrantedLifetime,4);
                }
                if(Truncate) Array.Resize(ref response,response.Length-1);
                if(WrongSender) { using(UdpClient other=new UdpClient(new IPEndPoint(IPAddress.Loopback,0))) { other.Send(response,response.Length,remote); } }
                else server.Send(response,response.Length,remote);
            } catch(SocketException) { if(stop) return; }
              catch(ObjectDisposedException) { return; }
        }
    }
    public void Dispose() { stop=true; server.Close(); worker.Join(1000); }
}
'@
$context = @{ Gateway = '192.168.1.1'; ClientIP = '192.168.1.20'; PublicIP = '8.8.8.8'; Port = 8080; Description = 'QStudy-installation-fixture' }
$script:collection = [QStudyUpnpFixture]::new()
$factory = { ,$script:collection }
$missing = Get-QStudyUpnpPort @context -CollectionFactory $factory
Assert-Port ($missing.status -eq 'absent' -and $script:collection.Adds -eq 0 -and $script:collection.Removes -eq 0) 'UPnP inspection has no mutations'
$enabled = Enable-QStudyUpnpPort @context -CollectionFactory $factory
Assert-Port ($enabled.ok -and $enabled.record.method -eq 'upnp' -and $script:collection.Adds -eq 1) 'UPnP creates the exact selected TCP port'
Assert-Port ($script:collection.Items[0].InternalPort -eq 8080 -and $script:collection.Items[0].InternalClient -eq $context.ClientIP) 'UPnP forwards only to the selected local address and same port'
$roundTrip = $enabled.record | ConvertTo-Json | ConvertFrom-Json
$renewed = Enable-QStudyUpnpPort @context -PreviousRecord $roundTrip -CollectionFactory $factory
Assert-Port ($renewed.ok -and $script:collection.Adds -eq 1 -and $script:collection.Removes -eq 0) 'UPnP renewal recognizes ownership without replacing the rule'
Assert-Port ((Get-QStudyUpnpPort @context -CollectionFactory $factory).public_ip -eq '8.8.8.8') 'Read-only UPnP status includes observed WAN IPv4'
$withoutRecord = Disable-QStudyUpnpPort @context -CollectionFactory $factory
Assert-Port ($withoutRecord.status -eq 'stale_record' -and $script:collection.Removes -eq 0) 'UPnP deletion requires a persisted matching record'
$changed = $context.Clone(); $changed.ClientIP = '192.168.1.21'
Assert-Port ((Disable-QStudyUpnpPort @changed -PreviousRecord $roundTrip -CollectionFactory $factory).status -eq 'stale_record') 'A changed LAN address cannot delete the old UPnP mapping'
$changed = $context.Clone(); $changed.Gateway = '192.168.1.2'
Assert-Port ((Enable-QStudyUpnpPort @changed -PreviousRecord $roundTrip -CollectionFactory $factory).status -eq 'stale_record') 'A changed router cannot renew an old mapping'
foreach ($field in @('Description', 'InternalClient', 'InternalPort', 'Enabled')) {
    $rule = $script:collection.Items[0]; $previous = $rule.$field
    if ($field -eq 'Enabled') { $rule.$field = $false } elseif ($field -eq 'InternalPort') { $rule.$field = 9000 } else { $rule.$field = 'foreign' }
    Assert-Port ((Enable-QStudyUpnpPort @context -CollectionFactory $factory).status -eq 'conflict') ('Foreign UPnP ' + $field + ' cannot be overwritten')
    Assert-Port ((Disable-QStudyUpnpPort @context -PreviousRecord $roundTrip -CollectionFactory $factory).status -eq 'conflict' -and $script:collection.Removes -eq 0) ('Foreign UPnP ' + $field + ' cannot be removed')
    $rule.$field = $previous
}
Assert-Port ((Disable-QStudyUpnpPort @context -PreviousRecord $roundTrip -CollectionFactory $factory).ok -and $script:collection.Removes -eq 1) 'UPnP removes only the matching owned rule'
$script:collection.PublicIP = '100.70.1.2'
$blocked = Enable-QStudyUpnpPort @context -CollectionFactory $factory
Assert-Port ($blocked.status -eq 'wan_mismatch' -and $script:collection.Items.Count -eq 0 -and $script:collection.Removes -eq 2) 'UPnP undoes only its newly created mapping when WAN is CGNAT'
$script:collection.PublicIP = '1.1.1.1'
Assert-Port ((Enable-QStudyUpnpPort @context -CollectionFactory $factory).status -eq 'wan_mismatch' -and $script:collection.Items.Count -eq 0) 'UPnP mismatched public IPv4 is not reported ready'
Assert-Port ((Enable-QStudyUpnpPort @context -CollectionFactory { $null }).status -eq 'unsupported') 'Unsupported UPnP returns a manual-forwarding result'
Assert-Port ((Enable-QStudyUpnpPort @context -CollectionFactory { throw 'Fixture discovery failure' }).status -eq 'unsupported') 'Failed UPnP inventory does not authorize an Add operation'

function New-PortFixtureExchange([object]$Fixture) {
    $fixturePort = $Fixture.Port
    return { param($gateway, $client, $request, $timeout)
        Send-QStudyNatPmpRequest -Gateway '127.0.0.1' -ClientIP '127.0.0.1' -Request $request -TimeoutMs $timeout -GatewayPort $fixturePort
    }.GetNewClosure()
}
function Assert-NoMapPackets([object]$Fixture, [string]$Message) { Assert-Port (@($Fixture.Requests | Where-Object { $_[1] -eq 2 }).Count -eq 0) $Message }
$nat = [QStudyNatFixture]::new()
try {
    $exchange = New-PortFixtureExchange $nat
    $probe = Get-QStudyNatPmpPort @context -Exchange $exchange
    Assert-Port ($probe.ok -and $probe.status -eq 'available' -and $probe.public_ip -eq '8.8.8.8') 'Loopback UDP fixture confirms the public-address response'
    Assert-NoMapPackets $nat 'NAT-PMP status never creates a mapping'
    $enabledNat = Enable-QStudyNatPmpPort @context -Exchange $exchange
    Assert-Port ($enabledNat.ok -and $enabledNat.record.lifetime_seconds -eq 3600 -and $enabledNat.record.epoch -eq 900) 'NAT-PMP records the actual granted TTL and router epoch'
    $requests = $nat.Requests
    $map = $requests[$requests.Count - 1]
    Assert-Port ($map.Length -eq 12 -and $map[1] -eq 2 -and (Read-QStudyNetworkUInt $map 4 2) -eq 8080 -and (Read-QStudyNetworkUInt $map 6 2) -eq 8080 -and (Read-QStudyNetworkUInt $map 8 4) -eq 3600) 'NAT-PMP wire request selects TCP and equal internal/external ports'
    $natRecord = $enabledNat.record | ConvertTo-Json | ConvertFrom-Json
    Assert-Port ((Enable-QStudyNatPmpPort @context -PreviousRecord $natRecord -Exchange $exchange).ok) 'NAT-PMP renews a JSON-roundtripped matching record'
    $before = $nat.Requests.Count
    $changed = $context.Clone(); $changed.Port = 8081
    Assert-Port ((Enable-QStudyNatPmpPort @changed -PreviousRecord $natRecord -Exchange $exchange).status -eq 'stale_record' -and $nat.Requests.Count -eq $before) 'Renewal rejects changed ports before any router request'
    $changed = $context.Clone(); $changed.ClientIP = '192.168.1.21'
    Assert-Port ((Disable-QStudyNatPmpPort @changed -PreviousRecord $natRecord -Exchange $exchange).status -eq 'stale_record' -and $nat.Requests.Count -eq $before) 'Deletion rejects changed client identity before any router request'
    $nat.Epoch = 100
    Assert-Port ((Disable-QStudyNatPmpPort @context -PreviousRecord $natRecord -Exchange $exchange).status -eq 'stale_record') 'A rebooted router cannot receive deletion based on an old epoch'
    Assert-Port ((Enable-QStudyNatPmpPort @context -PreviousRecord $natRecord -Exchange $exchange).ok) 'Router reboot permits reacquiring this same client/port key'
    $expired = $natRecord | ConvertTo-Json | ConvertFrom-Json
    $expired.created_utc = [DateTimeOffset]::UtcNow.AddHours(-2).ToString('o'); $expired.expires_utc = [DateTimeOffset]::UtcNow.AddHours(-1).ToString('o')
    $before = $nat.Requests.Count
    Assert-Port ((Disable-QStudyNatPmpPort @context -PreviousRecord $expired -Exchange $exchange).status -eq 'stale_record' -and $nat.Requests.Count -eq $before) 'An expired lease is never used as evidence for deletion'
    Assert-Port ((Enable-QStudyNatPmpPort @context -PreviousRecord $expired -Exchange $exchange).ok) 'An expired matching record can restore the same mapping after host restart'
    $nat.Epoch = 901
    $removedNat = Disable-QStudyNatPmpPort @context -PreviousRecord $natRecord -Exchange $exchange
    $requests = $nat.Requests; $delete = $requests[$requests.Count - 1]
    Assert-Port ($removedNat.ok -and (Read-QStudyNetworkUInt $delete 4 2) -eq 8080 -and (Read-QStudyNetworkUInt $delete 6 2) -eq 0 -and (Read-QStudyNetworkUInt $delete 8 4) -eq 0) 'NAT-PMP deletion uses RFC 6886 nonzero internal port, external zero and TTL zero'
    $nat.ExternalPort = 9001
    $conflict = Enable-QStudyNatPmpPort @context -Exchange $exchange
    $requests = $nat.Requests; $rollback = $requests[$requests.Count - 1]
    Assert-Port ($conflict.status -eq 'conflict' -and (Read-QStudyNetworkUInt $rollback 4 2) -eq 8080 -and (Read-QStudyNetworkUInt $rollback 8 4) -eq 0) 'Alternate-port conflict cleans up only this source-client/internal-port allocation'
    $nat.ExternalPort = 8080; $nat.GrantedLifetime = 100
    Assert-Port ((Enable-QStudyNatPmpPort @context -Exchange $exchange).status -eq 'unsupported') 'Leases too short for the scheduled renewal are rolled back'
    $nat.GrantedLifetime = 3600; $nat.InternalOffset = 1
    $before = $nat.Requests.Count
    Assert-Port ((Enable-QStudyNatPmpPort @context -Exchange $exchange).status -eq 'unsupported') 'A mismatched internal-port response cannot prove ownership'
    Assert-Port ($nat.Requests.Count -eq $before + 2 -and (Read-QStudyNetworkUInt ($nat.Requests[$nat.Requests.Count - 1]) 8 4) -gt 0) 'A mismatched response is never followed by deletion of an unknown client-port key'
} finally { $nat.Dispose() }
foreach ($wan in @('100.70.1.2', '192.168.1.2', '203.0.113.4', '224.0.0.1', '1.1.1.1')) {
    $nat = [QStudyNatFixture]::new()
    try {
        $nat.PublicIP = $wan; $exchange = New-PortFixtureExchange $nat
        Assert-Port ((Enable-QStudyNatPmpPort @context -Exchange $exchange).status -eq 'wan_mismatch') ('NAT-PMP WAN is rejected before mutation: ' + $wan)
        Assert-NoMapPackets $nat 'Private, CGNAT, reserved and mismatched WAN sends no TCP mutation packet'
    } finally { $nat.Dispose() }
}
foreach ($invalidResponse in @('version', 'truncated', 'wrong_sender', 'opcode', 'error_result')) {
    $nat = [QStudyNatFixture]::new()
    try {
        if ($invalidResponse -eq 'version') { $nat.Version = 1 }
        if ($invalidResponse -eq 'truncated') { $nat.Truncate = $true }
        if ($invalidResponse -eq 'wrong_sender') { $nat.WrongSender = $true }
        if ($invalidResponse -eq 'opcode') { $nat.OpcodeOffset = 1 }
        if ($invalidResponse -eq 'error_result') { $nat.Result = 2 }
        $exchange = New-PortFixtureExchange $nat; $watch = [Diagnostics.Stopwatch]::StartNew()
        Assert-Port ((Enable-QStudyNatPmpPort @context -Exchange $exchange -TimeoutMs 200).status -eq 'unsupported') ('Malformed or unauthenticated UDP response is rejected: ' + $invalidResponse)
        Assert-Port ($watch.ElapsedMilliseconds -lt 5000) 'UDP receive completes within the bounded timeout'
        Assert-NoMapPackets $nat 'Invalid address responses never send a TCP mutation'
    } finally { $nat.Dispose() }
}
foreach ($recordField in @('method', 'gateway', 'client_ip', 'public_ip', 'description', 'port', 'created_utc', 'expires_utc', 'epoch', 'lifetime_seconds')) {
    $badRecord = $natRecord | ConvertTo-Json | ConvertFrom-Json
    $badRecord.$recordField = 'invalid'
    Assert-Port ((Disable-QStudyNatPmpPort @context -PreviousRecord $badRecord -Exchange { throw 'must not reach network' }).status -eq 'stale_record') ('Incomplete or tampered NAT-PMP record cannot delete a mapping: ' + $recordField)
}
foreach ($invalid in @(@{Port=0}, @{Port=65536}, @{PublicIP='100.64.0.1'}, @{PublicIP='127.1'}, @{Gateway='localhost'}, @{ClientIP='0.0.0.0'}, @{Description='unowned'}, @{Description='QStudy-shared/unsafe'})) {
    $case = $context.Clone(); foreach ($key in $invalid.Keys) { $case[$key] = $invalid[$key] }
    $caught = $false
    try { [void](Enable-QStudyNatPmpPort @case -Exchange { throw 'must not reach network' }) } catch { $caught = $true }
    Assert-Port $caught 'Invalid context fails before any router exchange'
}
$caught = $false; try { [void](New-QStudyNatPmpMapRequest 0 0 0) } catch { $caught = $true }
Assert-Port $caught 'Deleting all NAT-PMP mappings for a client is forbidden'
Write-Host ('Port mapping checks passed: ' + $checks)
