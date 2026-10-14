# Safe address refresh for the Windows one-click Internet launcher.
# Dot-sourcing defines helpers only; it never discovers or changes networking.
. (Join-Path $PSScriptRoot 'QStudy.PublicAccess.ps1')

function Set-QStudyInternetAddress {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$PublicIP,
        [ValidateRange(1, 65535)][int]$Port = 8080)

    if ((Get-QStudyIPv4Kind $PublicIP) -cne 'public') {
        throw 'QStudy: Internet address must be a canonical public IPv4. No settings were changed.'
    }
    $path = Assert-QStudyHostPath $Root (Join-Path $Root 'deployment\.env')
    $local = Assert-QStudyHostPath $Root (Join-Path $Root '.local')
    [IO.Directory]::CreateDirectory($local) | Out-Null
    $lockPath = Assert-QStudyHostPath $Root (Join-Path $local 'internet-host.lock')
    $lock = $null; $temporary = $null; $values = $null
    try {
        try { $lock = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None) }
        catch [IO.IOException] { throw 'QStudy: another host operation is running. Wait until it finishes.' }
        $values = Read-QStudyHostEnvironment $Root
        if (-not $values.Count -or $values['QSTUDY_HOST_MODE'] -cne 'http' -or $values['ALLOW_PUBLIC_HTTP'] -cne 'true') {
            throw 'QStudy: initialize explicit HTTP IP:port first. HTTPS installations are never changed automatically.'
        }
        $oldIP = [string]$values['QSTUDY_PUBLIC_IP']; $rawPort = [string]$values['QSTUDY_HTTP_PORT']
        # Manual edits may leave these three fields inconsistent. Repair only
        # the address values; never expose arbitrary old field contents.
        $oldURL = ''
        if ((Get-QStudyIPv4Kind $oldIP) -ceq 'public' -and $rawPort -match '^[1-9][0-9]{0,4}$' -and [int]$rawPort -le 65535) {
            $candidateURL = 'http://' + $oldIP + ':' + $rawPort
            if ($values['PUBLIC_BASE_URL'] -ceq $candidateURL) { $oldURL = $candidateURL }
        }
        $newURL = 'http://' + $PublicIP + ':' + $Port
        $state = Read-QStudyPublicAccessState $Root (Get-QStudyPublicAccessSpec $Root)
        $changed = $oldIP -cne $PublicIP -or $rawPort -cne [string]$Port -or $values['PUBLIC_BASE_URL'] -cne $newURL
        if ($changed -and $null -ne $state -and ($state.enabled -or $state.method -cne 'none' -or $null -ne $state.record)) {
            throw 'QStudy: disable and clean up the old public-access mapping before changing its address or port.'
        }
        if (-not $changed) {
            return [PSCustomObject]@{ changed = $false; previous_public_url = $oldURL; public_url = $newURL; public_ip = $PublicIP; port = $Port }
        }
        # Decode strictly, retaining any UTF-8 BOM and every unrelated byte.
        $originalBytes = [IO.File]::ReadAllBytes($path)
        $bom = $originalBytes.Length -ge 3 -and $originalBytes[0] -eq 239 -and $originalBytes[1] -eq 187 -and $originalBytes[2] -eq 191
        $offset = if ($bom) { 3 } else { 0 }
        $utf8 = [Text.UTF8Encoding]::new($false, $true)
        $text = $utf8.GetString($originalBytes, $offset, $originalBytes.Length - $offset)
        $settings = @{ QSTUDY_PUBLIC_IP = $PublicIP; QSTUDY_HTTP_PORT = [string]$Port; PUBLIC_BASE_URL = $newURL }
        foreach ($key in @('QSTUDY_PUBLIC_IP', 'QSTUDY_HTTP_PORT', 'PUBLIC_BASE_URL')) {
            $pattern = '(?m)^([ \t]*' + [regex]::Escape($key) + '[ \t]*=[ \t]*'')[^''\r\n]*(''[ \t]*(?:#[^\r\n]*)?)(\r?)$'
            if ([regex]::Matches($text, $pattern).Count -ne 1) {
                throw 'QStudy: address settings require unique canonical keys. No settings were changed.'
            }
            $value = $settings[$key]
            $evaluator = [Text.RegularExpressions.MatchEvaluator]({ param($match)
                return $match.Groups[1].Value + $value + $match.Groups[2].Value + $match.Groups[3].Value
            }.GetNewClosure())
            $text = [regex]::Replace($text, $pattern, $evaluator)
        }
        Protect-QStudyHostStorage $Root
        $temporary = Assert-QStudyHostPath $Root (Join-Path $Root ('deployment\.env.internet-' + [Guid]::NewGuid().ToString('N') + '.tmp'))
        $stream = [IO.File]::Open($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            if ($bom) { $stream.Write([byte[]]@(239, 187, 191), 0, 3) }
            $bytes = $utf8.GetBytes($text)
            $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
        } finally { $stream.Dispose() }
        (Get-Item -LiteralPath $temporary -Force).SetAccessControl((New-QStudyPrivateAcl $false $temporary))
        # Windows preserves the replaced file's ACL; true null is needed on PS 5.1.
        [IO.File]::Replace($temporary, $path, [NullString]::Value)
        $temporary = $null
        return [PSCustomObject]@{ changed = $true; previous_public_url = $oldURL; public_url = $newURL; public_ip = $PublicIP; port = $Port }
    } catch {
        if ($_.Exception -is [Management.Automation.RuntimeException] -and $_.Exception.Message -match '^(QStudy:|Мастер|Некорректный)') { throw }
        throw 'QStudy: could not safely refresh the Internet address. Existing credentials are hidden; check private storage and file access.'
    } finally {
        if ($null -ne $values) { $values.Clear() }
        if ($temporary -and (Test-Path -LiteralPath $temporary)) { Remove-Item -LiteralPath $temporary -Force }
        if ($null -ne $lock) { $lock.Dispose() }
    }
}
