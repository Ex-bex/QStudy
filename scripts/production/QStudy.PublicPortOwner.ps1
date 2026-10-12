# Read-only ownership check before exposing an occupied Windows TCP port.
Set-StrictMode -Version Latest
if (-not (Get-Command Test-QStudyLocalDockerEndpoint -ErrorAction SilentlyContinue)) {
    . (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')
}

function ConvertTo-QStudyPublicPortArgument([string]$Argument) {
    # CommandLineToArgvW escaping; Process.Start never invokes a command shell.
    $escaped = [Regex]::Replace($Argument, '(\\*)"', '$1$1\"')
    $escaped = [Regex]::Replace($escaped, '(\\+)$', '$1$1')
    return '"' + $escaped + '"'
}

function Invoke-QStudyPublicPortDocker {
    param([string]$Executable, [string[]]$Arguments, [switch]$Pinned, [ValidateRange(100, 10000)][int]$TimeoutMs = 10000)
    $process = [Diagnostics.Process]::new()
    $timer = [Diagnostics.Stopwatch]::StartNew()
    try {
        $process.StartInfo = [Diagnostics.ProcessStartInfo]::new()
        $process.StartInfo.FileName = $Executable
        $process.StartInfo.Arguments = (@($Arguments | ForEach-Object { ConvertTo-QStudyPublicPortArgument $_ }) -join ' ')
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        if ($Pinned) {
            foreach ($key in @('DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH')) {
                $process.StartInfo.EnvironmentVariables.Remove($key)
            }
        }
        if (-not $process.Start()) { throw 'QStudy: Docker ownership inspection could not start.' }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutMs)) {
            try { $process.Kill(); [void]$process.WaitForExit(1000) } catch { }
            throw 'QStudy: Docker ownership inspection timed out. The occupied port was not exposed.'
        }
        $remaining = [Math]::Max(1, $TimeoutMs - [int]$timer.ElapsedMilliseconds)
        if (-not [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]@($stdout, $stderr), $remaining)) {
            throw 'QStudy: Docker ownership output timed out. The occupied port was not exposed.'
        }
        if ($process.ExitCode -ne 0) { throw 'QStudy: Docker ownership inspection failed. The occupied port was not exposed; private command output is hidden.' }
        $result = $stdout.GetAwaiter().GetResult()
        [void]$stderr.GetAwaiter().GetResult()
        if ($result.Length -gt 1048576) { throw 'QStudy: Docker ownership metadata exceeds its size limit.' }
        return $result
    } catch {
        if ($_.Exception.Message.StartsWith('QStudy:')) { throw }
        throw 'QStudy: Docker ownership inspection could not complete. No network access was changed.'
    } finally { $timer.Stop(); $process.Dispose() }
}

function Test-QStudyPublicPortBindings($Bindings, [int]$Port, $Listeners) {
    $matching = @($Bindings | Where-Object { $_.HostPort -ceq [string]$Port -and $_.HostIp -is [string] })
    if (-not $matching.Count) { return $false }
    foreach ($listener in $Listeners) {
        $address = $null
        if (-not [Net.IPAddress]::TryParse([string]$listener.LocalAddress, [ref]$address)) { return $false }
        $covered = $false
        foreach ($binding in $matching) {
            $bindAddress = $null
            if (-not [Net.IPAddress]::TryParse($binding.HostIp, [ref]$bindAddress)) { continue }
            if ($bindAddress.AddressFamily -ne $address.AddressFamily) { continue }
            if ($bindAddress.Equals($address) -or $bindAddress.Equals([Net.IPAddress]::Any) -or $bindAddress.Equals([Net.IPAddress]::IPv6Any)) { $covered = $true; break }
        }
        if (-not $covered) { return $false }
    }
    return $true
}

