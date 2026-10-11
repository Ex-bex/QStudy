# Loaded by QStudy.Install.ps1. Detection never needs administrator privileges.
Set-StrictMode -Version Latest

function Get-QStudyOcrPowerShell {
    # Resolve the Windows installation through the OS, rather than PATH or an
    # environment variable supplied by an application launching the installer.
    $windows = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    if (-not $windows) { return $null }
    $binary = Join-Path $windows 'System32\WindowsPowerShell\v1.0\powershell.exe'
    if (-not [Environment]::Is64BitProcess -and [Environment]::Is64BitOperatingSystem) {
        $binary = Join-Path $windows 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
    }
    if (-not (Test-Path -LiteralPath $binary -PathType Leaf)) { return $null }
    return $binary
}

function New-QStudyOcrProbe([bool]$Available, [string]$Reason, [string]$Language = '') {
    return [PSCustomObject]@{ ok = $Available; language = $Language; reason = $Reason }
}

function Get-QStudyOcrProbe([string]$RootPath = '') {
    $root = Get-QStudyInstallRoot $RootPath
    $helper = Join-Path $root 'scripts\qstudy_ocr.ps1'
    if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) { return (New-QStudyOcrProbe $false 'helper_missing') }
    $binary = Get-QStudyOcrPowerShell
    if (-not $binary) { return (New-QStudyOcrProbe $false 'unavailable') }
    $process = [Diagnostics.Process]::new()
    try {
        $process.StartInfo.FileName = $binary
        $process.StartInfo.WorkingDirectory = [IO.Path]::GetDirectoryName($binary)
        $process.StartInfo.Arguments = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '" -CheckOnly'
        $process.StartInfo.UseShellExecute = $false
        $process.StartInfo.CreateNoWindow = $true
        $process.StartInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
        $process.StartInfo.RedirectStandardOutput = $true
        $process.StartInfo.RedirectStandardError = $true
        $process.StartInfo.StandardOutputEncoding = [Text.UTF8Encoding]::new($false)
        $process.StartInfo.StandardErrorEncoding = [Text.UTF8Encoding]::new($false)
        [void]$process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(20000)) {
            # This child only probes availability; it never runs DISM or OCR.
            $process.Kill()
            [void]$process.WaitForExit(5000)
            return (New-QStudyOcrProbe $false 'probe_timeout')
        }
        if ($process.ExitCode -ne 0 -or $output.Result.Length -gt 4096) { return (New-QStudyOcrProbe $false 'invalid_probe') }
        $result = $output.Result | ConvertFrom-Json
        if ($result.ok -isnot [bool] -or $result.reason -notin @('ready', 'missing_russian_language', 'unavailable')) {
            return (New-QStudyOcrProbe $false 'invalid_probe')
        }
        if ($result.ok -and ($result.reason -ne 'ready' -or $result.language -notmatch '^ru(?:-[A-Za-z0-9]+)*$')) {
            return (New-QStudyOcrProbe $false 'invalid_probe')
        }
        if (-not $result.ok -and $result.reason -eq 'ready') { return (New-QStudyOcrProbe $false 'invalid_probe') }
        return (New-QStudyOcrProbe $result.ok $result.reason ([string]$result.language))
    } catch {
        # Do not print child stderr or arbitrary exception messages.
        return (New-QStudyOcrProbe $false 'unavailable')
    } finally { $process.Dispose() }
}

