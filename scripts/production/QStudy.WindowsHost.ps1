# Windows PowerShell 5.1 compatible helpers; no application credentials are printed.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Assert-QStudyHostPath([string]$Root, [string]$Path) {
    $base = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $candidate = [IO.Path]::GetFullPath($Path)
    if ($candidate -ne $base -and -not $candidate.StartsWith($base + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Production storage must remain inside this project.'
    }
    $current = $candidate
    while ($current -and $current.Length -ge $base.Length) {
        if (Test-Path -LiteralPath $current) {
            if (((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'Production storage must not contain junctions or filesystem links.'
            }
        }
        if ([string]::Equals($current, $base, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = Split-Path -Parent $current
    }
    return $candidate
}

function New-QStudyPrivateAcl([bool]$Directory, [string]$Path) {
    # Start with the existing discretionary ACL. A new security descriptor can
    # make Set-Acl attempt to write the audit section and require SeSecurityPrivilege.
    $item = Get-Item -LiteralPath $Path -Force
    $acl = $item.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
    $acl.SetAccessRuleProtection($true, $false)
    foreach ($rule in @($acl.Access)) { $acl.RemoveAccessRuleSpecific($rule) }
    $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User
    $acl.SetOwner($owner)
    $inheritance = if ($Directory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($sid in @($owner, [Security.Principal.SecurityIdentifier]::new('S-1-5-18'), [Security.Principal.SecurityIdentifier]::new('S-1-5-32-544'))) {
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
        $acl.AddAccessRule($rule)
    }
    return $acl
}

function Protect-QStudyHostStorage([string]$Root) {
    $deployment = Assert-QStudyHostPath $Root (Join-Path $Root 'deployment')
    [IO.Directory]::CreateDirectory($deployment) | Out-Null
    $paths = [Collections.Generic.List[string]]::new()
    $paths.Add($deployment)
    $environment = Assert-QStudyHostPath $Root (Join-Path $deployment '.env')
    if (Test-Path -LiteralPath $environment) { $paths.Add($environment) }
    $data = Assert-QStudyHostPath $Root (Join-Path $deployment 'data')
    if (Test-Path -LiteralPath $data) {
        $queue = [Collections.Generic.Queue[string]]::new()
        $queue.Enqueue($data)
        while ($queue.Count) {
            $path = Assert-QStudyHostPath $Root $queue.Dequeue()
            $paths.Add($path)
            if (Test-Path -LiteralPath $path -PathType Container) {
                foreach ($child in @(Get-ChildItem -LiteralPath $path -Force)) { $queue.Enqueue($child.FullName) }
            }
        }
    }
    # Validate every target before changing ACLs. Never follow a link into another folder.
    foreach ($path in $paths) {
        $directory = Test-Path -LiteralPath $path -PathType Container
        # Set-Acl in Windows PowerShell can attempt to persist audit sections.
        # The .NET setter writes only the modified owner/discretionary sections.
        (Get-Item -LiteralPath $path -Force).SetAccessControl((New-QStudyPrivateAcl $directory $path))
    }
}

function Get-QStudyHostTaskName([string]$Root) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $key = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/').ToLowerInvariant() + ':' + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $digest = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($key)))).Replace('-', '').Substring(0, 12)
        return 'QStudy-Internet-' + $digest
    } finally { $sha.Dispose() }
}

function Get-QStudyHostTaskSpec([string]$Root) {
    $manager = Assert-QStudyHostPath $Root (Join-Path $Root 'scripts\production\Manage-QStudy.ps1')
    return [PSCustomObject]@{
        name = (Get-QStudyHostTaskName $Root)
        executable = (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe')
        arguments = '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $manager + '" resume -NoBrowser -Offline'
        description = 'QStudy Internet host: ' + [IO.Path]::GetFullPath($Root)
        userSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    }
}

function Test-QStudyHostTaskOwned($Task, $Spec) {
    if ($null -eq $Task -or $null -eq $Task.PSObject.Properties['Principal']) { return $false }
    try {
        $taskUser = [string]$Task.Principal.UserId
        $taskSid = if ($taskUser -match '^S-\d-') { [Security.Principal.SecurityIdentifier]::new($taskUser) } else { [Security.Principal.NTAccount]::new($taskUser).Translate([Security.Principal.SecurityIdentifier]) }
        if ($taskSid.Value -ne $Spec.userSid) { return $false }
    } catch { return $false }
    $actions = @($Task.Actions)
    return $Task.Description -eq $Spec.description -and $actions.Count -eq 1 -and
        [string]::Equals([string]$actions[0].Execute, $Spec.executable, [StringComparison]::OrdinalIgnoreCase) -and
        $actions[0].Arguments -eq $Spec.arguments
}

function Assert-QStudyBackupBasename([string]$Archive) {
    if (-not $Archive -or $Archive.StartsWith('-') -or $Archive -in @('.', '..') -or
        $Archive -match '[\\/:\x00-\x1f]' -or [IO.Path]::GetFileName($Archive) -ne $Archive) {
        throw 'Use a backup basename already present in deployment/data/backups.'
    }
}

function Test-QStudyLocalDockerEndpoint([string]$Endpoint) {
    # Standard Docker Desktop Windows endpoints use a named pipe on this
    # machine. TCP, SSH, Unix sockets, UNC hosts and encoded paths are refused.
    return [bool]($Endpoint -and $Endpoint -match '^npipe:/{2,4}\./pipe/[A-Za-z0-9][A-Za-z0-9_.-]*$')
}

function Initialize-QStudyPrivateBuildx([string]$Root) {
    $store = Assert-QStudyHostPath $Root (Join-Path $Root '.local\buildx')
    [IO.Directory]::CreateDirectory($store) | Out-Null
    $paths = [Collections.Generic.List[string]]::new()
    $queue = [Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($store)
    while ($queue.Count) {
        $path = Assert-QStudyHostPath $Root $queue.Dequeue()
        $paths.Add($path)
        if (Test-Path -LiteralPath $path -PathType Container) {
            foreach ($child in @(Get-ChildItem -LiteralPath $path -Force)) { $queue.Enqueue($child.FullName) }
        }
    }
    $defaultInstance = Assert-QStudyHostPath $Root (Join-Path $store 'instances\default')
    if (Test-Path -LiteralPath $defaultInstance) {
        # Buildx reads a saved node group before synthesizing the daemon-bound
        # default builder. Never trust an imported custom default instance.
        throw 'Custom default Buildx instances are forbidden in the private QStudy store. No builds were started; inspect .local/buildx privately.'
    }
    foreach ($path in $paths) {
        $directory = Test-Path -LiteralPath $path -PathType Container
        (Get-Item -LiteralPath $path -Force).SetAccessControl((New-QStudyPrivateAcl $directory $path))
    }
    return $store
}