function Assert-QStudyPublicPortOwner {
    param([string]$Root, [ValidateRange(1, 65535)][int]$Port)
    try {
        # Query all listeners to avoid treating a missing LocalPort query as an
        # access/error exception; retain only this installation's selected port.
        $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -eq $Port })
    } catch { throw 'QStudy: Windows TCP listeners could not be checked. No network access was changed.' }
    if (-not $listeners.Count) { return }
    if ($env:DOCKER_HOST -and -not (Test-QStudyLocalDockerEndpoint $env:DOCKER_HOST)) {
        throw 'QStudy: remote Docker overrides cannot prove ownership of this Windows port.'
    }
    try { $docker = (Get-Command docker.exe -CommandType Application -ErrorAction Stop).Source }
    catch { throw 'QStudy: the selected TCP port is occupied and local Docker ownership could not be verified.' }
    $context = (Invoke-QStudyPublicPortDocker $docker @('context', 'show')).Trim()
    if (-not $context -or $context.Length -gt 256 -or $context -match '[\x00-\x1f]') { throw 'QStudy: the selected Docker context could not be verified.' }
    try {
        $endpoint = (Invoke-QStudyPublicPortDocker $docker @('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}', '--', $context)) | ConvertFrom-Json
    } catch { throw 'QStudy: local Docker context inspection failed. Private command output is hidden.' }
    if ($endpoint -isnot [string] -or -not (Test-QStudyLocalDockerEndpoint $endpoint)) { throw 'QStudy: remote Docker context cannot prove ownership of this Windows port.' }
    $endpoint = if ($env:DOCKER_HOST -and -not $env:DOCKER_CONTEXT) { $env:DOCKER_HOST } else { $endpoint }
    $prefix = @('--host', $endpoint)
    $engine = (Invoke-QStudyPublicPortDocker $docker ($prefix + @('info', '--format', '{{.OSType}}')) -Pinned).Trim()
    if ($engine -cne 'linux') { throw 'QStudy: local Docker Linux engine is required to verify the occupied TCP port.' }
    $idsText = Invoke-QStudyPublicPortDocker $docker ($prefix + @('ps', '--filter', 'label=com.docker.compose.project=qstudy', '--filter', 'label=com.docker.compose.service=caddy', '--filter', 'status=running', '--format', '{{.ID}}')) -Pinned
    $ids = @($idsText -split '[\r\n]+' | Where-Object { $_ })
    if ($ids.Count -gt 16 -or @($ids | Where-Object { $_ -notmatch '^[0-9a-f]{12,64}$' }).Count) { throw 'QStudy: Docker returned invalid port ownership metadata.' }
    $deployment = Assert-QStudyHostPath $Root (Join-Path $Root 'deployment')
    # Inspect exactly these harmless fields, never Config.Env or the full object.
    $format = '{"labels":{{json .Config.Labels}},"ports":{{json .NetworkSettings.Ports}},"running":{{json .State.Running}}}'
    foreach ($id in $ids) {
        try { $metadata = (Invoke-QStudyPublicPortDocker $docker ($prefix + @('inspect', '--format', $format, '--', $id)) -Pinned) | ConvertFrom-Json }
        catch { throw 'QStudy: Docker Caddy metadata could not be verified. Private command output is hidden.' }
        try {
            if ($metadata.running -isnot [bool] -or -not $metadata.running -or
                $metadata.labels.'com.docker.compose.project' -cne 'qstudy' -or
                $metadata.labels.'com.docker.compose.service' -cne 'caddy') { continue }
            $ownerPath = [IO.Path]::GetFullPath([string]$metadata.labels.'com.docker.compose.project.working_dir').TrimEnd('\', '/')
            if (-not [string]::Equals($ownerPath, $deployment.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) { continue }
            $bindingProperty = $metadata.ports.PSObject.Properties['80/tcp']
            if ($null -ne $bindingProperty -and (Test-QStudyPublicPortBindings $bindingProperty.Value $Port $listeners)) { return }
        } catch { throw 'QStudy: Docker returned incomplete port ownership metadata. No network access was changed.' }
    }
    throw 'QStudy: the selected TCP port belongs to an unverified application. Stop its owner or select another port before enabling public access.'
}
