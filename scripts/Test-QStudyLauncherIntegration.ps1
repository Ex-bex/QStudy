param()
. (Join-Path $PSScriptRoot 'QStudy.Common.ps1')
$actualRoot = $script:QStudyRoot
$actualState = Read-QStudyState
$originalBackend = if ($null -ne $actualState.backend) { $actualState.backend.identity } else { $null }
$originalFrontend = if ($null -ne $actualState.frontend) { $actualState.frontend.identity } else { $null }
$fixture = Join-Path $actualRoot ('.local\launcher-integration\Проект с пробелами ' + [Guid]::NewGuid().ToString('N'))
$fixtureScripts = Join-Path $fixture 'scripts'
$fakeNext = Join-Path $fixture 'frontend\node_modules\next\dist\bin'
[IO.Directory]::CreateDirectory($fixtureScripts) | Out-Null
[IO.Directory]::CreateDirectory($fakeNext) | Out-Null
[IO.Directory]::CreateDirectory((Join-Path $fixture 'backend')) | Out-Null
foreach ($name in @('QStudy.Common.ps1', 'QStudy.DetachedProcess.cs', 'Start-QStudy.ps1', 'Stop-QStudy.ps1')) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination (Join-Path $fixtureScripts $name)
}
$helper = @'
function Ensure-QStudyInstallation {
    param([switch]$Offline, [switch]$ForceRepair)
    return [PSCustomObject]@{ python = $env:QSTUDY_TEST_PYTHON; node = $env:QSTUDY_TEST_NODE }
}
'@
[IO.File]::WriteAllText((Join-Path $fixtureScripts 'QStudy.Install.ps1'), $helper, [Text.UTF8Encoding]::new($true))
$backend = @'
import argparse, json
from http.server import BaseHTTPRequestHandler, HTTPServer
parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int)
parser.add_argument('--qstudy-instance')
args = parser.parse_args()
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        body = json.dumps({'service':'QStudy'}).encode()
        self.send_response(200); self.end_headers(); self.wfile.write(body)
    def log_message(self, *args): pass
HTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
'@
[IO.File]::WriteAllText((Join-Path $fixtureScripts 'qstudy_backend.py'), $backend, [Text.UTF8Encoding]::new($false))
[IO.File]::WriteAllText((Join-Path $fixtureScripts 'qstudy_data.py'), 'print(''{"ok":true,"warnings":[]}'')', [Text.UTF8Encoding]::new($false))
$frontend = @'
const http=require('http'); const args=process.argv;
const port=Number(args[args.indexOf('--port')+1]); const host=args[args.indexOf('--hostname')+1];
if (!process.env.BACKEND_URL || !process.env.CORS_ORIGINS.includes(':'+port)) process.exit(4);
http.createServer((req,res)=>{res.writeHead(200);res.end('QStudy fixture');}).listen(port,host);
'@
[IO.File]::WriteAllText((Join-Path $fakeNext 'next'), $frontend, [Text.UTF8Encoding]::new($false))
$env:QSTUDY_TEST_PYTHON = Resolve-QStudyRuntime '' 'python'
$env:QSTUDY_TEST_NODE = Resolve-QStudyRuntime '' 'node'
$fixtureState = Join-Path $fixture '.local\processes.json'
$busyBackend = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$busyFrontend = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
try {
    $busyBackend.Start(); $busyFrontend.Start()
    $backendPort = [int]$busyBackend.LocalEndpoint.Port
    $frontendPort = [int]$busyFrontend.LocalEndpoint.Port
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixtureScripts 'Start-QStudy.ps1') -NoPause -NoBrowser -BackendPort $backendPort -FrontendPort $frontendPort -TimeoutSeconds 30
    if ($LASTEXITCODE -ne 0) { throw 'fixture launcher failed' }
    $first = [IO.File]::ReadAllText($fixtureState) | ConvertFrom-Json
    if ($first.backend.port -eq $backendPort -or $first.frontend.port -eq $frontendPort) { throw 'preferred busy port was used' }
    if (-not $busyBackend.Server.IsBound -or -not $busyFrontend.Server.IsBound) { throw 'foreign bound socket was changed' }
    if ((Invoke-WebRequest -Uri $first.browserUrl -UseBasicParsing).StatusCode -ne 200) { throw 'actual browser URL is unavailable' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixtureScripts 'Start-QStudy.ps1') -NoPause -NoBrowser -TimeoutSeconds 30
    if ($LASTEXITCODE -ne 0) { throw 'idempotent resume failed' }
    $second = [IO.File]::ReadAllText($fixtureState) | ConvertFrom-Json
    if ($second.backend.identity.instance -ne $first.backend.identity.instance -or $second.frontend.identity.instance -ne $first.frontend.identity.instance) { throw 'resume unnecessarily restarted services' }
    if ($second.browserUrl -ne $first.browserUrl) { throw 'resume changed actual URL' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixtureScripts 'Start-QStudy.ps1') -Lan -NoPause -NoBrowser -BackendPort $backendPort -FrontendPort $frontendPort -TimeoutSeconds 30
    if ($LASTEXITCODE -ne 0) { throw 'explicit LAN fixture launch failed' }
    $lanState = [IO.File]::ReadAllText($fixtureState) | ConvertFrom-Json
    if ($lanState.frontend.bind -ne '0.0.0.0' -or $lanState.backend.bind -ne '127.0.0.1' -or $lanState.mode -ne 'lan') { throw 'LAN exposes wrong service or bind' }
    if (-not $lanState.browserUrl -or $lanState.frontend.port -eq $frontendPort) { throw 'LAN URL or selected port invalid' }
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixtureScripts 'Stop-QStudy.ps1') -NoPause
    if ($LASTEXITCODE -ne 0) { throw 'fixture stop failed' }
    if ($null -ne (Get-QStudyOwnedProcess $lanState.backend.identity) -or $null -ne (Get-QStudyOwnedProcess $lanState.frontend.identity)) { throw 'fixture process remains running' }
    $latestActualState = Read-QStudyState
    if ($null -ne $originalBackend -and $null -ne $latestActualState.backend -and $latestActualState.backend.identity.instance -eq $originalBackend.instance -and $null -eq (Get-QStudyOwnedProcess $originalBackend)) { throw 'original backend was changed' }
    if ($null -ne $originalFrontend -and $null -ne $latestActualState.frontend -and $latestActualState.frontend.identity.instance -eq $originalFrontend.instance -and $null -eq (Get-QStudyOwnedProcess $originalFrontend)) { throw 'original frontend was changed' }
    if (-not $busyBackend.Server.IsBound -or -not $busyFrontend.Server.IsBound) { throw 'foreign listeners were stopped' }
    Write-Host 'PASS: isolated launch, two port collisions, environment wiring, Unicode/spaced paths, detached health, idempotent URL resume, explicit LAN/backend loopback, safe stop.'
} finally {
    $busyBackend.Stop(); $busyFrontend.Stop()
    if (Test-Path -LiteralPath $fixtureState) {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $fixtureScripts 'Stop-QStudy.ps1') -NoPause
    }
    Remove-Item Env:QSTUDY_TEST_PYTHON -ErrorAction SilentlyContinue
    Remove-Item Env:QSTUDY_TEST_NODE -ErrorAction SilentlyContinue
}
