[CmdletBinding(DefaultParameterSetName = 'Recognize')]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'Recognize')][string]$ManifestPath,
    [Parameter(Mandatory = $true, ParameterSetName = 'Check')][switch]$CheckOnly
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$InformationPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$OutputEncoding = [Console]::OutputEncoding
$failure = 'unavailable'

try {
    [void][Reflection.Assembly]::Load('System.Runtime.WindowsRuntime, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapPixelFormat, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapAlphaMode, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrResult, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

    $failure = 'missing_russian_language'
    $russian = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | Where-Object { $_.LanguageTag -eq 'ru' -or $_.LanguageTag -like 'ru-*' } | Select-Object -First 1
    if ($null -eq $russian) { throw 'missing_russian_language' }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($russian)
    if ($null -eq $engine) { throw 'missing_russian_language' }
    if ($CheckOnly) {
        [Console]::WriteLine((@{ ok = $true; language = $russian.LanguageTag; reason = 'ready' } | ConvertTo-Json -Compress))
        exit 0
    }

    $request = [IO.File]::ReadAllText($ManifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    $failure = 'invalid_request'
    if ($request.format -ne 1 -or @($request.pages).Count -lt 1 -or @($request.pages).Count -gt 50) { throw 'invalid_request' }
    $script:budgetMs = [Math]::Min(480000, [Math]::Max(1000, [int]$request.timeout_seconds * 1000))
    $script:clock = [Diagnostics.Stopwatch]::StartNew()
    $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and
        $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    } | Select-Object -First 1
    if ($null -eq $script:asTask) { $failure = 'unavailable'; throw 'unavailable' }

    function Wait-WinRT($Operation, [Type]$ResultType) {
        $remaining = $script:budgetMs - $script:clock.ElapsedMilliseconds
        if ($remaining -le 0) { $script:failure = 'timeout'; throw 'timeout' }
        $task = $script:asTask.MakeGenericMethod(@($ResultType)).Invoke($null, @($Operation))
        if (-not $task.Wait([int][Math]::Min(60000, $remaining))) {
            $Operation.Cancel()
            $script:failure = 'timeout'
            throw 'timeout'
        }
        return $task.Result
    }

    $failure = 'recognition_failed'
    $directory = [IO.Path]::GetFullPath((Split-Path -Parent $ManifestPath)).TrimEnd('\') + '\'
    $recognized = [Collections.Generic.List[object]]::new()
    $seen = [Collections.Generic.HashSet[int]]::new()
    $characters = 0
    foreach ($page in $request.pages) {
        $path = [IO.Path]::GetFullPath([string]$page.path)
        if (-not $path.StartsWith($directory, [StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetExtension($path) -ne '.png' -or -not $seen.Add([int]$page.index)) {
            $failure = 'invalid_request'; throw 'invalid_request'
        }
        $stream = $null
        $bitmap = $null
        try {
            $file = Wait-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
            $stream = Wait-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Wait-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $bitmap = Wait-WinRT ($decoder.GetSoftwareBitmapAsync([Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8, [Windows.Graphics.Imaging.BitmapAlphaMode]::Ignore)) ([Windows.Graphics.Imaging.SoftwareBitmap])
            if ([Math]::Max($bitmap.PixelWidth, $bitmap.PixelHeight) -gt 3200 -or
                [Math]::Max($bitmap.PixelWidth, $bitmap.PixelHeight) -gt [Windows.Media.Ocr.OcrEngine]::MaxImageDimension) {
                $failure = 'invalid_request'; throw 'invalid_request'
            }
            $result = Wait-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
            $lines = @($result.Lines | ForEach-Object { [string]$_.Text })
            foreach ($line in $lines) { $characters += $line.Length + 1 }
            if ($characters -gt 200000) { $failure = 'text_limit'; throw 'text_limit' }
            $recognized.Add([PSCustomObject]@{ index = [int]$page.index; lines = @($lines) })
        } finally {
            if ($null -ne $bitmap) { $bitmap.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
        }
    }
    $response = [PSCustomObject]@{ ok = $true; language = $russian.LanguageTag; pages = @($recognized.ToArray()) }
    [Console]::WriteLine(($response | ConvertTo-Json -Depth 6 -Compress))
    exit 0
} catch {
    # Exception messages can contain private paths; only predefined codes leave
    # this process. Python captures the JSON and returns a safe public message.
    if ($CheckOnly) {
        [Console]::WriteLine((@{ ok = $false; language = ''; reason = $failure } | ConvertTo-Json -Compress))
        exit 0
    }
    [Console]::WriteLine((@{ ok = $false; error = $failure } | ConvertTo-Json -Compress))
    exit 1
}