function Get-QStudyOcrWarning([string]$Reason) {
    switch ($Reason) {
        'offline' { return 'Русский OCR Windows пока недоступен. Без интернета компонент установить нельзя; повторите Install-QStudy.cmd без -Offline.' }
        'elevation_cancelled' { return 'Установка русского OCR отменена в запросе UAC. Приложение работает; для PDF-сканов повторите Install-QStudy.cmd -ForceRepair и разрешите установку компонента Windows.' }
        'restart_required' { return 'Windows установила компонент OCR и сообщает о необходимости перезагрузки. Перезагрузите компьютер самостоятельно, затем запустите QStudy снова.' }
        'provision_pending' { return 'Установка OCR Windows ещё выполняется. Приложение работает; состояние OCR будет проверено при следующем запуске. Автоматической перезагрузки нет.' }
        'installation_in_progress' { return 'Другой процесс уже устанавливает OCR Windows. Приложение работает; повторите проверку позже.' }
        'helper_missing' { return 'В копии проекта отсутствует helper русского OCR. Приложение работает; скопируйте папку scripts полностью для распознавания PDF-сканов.' }
        'probe_timeout' { return 'Проверка OCR Windows превысила лимит ожидания. Приложение работает; повторите Install-QStudy.cmd -CheckOnly позже.' }
        default { return 'Русский OCR Windows пока недоступен. Приложение работает, но PDF-сканам нужен русский компонент OCR. Проверьте доступ к Windows Update и повторите Install-QStudy.cmd -ForceRepair.' }
    }
}

function Invoke-QStudyOcrProvision([string]$Root) {
    $helper = Join-Path $Root 'scripts\Install-QStudyOcrCapability.ps1'
    $binary = Get-QStudyOcrPowerShell
    if (-not $binary -or -not (Test-Path -LiteralPath $helper -PathType Leaf)) {
        return [PSCustomObject]@{ reason = 'helper_missing'; restartNeeded = $false }
    }
    $process = $null
    try {
        $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
        try {
            $principal = [Security.Principal.WindowsPrincipal]::new($identity)
            $isAdministrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
        } finally { $identity.Dispose() }
        Write-Host 'Установка русского OCR через Windows Update. Windows может запросить UAC; перезагрузка не выполняется.'
        $parameters = @{
            FilePath = $binary
            WorkingDirectory = [IO.Path]::GetDirectoryName($binary)
            ArgumentList = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $helper + '"')
            WindowStyle = 'Hidden'
            PassThru = $true
        }
        if (-not $isAdministrator) { $parameters.Verb = 'RunAs' }
        $process = Start-Process @parameters
        # Keep the process handle before exit so Windows PowerShell 5.1 retains
        # the exit status of a short-lived child returned by Start-Process.
        $processHandle = $process.Handle
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $nextUpdate = 30000
        while (-not $process.WaitForExit(1000)) {
            if ($timer.ElapsedMilliseconds -ge 900000) {
                # Servicing Windows must not be killed halfway through a package
                # operation. Return to QStudy, and allow Windows to finish safely.
                return [PSCustomObject]@{ reason = 'provision_pending'; restartNeeded = $false }
            }
            if ($timer.ElapsedMilliseconds -ge $nextUpdate) {
                Write-Host 'Windows продолжает подготовку русского OCR…'
                $nextUpdate += 30000
            }
        }
        return (ConvertFrom-QStudyOcrExitCode $process.ExitCode)
    } catch {
        $exception = $_.Exception
        while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
        $reason = if ($exception -is [ComponentModel.Win32Exception] -and $exception.NativeErrorCode -eq 1223) { 'elevation_cancelled' } else { 'installation_failed' }
        return [PSCustomObject]@{ reason = $reason; restartNeeded = $false }
    } finally {
        if ($null -ne $process) { $process.Dispose() }
    }
}

function ConvertFrom-QStudyOcrExitCode([int]$ExitCode) {
    $reason = switch ($ExitCode) {
        0 { 'installed' }
        10 { 'restart_required' }
        12 { 'installation_in_progress' }
        13 { 'not_administrator' }
        default { 'installation_failed' }
    }
    return [PSCustomObject]@{ reason = $reason; restartNeeded = ($ExitCode -in @(10, 14)) }
}

