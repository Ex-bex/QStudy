param(
    [ValidateSet('help', 'init', 'init-http', 'check', 'prepare', 'start', 'update', 'resume', 'stop', 'status', 'admin', 'mail-check', 'backup', 'verify', 'restore', 'install-autostart', 'remove-autostart')]
    [string]$Action = 'help',
    [string]$Domain = '',
    [string]$Email = '',
    [string]$PublicIP = '',
    [ValidateRange(1, 65535)][int]$Port = 8080,
    [string]$Name = '',
    [string]$Archive = '',
    [switch]$Offline,
    [switch]$NoBrowser,
    [switch]$NoPublish,
    [ValidateRange(10, 600)][int]$DockerWaitSeconds = 180
)
. (Join-Path $PSScriptRoot 'QStudy.WindowsHost.ps1')
$Action = $Action.ToLowerInvariant()
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$taskDeployment = Join-Path $taskRoot 'deployment'
$taskCompose = Join-Path $taskDeployment 'compose.yml'
$taskHostMode = 'https'
$taskPublicUrl = ''
$taskPublicPort = 443
$taskEnvironment = Join-Path $taskDeployment '.env'
$taskDocker = $null
$taskDockerEndpoint = ''
$taskBuildxConfig = ''
$taskPython = $null
$taskLock = $null
$taskSavedEnvironment = @{}
# Docker Compose gives the calling shell precedence over --env-file. Production
# settings must come from the validated deployment/.env, not stale local exports.
foreach ($key in @('QSTUDY_DOMAIN', 'ACME_EMAIL', 'PUBLIC_BASE_URL', 'SECRET_KEY', 'BFF_PROXY_SECRET', 'RECOVERY_DELIVERY', 'QSTUDY_HOST_MODE', 'QSTUDY_PUBLIC_IP', 'QSTUDY_HTTP_PORT', 'ALLOW_PUBLIC_HTTP')) {
    $taskSavedEnvironment[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
    [Environment]::SetEnvironmentVariable($key, $null, 'Process')
}

function Write-QStudyHostHelp {
    Write-Host @'
QStudy Internet host on Windows (Docker Desktop, Linux containers, Caddy HTTPS)
  Manage-QStudy-Internet.cmd init-http -PublicIP YOUR-PUBLIC-IP [-Port 8080]
  Manage-QStudy-Internet.cmd init -Domain YOUR-DOMAIN -Email YOUR-EMAIL
  Manage-QStudy-Internet.cmd check [-Offline]
  Manage-QStudy-Internet.cmd prepare
  Manage-QStudy-Internet.cmd start [-NoBrowser]
  Manage-QStudy-Internet.cmd update
  Manage-QStudy-Internet.cmd stop
  Manage-QStudy-Internet.cmd status
  Manage-QStudy-Internet.cmd admin -Email ACCOUNT-EMAIL [-Name DISPLAY-NAME]
  Manage-QStudy-Internet.cmd mail-check
  Manage-QStudy-Internet.cmd backup
  Manage-QStudy-Internet.cmd verify -Archive BACKUP-BASENAME
  Manage-QStudy-Internet.cmd restore -Archive BACKUP-BASENAME [-NoPublish]
  Manage-QStudy-Internet.cmd install-autostart
  Manage-QStudy-Internet.cmd remove-autostart
HTTP IP:port needs only that TCP port forwarded and allowed by the firewall.
HTTP has no domain/certificate and no transport encryption for passwords/data.
HTTPS domain mode remains available with init -Domain ... -Email ... .
Privately edit deployment/.env after init/init-http. Desktop installation/license,
public IP and router forwarding are one-time setup.
This manager never changes firewall rules, router settings or power settings.
Autostart runs at this user's sign-in; enable Docker Desktop sign-in startup.
Backend 8000 and frontend 3000 remain private container ports.
prepare builds images, validates Caddy and starts only private backend/frontend;
Internet is required for downloads, but public DNS and HTTPS are not tested.
It refuses preparation while this checkout's public Caddy service is running.
restore -NoPublish restores data and starts only private backend/frontend;
Caddy stays stopped. Run start after DNS, router and account setup are ready.
Read docs/home-hosting.md before publishing.
'@
}

function Get-QStudyHostPython {
    if ($script:taskPython) { return $script:taskPython }
    . (Join-Path $taskRoot 'scripts\QStudy.Install.ps1')
    $installLock = Enter-QStudyInstallLock $taskRoot
    try {
        # The existing installer downloads verified portable Python only. App
        # frameworks, Node.js and OCR are installed in the Linux Docker images.
        $runtime = Find-QStudyBasePython $taskRoot -Offline:$Offline
        $script:taskPython = [string]$runtime.path
        return $script:taskPython
    } finally { $installLock.Dispose() }
}

function Invoke-QStudyConfiguration([string[]]$Arguments) {
    $python = Get-QStudyHostPython
    if ($Arguments[0] -eq 'check') {
        $reportText = @(& $python -I (Join-Path $PSScriptRoot 'configure.py') @Arguments) -join ''
        if ($LASTEXITCODE -ne 0) { throw 'Production configuration check failed. See the safe message above; credentials were not printed.' }
        try { $report = $reportText | ConvertFrom-Json }
        catch { throw 'Production configuration returned an invalid report; private values were not printed.' }
        $modeProperty = $report.PSObject.Properties['host_mode']
        $mode = if ($null -eq $modeProperty) { 'https' } else { [string]$modeProperty.Value }
        if ($mode -notin @('https', 'http')) { throw 'Unsupported production host mode.' }
        $filename = if ($mode -eq 'http') { 'compose.http.yml' } else { 'compose.yml' }
        $composeProperty = $report.PSObject.Properties['compose_file']
        if ($null -ne $composeProperty -and $composeProperty.Value -cne $filename) { throw 'Production host mode and Compose file do not match.' }
        $script:taskCompose = Assert-QStudyHostPath $taskRoot (Join-Path $taskDeployment $filename)
        $script:taskHostMode = $mode
        $script:taskPublicUrl = [string]$report.public_url
        $portProperty = $report.PSObject.Properties['public_port']
        $script:taskPublicPort = if ($null -eq $portProperty) { 443 } else { [int]$portProperty.Value }
        Write-Host $reportText
        if ($mode -eq 'http') { Write-Warning 'HTTP IP:port mode is explicitly enabled: passwords, sessions and documents have no transport encryption.' }
    } else { & $python -I (Join-Path $PSScriptRoot 'configure.py') @Arguments }
    if ($LASTEXITCODE -ne 0) { throw 'Production configuration check failed. See the safe message above; credentials were not printed.' }
}

function Invoke-QStudyDocker([string[]]$Arguments, [switch]$Capture) {
    # Native stderr is not an exception in Windows PowerShell 5.1. Exit status
    # decides success. Do not invoke resolved `compose config` without --quiet.
    $oldPreference = $ErrorActionPreference
    $savedContext = [Environment]::GetEnvironmentVariable('DOCKER_CONTEXT', 'Process')
    $savedBuilder = [Environment]::GetEnvironmentVariable('BUILDX_BUILDER', 'Process')
    $savedBuildxConfig = [Environment]::GetEnvironmentVariable('BUILDX_CONFIG', 'Process')
    if ($script:taskDockerEndpoint) {
        # Pin the already verified local pipe for every call. A concurrent
        # `docker context use` must never redirect a later command to a server.
        $Arguments = @('--host', $script:taskDockerEndpoint) + $Arguments
        [Environment]::SetEnvironmentVariable('DOCKER_CONTEXT', $null, 'Process')
        # Compose subcommands can invoke Buildx internally. Keep those builds
        # on the daemon-bound default builder without changing user selections.
        [Environment]::SetEnvironmentVariable('BUILDX_BUILDER', 'default', 'Process')
        [Environment]::SetEnvironmentVariable('BUILDX_CONFIG', $script:taskBuildxConfig, 'Process')
    }
    $nativePreference = Get-Variable PSNativeCommandUseErrorActionPreference -ErrorAction SilentlyContinue
    if ($null -ne $nativePreference) { $PSNativeCommandUseErrorActionPreference = $false }
    try {
        $ErrorActionPreference = 'Continue'
        if ($Capture) { $result = @(& $script:taskDocker @Arguments 2>$null) }
        else { & $script:taskDocker @Arguments }
        $code = $LASTEXITCODE
    } finally {
        $ErrorActionPreference = $oldPreference
        [Environment]::SetEnvironmentVariable('DOCKER_CONTEXT', $savedContext, 'Process')
        [Environment]::SetEnvironmentVariable('BUILDX_BUILDER', $savedBuilder, 'Process')
        [Environment]::SetEnvironmentVariable('BUILDX_CONFIG', $savedBuildxConfig, 'Process')
    }
    if ($code -ne 0) { throw ('Docker command failed (exit ' + $code + '). Check Docker Desktop and the preceding message.') }
    if ($Capture) { return $result }
}

function Invoke-QStudyCompose([string[]]$Arguments, [switch]$Capture) {
    $command = @('compose', '--project-name', 'qstudy', '--project-directory', $taskDeployment, '--env-file', $taskEnvironment, '-f', $taskCompose) + $Arguments
    return Invoke-QStudyDocker $command -Capture:$Capture
}

function Assert-QStudyDockerReady([switch]$Wait) {
    $commands = @(Get-Command docker.exe -CommandType Application -ErrorAction SilentlyContinue)
    if (-not $commands.Count) {
        throw 'Install Docker Desktop from https://docs.docker.com/desktop/setup/install/windows-install/ . Open it, complete its setup, and select Linux containers before continuing.'
    }
    $script:taskDocker = $commands[0].Source
    if ($env:DOCKER_HOST -and -not (Test-QStudyLocalDockerEndpoint $env:DOCKER_HOST)) {
        throw 'Remote DOCKER_HOST is unsupported by the Windows home-host manager. Clear that override and select local Docker Desktop manually. Its address and credentials were not printed; no Docker resources were changed.'
    }
    $selectedContext = (@(Invoke-QStudyDocker @('context', 'show') -Capture) -join '').Trim()
    if (-not $selectedContext) { throw 'Cannot determine the selected Docker context. No Docker resources were changed.' }
    try {
        $endpointText = @(Invoke-QStudyDocker @('context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}', '--', $selectedContext) -Capture) -join ''
        $contextEndpoint = $endpointText | ConvertFrom-Json
    } catch {
        throw 'Cannot safely inspect the selected Docker context. Select local Docker Desktop manually; no Docker resources were changed.'
    }
    if ($contextEndpoint -isnot [string] -or -not (Test-QStudyLocalDockerEndpoint $contextEndpoint)) {
        throw 'The selected Docker context is not local Docker Desktop. Select its local Linux context manually. Its address and credentials were not printed; no Docker resources were changed.'
    }
    # DOCKER_CONTEXT overrides DOCKER_HOST. Without a context override, an
    # explicit local DOCKER_HOST remains the selected endpoint.
    $script:taskBuildxConfig = Initialize-QStudyPrivateBuildx $taskRoot
    $script:taskDockerEndpoint = if ($env:DOCKER_HOST -and -not $env:DOCKER_CONTEXT) { $env:DOCKER_HOST } else { $contextEndpoint }
    $deadline = [DateTime]::UtcNow.AddSeconds($DockerWaitSeconds)
    do {
        try {
            $engine = @(Invoke-QStudyDocker @('info', '--format', '{{.OSType}}') -Capture)
            $ready = ($engine -join '').Trim() -eq 'linux'
        } catch { $ready = $false }
        if ($ready) { break }
        if (-not $Wait -or [DateTime]::UtcNow -ge $deadline) {
            throw 'Docker Linux engine is unavailable. Open Docker Desktop, finish its first setup, select Linux containers, and retry. No services were changed.'
        }
        Start-Sleep -Seconds 3
    } while ($true)
    Invoke-QStudyDocker @('compose', 'version')
    Invoke-QStudyCompose @('config', '--quiet')
    # Compose's project name is shared on this Docker engine. A moved checkout
    # must not operate on a different QStudy checkout's containers.
    $containers = @(Invoke-QStudyDocker @('ps', '-a', '--filter', 'label=com.docker.compose.project=qstudy', '--format', '{{.ID}}') -Capture)
    foreach ($container in $containers) {
        $labelsText = @(Invoke-QStudyDocker @('inspect', '--format', '{{json .Config.Labels}}', [string]$container) -Capture) -join ''
        $labels = $labelsText | ConvertFrom-Json
        $property = $labels.PSObject.Properties['com.docker.compose.project.working_dir']
        if ($null -eq $property -or -not [string]::Equals([IO.Path]::GetFullPath([string]$property.Value).TrimEnd('\', '/'), $taskDeployment.TrimEnd('\', '/'), [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Another checkout owns Docker project qstudy. Stop/manage that checkout first; its containers and data were not changed.'
        }
    }
}

function Start-QStudyPublicProbe {
    for ($attempt = 1; $attempt -le 6; $attempt++) {
        try {
            Invoke-QStudyConfiguration @('probe')
            return $true
        } catch {
            if ($attempt -lt 6) { Write-Host 'Waiting for the configured public endpoint...'; Start-Sleep -Seconds 10 }
        }
    }
    Write-Warning ('PUBLIC_ENDPOINT_NOT_VERIFIED: healthy containers remain running. Check TCP forwarding/firewall for the configured port ' + $taskPublicPort + '. If the router has no NAT loopback, test ' + $taskPublicUrl + ' from a phone with Wi-Fi disabled. See docs/friend-hosting.md.')
    return $false
}

function Set-QStudyHostAutostart([bool]$Install) {
    $spec = Get-QStudyHostTaskSpec $taskRoot
    $existing = Get-ScheduledTask -TaskName $spec.name -TaskPath '\' -ErrorAction SilentlyContinue
    if ($null -ne $existing -and -not (Test-QStudyHostTaskOwned $existing $spec)) {
        throw 'An unrelated scheduled task uses this name. It was not replaced or removed.'
    }
    if (-not $Install) {
        if ($null -ne $existing) { Unregister-ScheduledTask -TaskName $spec.name -TaskPath '\' -Confirm:$false }
        Write-Host 'This checkout autostart was removed. Running containers were not stopped.'
        return
    }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $action = New-ScheduledTaskAction -Execute $spec.executable -Argument $spec.arguments -WorkingDirectory $taskRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
    $principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 2)
    Register-ScheduledTask -TaskName $spec.name -TaskPath '\' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $spec.description -Force | Out-Null
    Write-Host 'Autostart installed for this user at sign-in. Enable Docker Desktop > Settings > General > Start Docker Desktop when you sign in. Windows must remain awake; no pre-login start was configured.'
}

try {
    if ($NoPublish -and $Action -ne 'restore') { throw '-NoPublish is supported only with restore.' }
    if ($Action -eq 'help') { Write-QStudyHostHelp; exit 0 }
    if ($Domain -and $Action -ne 'init') { throw '-Domain is supported only with init. Edit both production domain settings explicitly for a later change.' }
    if ($PublicIP -and $Action -ne 'init-http') { throw '-PublicIP is supported only with init-http.' }
    if ($PSBoundParameters.ContainsKey('Port') -and $Action -ne 'init-http') { throw '-Port is supported only with init-http.' }
    if ($Email -and $Action -notin @('init', 'admin')) { throw '-Email is supported only with init or admin.' }
    if ($Name -and $Action -ne 'admin') { throw '-Name is supported only with admin.' }
    if ($Archive -and $Action -notin @('verify', 'restore')) { throw '-Archive is supported only with verify or restore.' }
    if ($Action -in @('verify', 'restore')) { Assert-QStudyBackupBasename $Archive }
    if ($Action -eq 'init' -and (-not $Domain -or -not $Email)) { throw 'Use init -Domain YOUR-DOMAIN -Email YOUR-EMAIL.' }
    if ($Action -eq 'init-http' -and (-not $PublicIP)) { throw 'Use init-http -PublicIP YOUR-PUBLIC-IP -Port 8080.' }
    if ($Action -eq 'admin' -and (-not $Email -or $Email.StartsWith('-'))) { throw 'Use admin -Email ACCOUNT-EMAIL.' }
    if ($Offline -and $Action -in @('start', 'update')) { throw 'start/update require live DNS checks. Use check -Offline to prepare configuration before DNS is ready.' }
    if ($Offline -and $Action -eq 'prepare') { throw 'prepare requires Internet access to download/build images. Public DNS is not required. Use check -Offline for configuration validation without downloads.' }
    $localDirectory = Assert-QStudyHostPath $taskRoot (Join-Path $taskRoot '.local')
    [IO.Directory]::CreateDirectory($localDirectory) | Out-Null
    $lockPath = Assert-QStudyHostPath $taskRoot (Join-Path $localDirectory 'internet-host.lock')
    try { $taskLock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
    catch [IO.IOException] { throw 'Another Internet-host operation is running. Wait for it to finish.' }
    switch ($Action) {
        'init' {
            Protect-QStudyHostStorage $taskRoot
            Invoke-QStudyConfiguration @('init', $Domain, $Email)
            Protect-QStudyHostStorage $taskRoot
            Write-Host 'Next: privately edit deployment/.env; configure public IP, DNS/DDNS and router TCP 80/443; then run check and start.'
        }
        'init-http' {
            Protect-QStudyHostStorage $taskRoot
            Invoke-QStudyConfiguration @('init-http', $PublicIP, [string]$Port)
            Protect-QStudyHostStorage $taskRoot
            Write-Host ('Next: prepare data/accounts privately, forward and allow TCP ' + $Port + ', then start. The address is http://' + $PublicIP + ':' + $Port + '; no domain or certificate is needed.')
        }
        { $_ -in @('install-autostart', 'remove-autostart') } {
            if ($Action -eq 'install-autostart') { Invoke-QStudyConfiguration @('check', '--offline') }
            Set-QStudyHostAutostart ($Action -eq 'install-autostart')
        }
        'check' {
            $options = @('check'); if ($Offline) { $options += '--offline' }
            Invoke-QStudyConfiguration $options
            Assert-QStudyDockerReady
            Write-Host ('Configuration and Linux Docker engine are ready: ' + $taskPublicUrl + '. A build and an external Internet test are still required.')
        }
        { $_ -in @('prepare', 'start', 'update', 'resume') } {
            Protect-QStudyHostStorage $taskRoot
            $options = @('check'); if ($Action -in @('prepare', 'resume')) { $options += '--offline' }
            Invoke-QStudyConfiguration $options
            Assert-QStudyDockerReady -Wait:($Action -eq 'resume')
            if ($Action -ne 'resume') {
                $running = @(Invoke-QStudyCompose @('ps', '--status', 'running', '--services') -Capture)
                if ($Action -eq 'prepare' -and $running -contains 'caddy') { throw 'prepare refused: this checkout Caddy service is already running. Manage the current public site explicitly first; no services were stopped or replaced.' }
                if ($Action -in @('prepare', 'update') -and $running -contains 'backend') { Invoke-QStudyCompose @('exec', '-T', 'backend', 'python', 'production_runtime.py', 'backup') }
                Invoke-QStudyCompose @('build', '--pull', '--builder', 'default')
                Invoke-QStudyCompose @('pull', 'caddy')
                Invoke-QStudyCompose @('run', '--rm', '--no-deps', '-T', 'caddy', 'caddy', 'validate', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile')
                Invoke-QStudyCompose @('up', '-d', '--no-build', '--wait', '--wait-timeout', '600', 'backend')
                Invoke-QStudyCompose @('exec', '-T', 'backend', 'python', 'production_runtime.py', 'mail-check-if-enabled')
            }
            $upArguments = @('up', '-d', '--no-build', '--wait', '--wait-timeout', '600')
            if ($Action -eq 'resume') { $upArguments += @('--pull', 'never') }
            if ($Action -eq 'prepare') { $upArguments += @('backend', 'frontend') }
            Invoke-QStudyCompose $upArguments
            if ($Action -eq 'prepare') { Write-Host 'Preparation complete: production backend/frontend are healthy on private container networks; SMTP was checked if enabled. Caddy was not started, no public ports were published, and public DNS/HTTPS were not tested. Configure accounts and DNS/router access, then run start to publish.' }
            elseif ($Action -eq 'resume') { Write-Host 'Existing production containers resumed. Public Internet availability was not tested at sign-in.' }
            else {
                if (-not (Start-QStudyPublicProbe)) { throw 'The public endpoint probe did not pass. Containers remain running for diagnosis; publication was not declared successful.' }
                if (-not $NoBrowser) {
                    Start-Process -FilePath $taskPublicUrl | Out-Null
                }
            }
        }
        default {
            Invoke-QStudyConfiguration @('check', '--offline')
            Assert-QStudyDockerReady
            switch ($Action) {
                'stop' { Invoke-QStudyCompose @('stop', 'caddy', 'frontend', 'backend') }
                'status' { Invoke-QStudyCompose @('ps') }
                'admin' {
                    $arguments = @('exec', 'backend', 'python', '-m', 'app.bootstrap_admin', $Email)
                    if ($Name) { $arguments += @('--name', $Name) }
                    Invoke-QStudyCompose $arguments
                }
                { $_ -in @('backup', 'verify', 'mail-check') } {
                    $arguments = @('exec', '-T', 'backend', 'python', 'production_runtime.py', $Action)
                    if ($Action -eq 'verify') { $arguments += $Archive }
                    Invoke-QStudyCompose $arguments
                }
                'restore' {
                    $running = @(Invoke-QStudyCompose @('ps', '--status', 'running', '--services') -Capture)
                    if ($running -contains 'backend') { Invoke-QStudyCompose @('exec', '-T', 'backend', 'python', 'production_runtime.py', 'verify', $Archive) }
                    Invoke-QStudyCompose @('stop', 'caddy', 'frontend', 'backend')
                    Protect-QStudyHostStorage $taskRoot
                    # Restore failure deliberately leaves every service stopped.
                    Invoke-QStudyCompose @('run', '--rm', '--no-deps', '-T', 'backend', 'python', 'production_runtime.py', 'restore', $Archive, '--stopped')
                    if ($NoPublish) {
                        Invoke-QStudyCompose @('up', '-d', '--no-build', '--wait', '--wait-timeout', '600', 'backend', 'frontend')
                        Write-Host 'Data restored: backend/frontend are healthy on private container networks. Caddy remains stopped; public HTTPS was not tested. Configure accounts and DNS/router access, then run start to publish.'
                    } else {
                        Invoke-QStudyCompose @('up', '-d', '--no-build', '--wait', '--wait-timeout', '600')
                        if (-not (Start-QStudyPublicProbe)) { throw 'Data restored, but public HTTPS is not verified. Containers remain running; test from an external network.' }
                    }
                }
            }
        }
    }
} catch {
    Write-Host ('QStudy Internet host: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
} finally {
    if ($null -ne $taskLock) { $taskLock.Dispose() }
    foreach ($key in $taskSavedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($key, $taskSavedEnvironment[$key], 'Process') }
}
exit 0
