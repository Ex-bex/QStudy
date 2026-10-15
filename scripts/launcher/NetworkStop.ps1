# Called by the private supervisor for an explicit stop or failed runtime.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
try {
    . (Join-Path $root 'scripts\launcher_network.ps1')
    Disable-QStudyNativeNetwork -Root $root
    exit 0
} catch { exit 1 }