function Ensure-QStudyOcr([string]$RootPath = '', [switch]$Offline, [switch]$ForceRepair) {
    $root = Get-QStudyInstallRoot $RootPath
    $probe = Get-QStudyOcrProbe $root
    $statePath = Join-Path $root '.local\ocr-runtime.json'
    $previous = Read-QStudyInstallJson $statePath
    $now = [DateTime]::UtcNow
    $fingerprint = Get-QStudyInstallComputerFingerprint
    $sameMachine = (Get-QStudyInstallProperty $previous 'machineFingerprint' '') -eq $fingerprint
    $lastAttempt = if ($sameMachine) { Get-QStudyInstallProperty $previous 'lastAttemptUtc' '' } else { '' }
    $nextAttempt = if ($sameMachine) { Get-QStudyInstallProperty $previous 'nextAttemptUtc' '' } else { '' }
    $restart = -not $probe.ok -and $sameMachine -and [bool](Get-QStudyInstallProperty $previous 'restartNeeded' $false)
    $reason = $probe.reason
    if (-not $probe.ok) {
        if ($Offline) { $reason = if ($probe.reason -eq 'helper_missing') { 'helper_missing' } else { 'offline' } }
        elseif ($probe.reason -eq 'missing_russian_language') {
            $retryAt = [DateTime]::MinValue
            [void][DateTime]::TryParse([string]$nextAttempt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$retryAt)
            $pending = (Get-QStudyInstallProperty $previous 'reason' '') -eq 'provision_pending'
            $attemptAt = [DateTime]::MinValue
            [void][DateTime]::TryParse([string]$lastAttempt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind, [ref]$attemptAt)
            # Do not launch another elevated process immediately after a timeout,
            # including when Repair is used. The helper also holds a machine lock.
            if ($sameMachine -and $pending -and $attemptAt.AddMinutes(30) -gt $now) { $reason = 'provision_pending' }
            elseif (-not $ForceRepair -and $sameMachine -and $retryAt -gt $now) {
                $reason = Get-QStudyInstallProperty $previous 'reason' 'installation_failed'
            } else {
                $lastAttempt = $now.ToString('o')
                $nextAttempt = $now.AddHours(24).ToString('o')
                # Persist the retry guard before the UAC prompt. Closing an
                # installer must not result in a prompt on every app launch.
                Write-QStudyInstallJson $statePath ([PSCustomObject]@{
                    version = 1; machineFingerprint = $fingerprint; available = $false; language = ''
                    reason = 'provision_pending'; checkedAtUtc = $now.ToString('o')
                    lastAttemptUtc = $lastAttempt; nextAttemptUtc = $nextAttempt; restartNeeded = $false
                })
                $installation = Invoke-QStudyOcrProvision $root
                $restart = $installation.restartNeeded
                $probe = Get-QStudyOcrProbe $root
                $reason = if ($probe.ok) { 'ready' } else { $installation.reason }
                if ($reason -eq 'installed') { $reason = 'installation_failed' }
            }
        }
    }
    if ($probe.ok) { $reason = 'ready'; $nextAttempt = '' }
    $state = [PSCustomObject]@{
        version = 1; machineFingerprint = $fingerprint; available = [bool]$probe.ok
        language = if ($probe.ok) { $probe.language } else { '' }; reason = $reason
        checkedAtUtc = [DateTime]::UtcNow.ToString('o'); lastAttemptUtc = $lastAttempt
        nextAttemptUtc = $nextAttempt; restartNeeded = $restart
    }
    Write-QStudyInstallJson $statePath $state
    if ($state.available) {
        Write-Host ('Русский OCR Windows готов (' + $state.language + ').')
        if ($restart) { Write-Warning (Get-QStudyOcrWarning 'restart_required') }
    } else {
        Write-Warning (Get-QStudyOcrWarning $reason)
        if ($restart -and $reason -ne 'restart_required') {
            Write-Warning 'Windows также сообщает о необходимости перезагрузки после частичной установки языкового компонента. Русский OCR пока не подтверждён.'
        }
    }
    return $state
}
