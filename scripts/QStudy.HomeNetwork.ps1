Set-StrictMode -Version Latest

function Get-QStudyIPv4Kind([string]$Value) {
    $address = $null
    if (-not [Net.IPAddress]::TryParse($Value, [ref]$address) -or
        $address.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork -or
        $address.ToString() -cne $Value) { return 'invalid' }
    $b = $address.GetAddressBytes()
    if ($b[0] -eq 10 -or ($b[0] -eq 172 -and $b[1] -ge 16 -and $b[1] -le 31) -or
        ($b[0] -eq 192 -and $b[1] -eq 168)) { return 'private' }
    if ($b[0] -eq 100 -and $b[1] -ge 64 -and $b[1] -le 127) { return 'cgnat' }
    if ($b[0] -eq 127) { return 'loopback' }
    if ($b[0] -eq 169 -and $b[1] -eq 254) { return 'link_local' }
    if ($b[0] -eq 0 -or $b[0] -ge 224 -or
        ($b[0] -eq 192 -and $b[1] -eq 0 -and ($b[2] -eq 2 -or ($b[2] -eq 0 -and $b[3] -notin @(9, 10)))) -or
        ($b[0] -eq 192 -and $b[1] -eq 88 -and $b[2] -eq 99) -or
        ($b[0] -eq 198 -and $b[1] -in @(18, 19)) -or
        ($b[0] -eq 198 -and $b[1] -eq 51 -and $b[2] -eq 100) -or
        ($b[0] -eq 203 -and $b[1] -eq 0 -and $b[2] -eq 113)) { return 'reserved' }
    return 'public'
}

function Get-QStudyWanAssessment([string]$RouterWanIPv4, [string]$ExternalIPv4) {
    if (-not $RouterWanIPv4) { return 'wan_unknown' }
    $kind = Get-QStudyIPv4Kind $RouterWanIPv4
    if ($kind -eq 'cgnat') { return 'cgnat' }
    if ($kind -eq 'private') { return 'private_wan' }
    if ($kind -ne 'public') { return 'invalid_wan' }
    if (-not $ExternalIPv4 -or (Get-QStudyIPv4Kind $ExternalIPv4) -ne 'public') { return 'public_wan_unconfirmed' }
    if ($RouterWanIPv4 -cne $ExternalIPv4) { return 'wan_mismatch' }
    return 'public_wan_matches'
}

function Get-QStudyDnsAssessment([string[]]$IPv4, [string[]]$IPv6, [string]$ExternalIPv4) {
    if (@($IPv4).Count -eq 0 -and @($IPv6).Count -eq 0) { return 'unresolved' }
    if (@($IPv4).Count -eq 0) { return 'ipv6_only_verify_connectivity' }
    foreach ($value in $IPv4) { if ((Get-QStudyIPv4Kind $value) -ne 'public') { return 'non_public_ipv4' } }
    if (-not $ExternalIPv4) { return 'external_ipv4_unknown' }
    if (@($IPv4 | Where-Object { $_ -ne $ExternalIPv4 }).Count -gt 0) { return 'ipv4_mismatch' }
    if (@($IPv6).Count -gt 0) { return 'ipv4_matches_verify_ipv6' }
    return 'ipv4_matches'
}

function ConvertTo-QStudyHomeDomain([string]$Value) {
    $value = ([Globalization.IdnMapping]::new()).GetAscii($Value.Trim().TrimEnd('.')).ToLowerInvariant()
    if ($value.Length -gt 253 -or $value -notmatch '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$' -or
        $value.Split('.')[-1] -match '^\d+$') { throw 'Укажите домен без https://, порта и пути.' }
    return $value
}

function Assert-QStudyHomePath([string]$Root, [string]$Relative) {
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
    $target = [IO.Path]::GetFullPath((Join-Path $rootFull $Relative))
    if (-not $target.StartsWith($rootFull + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Путь должен оставаться внутри папки проекта.'
    }
    $current = $rootFull
    foreach ($part in @('') + @($Relative -split '[\\/]')) {
        if ($part) { $current = Join-Path $current $part }
        if (Test-Path -LiteralPath $current) {
            if ((Get-Item -LiteralPath $current -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw 'Папки состояния не должны содержать ссылки или junction.'
            }
        }
    }
    return $target
}
