param(
    [ValidateSet('enable', 'manual', 'disable', 'status', 'renew')][string]$Action = 'status',
    [ValidatePattern('^S-1-[0-9-]+$')][string]$ExpectedUserSid,
    [switch]$RouterCleanupConfirmed,
    [switch]$NoPause
)
. (Join-Path $PSScriptRoot 'QStudy.PublicAccess.ps1')
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$code = 1
try {
    if ($RouterCleanupConfirmed -and $Action -ne 'disable') { throw 'QStudy: -RouterCleanupConfirmed is supported only with disable, after manual router cleanup.' }
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if ($ExpectedUserSid -and $ExpectedUserSid -cne $currentSid) {
        throw 'QStudy: use the same Windows administrator account before and after UAC. A different account cannot own this installation renewal task.'
    }
    if ($Action -in @('enable', 'manual', 'disable')) {
        # Validate the installation before UAC. No secret values are arguments.
        if ($Action -ne 'disable') { Get-QStudyPublicAccessConfiguration $root | Out-Null }
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try { $administrator = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
        finally { $identity.Dispose() }
        if (-not $administrator) {
            Write-Host 'QStudy needs Windows permission to change its single TCP firewall rule. Confirm the Windows UAC prompt.'
            $arguments = '-NoLogo -NoProfile -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Action ' + $Action + ' -ExpectedUserSid ' + $currentSid + ' -NoPause'
            if ($RouterCleanupConfirmed) { $arguments += ' -RouterCleanupConfirmed' }
            $process = Start-Process -FilePath (Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList $arguments -Wait -PassThru
            $code = $process.ExitCode
            # The elevated console is hidden; show the safe saved report here.
            $result = Invoke-QStudyPublicAccess $root 'status'
        } else { $result = Invoke-QStudyPublicAccess $root $Action -RouterCleanupConfirmed:$RouterCleanupConfirmed; $code = $result.code }
    } else { $result = Invoke-QStudyPublicAccess $root $Action; $code = $result.code }
    Write-Host ($result.report | ConvertTo-Json -Depth 10)
    if ($null -ne $result.report.PSObject.Properties['client_ip'] -and $result.report.client_ip) {
        Write-Host ('Router rule: TCP ' + $result.report.port + ' -> ' + $result.report.client_ip + ':' + $result.report.port)
    }
    if ($code -eq 2) { Write-Warning 'Automatic access/cleanup is incomplete. Check the saved status, reserve the LAN address and configure only this TCP port manually. The script cannot bypass CGNAT.' }
    if ($code -eq 1) { Write-Warning 'Elevated network setup failed. Use the same Windows administrator account, check permission and existing QStudy rule/task ownership, then retry. Saved status is not proof of completion.' }
    if ($code -eq 0 -and $Action -in @('enable', 'manual')) { Write-Host 'Start QStudy after preparing accounts/data. Then test http://IP:PORT from a phone with Wi-Fi disabled; external availability has not been proved.' }
} catch {
    $message = $_.Exception.Message
    if ($message.StartsWith('QStudy:')) { Write-Host $message -ForegroundColor Red }
    else { Write-Host ('QStudy: network setup failed (' + $_.Exception.GetType().Name + '). Check Windows permission and .local/public-access/state.json; credentials are hidden.') -ForegroundColor Red }
    $code = 1
}
if (-not $NoPause -and $Action -ne 'renew') { [void](Read-Host 'Press Enter to close') }
exit $code
