# Elevated entry point: no arguments, document access, output files or downloads.
# Only the two fixed Microsoft Russian language capabilities may be changed.
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# A parent application's module search path is untrusted at administrator level.
# Core cmdlets are built in; the only imported module is the fixed system DISM.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$PSModuleAutoLoadingPreference = 'None'
$reason = 'installation_failed'
$restartNeeded = $false
$mutex = $null
$acquired = $false
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            $reason = 'not_administrator'
            throw 'not_administrator'
        }
    } finally { $identity.Dispose() }
    $mutex = [Threading.Mutex]::new($false, 'Global\QStudyRussianOcrCapabilityInstall')
    try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
    if (-not $acquired) { $reason = 'installation_in_progress'; throw 'installation_in_progress' }
    $windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    # The system DISM module registers aliases with Utility's Set-Alias. Import
    # that dependency explicitly while user module autoload remains disabled.
    $utility = [IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
    Import-Module -Name $utility -Force -ErrorAction Stop
    $module = [IO.Path]::Combine($windows, 'System32\WindowsPowerShell\v1.0\Modules\Dism\Dism.psd1')
    Import-Module -Name $module -Force -ErrorAction Stop
    foreach ($name in @('Language.Basic~~~ru-RU~0.0.1.0', 'Language.OCR~~~ru-RU~0.0.1.0')) {
        $capability = Dism\Get-WindowsCapability -Online -Name $name -ErrorAction Stop
        if ($capability.State -eq 'Installed') { continue }
        # No Source/LimitAccess: Microsoft's servicing stack uses Windows Update.
        # Add-WindowsCapability has no NoRestart parameter and does not reboot.
        $installed = Dism\Add-WindowsCapability -Online -Name $name -ErrorAction Stop
        if ($installed.RestartNeeded) { $restartNeeded = $true }
        $capability = Dism\Get-WindowsCapability -Online -Name $name -ErrorAction Stop
        if ($capability.State -ne 'Installed' -and -not $installed.RestartNeeded) { throw 'installation_failed' }
    }
    $reason = if ($restartNeeded) { 'restart_required' } else { 'installed' }
} catch {
    # Never expose account details, servicing errors or local paths. The normal
    # installer receives only one of the fixed exit statuses below.
} finally {
    if ($acquired -and $null -ne $mutex) { $mutex.ReleaseMutex() }
    if ($null -ne $mutex) { $mutex.Dispose() }
}
switch ($reason) {
    'installed' { exit 0 }
    'restart_required' { exit 10 }
    'installation_in_progress' { exit 12 }
    'not_administrator' { exit 13 }
    default { if ($restartNeeded) { exit 14 }; exit 11 }
}
