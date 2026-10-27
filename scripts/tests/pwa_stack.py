"""Opt-in PWA HTTP verification through the real production frontend.

Uses disposable loopback listeners and a minimal public branding fixture only.
No project database, private credentials, user accounts or public host is used.
Run with backend/.venv/Scripts/python.exe scripts/tests/pwa_stack.py --run
after building the frontend. Browser install confirmation still requires a device.
"""
import argparse
from contextlib import ExitStack
import hashlib
from html.parser import HTMLParser
import io
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
import tempfile

from lumaball_stack import ROOT, StackFailure, base_environment, free_port, require, stop_child, wait_healthy

APPS = ('qforce', 'qstudy', 'qball', 'qcareer', 'qtests', 'qmessage', 'qcontrol', 'qid')
FIXTURE = '''from fastapi import FastAPI, Request
from fastapi.responses import Response
from pathlib import Path

app = FastAPI()
custom = False
@app.get('/api/health')
def health(): return {'status':'ok','service':'QStudy'}
@app.get('/api/branding/ecosystem')
def ecosystem(request:Request):
    if request.headers.get('authorization') or request.headers.get('cookie'):
        return {'force_logo_url':'SESSION_WAS_FORWARDED'}
    force_url = '/api/branding/assets/qforce/'+'a'*64+'.png' if custom == 'force' else '/api/branding/assets/project/'+'a'*64+'.png' if custom == 'wrongbrand' else '/brand/qforce_logo_main.png'
    return {'force_logo_url':force_url,
            'identity_logo_url':'/brand/qforcelogo_q-id.png', 'control_logo_url':'/brand/qforcelogo_qcontrol.png'}
@app.get('/api/branding')
def branding(): return {'project_logo_url':'/brand/qforce_logo_main.png'}
@app.get('/api/branding/{project}')
def project(project:str):
    return {'logo_url':{'career':'/brand/qforcelogo_qcareer.png','message':'/brand/qmessage-prototype.svg','tests':'/brand/qtests-prototype.svg'}.get(project,'/brand/qforce_logo_main.png')}
@app.get('/api/lumaball/config')
def ball(): return {'logo_url':'/brand/qforcelogo_lumaball.png'}
@app.get('/api/branding/assets/qforce/{name}')
@app.get('/api/branding/assets/project/{name}')
def force(name:str, request:Request):
    if request.headers.get('authorization') or request.headers.get('cookie'):
        return Response(status_code=403)
    if name != 'a'*64+'.png': return Response(status_code=404)
    return Response(Path('custom.png').read_bytes(), media_type='image/png')
@app.get('/api/private-fixture')
def private(): return {'private':'NEVER_CACHE_PRIVATE_FIXTURE'}
@app.post('/fixture/custom/{mode}')
def toggle(mode:str):
    global custom
    custom = mode
    return {'ok':True}
'''


def assert_icon(response, size):
    from PIL import Image
    require(response.status_code == 200, f'Icon {size} returned HTTP {response.status_code}')
    require(response.headers.get('content-type', '').split(';')[0] == 'image/png', 'Icon must be PNG')
    require(response.content.startswith(b'\x89PNG\r\n\x1a\n'), 'Icon is not PNG bytes')
    with Image.open(io.BytesIO(response.content)) as image:
        require(image.size == (size, size), f'Icon must be {size} square')
        image.load()
    require('no-store' in response.headers.get('cache-control', ''), 'Brand-aware icon is stale-cacheable')


class ManifestLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.paths = []

    def handle_starttag(self, tag, attrs):
        values = dict(attrs)
        if tag == 'link' and 'manifest' in values.get('rel', '').split():
            self.paths.append(values.get('href'))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    if not parser.parse_args().run:
        print('SKIP: opt in with --run after building frontend.'); return 0
    import httpx
    stage = 'setup'
    try:
        require((ROOT/'frontend/.next/BUILD_ID').is_file(), 'Build frontend first')
        require(not any((ROOT/'frontend'/name).exists() for name in ('.env','.env.local','.env.production','.env.production.local')), 'Private frontend dotenv is unsupported by isolated tests')
        with tempfile.TemporaryDirectory(prefix='qforce-pwa-stack-') as temporary, ExitStack() as stack:
            folder = Path(temporary)
            (folder/'pwa_fixture.py').write_text(FIXTURE, encoding='utf-8')
            from PIL import Image
            Image.new('RGBA', (64,64), (239,17,59,255)).save(folder/'custom.png', format='PNG')
            api_port = free_port(); site_port = free_port((api_port,))
            api_url = f'http://127.0.0.1:{api_port}'; site_url = f'http://127.0.0.1:{site_port}'
            environment = base_environment()
            environment.update({'SECRET_KEY':secrets.token_hex(32), 'BFF_PROXY_SECRET':secrets.token_hex(32),
                'DATABASE_URL':'sqlite:///'+(folder/'unused.sqlite3').as_posix(), 'UPLOAD_DIR':str(folder/'uploads'),
                'BACKUP_DIR':str(folder/'backups'), 'BACKUPS_ENABLED':'false', 'RATE_LIMIT_ENABLED':'false',
                'PUBLIC_BASE_URL':site_url, 'CORS_ORIGINS':site_url, 'ALLOW_PUBLIC_HTTP':'false',
                'RECOVERY_DELIVERY':'disabled', 'GEMINI_API_KEY':'', 'SMTP_HOST':'', 'SMTP_PASSWORD':'',
                'PYTHONUTF8':'1', 'NODE_ENV':'production', 'NEXT_TELEMETRY_DISABLED':'1',
                'TRUST_PROXY_HEADERS':'true', 'QSTUDY_ACCESS_MODE':'local', 'BACKEND_URL':api_url})
            api_log = stack.enter_context((folder/'api.log').open('wb'))
            site_log = stack.enter_context((folder/'site.log').open('wb'))
            api = site = None
            try:
                stage = 'startup'
                api = subprocess.Popen([sys.executable,'-m','uvicorn','pwa_fixture:app','--host','127.0.0.1','--port',str(api_port),'--no-access-log','--log-level','error'], cwd=folder, env=environment, stdin=subprocess.DEVNULL, stdout=api_log, stderr=subprocess.STDOUT)
                wait_healthy(api_url+'/api/health', api, log_path=folder/'api.log')
                site = subprocess.Popen([shutil.which('node'),str(ROOT/'frontend/server.mjs'),'--hostname','127.0.0.1','--port',str(site_port)], cwd=ROOT/'frontend', env=environment, stdin=subprocess.DEVNULL, stdout=site_log, stderr=subprocess.STDOUT)
                wait_healthy(site_url+'/api/health', site, log_path=folder/'site.log')
                client = stack.enter_context(httpx.Client(base_url=site_url, trust_env=False, timeout=30))
                manifests = {}
                stage = 'eight independent install manifests and PNG icons'
                for app in APPS:
                    response = client.get(f'/apps/{app}/manifest.webmanifest')
                    require(response.status_code == 200, f'{app} manifest unavailable')
                    require(response.headers.get('content-type','').split(';')[0] == 'application/manifest+json', 'Wrong manifest MIME')
                    require('no-store' in response.headers.get('cache-control',''), 'Manifest is stale-cacheable')
                    require('set-cookie' not in response.headers, 'Public manifest unexpectedly changed authentication')
                    manifest = response.json(); manifests[app] = manifest
                    require(manifest['name'] and manifest['short_name'] and manifest['display'] == 'standalone', 'Standalone identity missing')
                    require(manifest['id'].startswith('/') and manifest['id'] != '/', 'Explicit independent identity missing')
                    require(manifest['start_url'].startswith(manifest['scope']), 'Launch is outside application scope')
                    require(not manifest.get('prefer_related_applications'), 'Manifest prioritizes a native application')
                    icons = manifest['icons']
                    require({'192x192','512x512'} <= {item['sizes'] for item in icons}, 'Chromium installation icon sizes absent')
                    require(any('maskable' in item.get('purpose','') for item in icons), 'Android maskable icon absent')
                    for item in icons:
                        require(item['src'].startswith(f'/apps/{app}/'), 'Icon identity points outside its project')
                        assert_icon(client.get(item['src']), int(item['sizes'].split('x')[0]))
                    assert_icon(client.get(f'/apps/{app}/icon/180.png'),180)
                require(len({item['id'] for item in manifests.values()}) == len(APPS), 'Projects share an install identity')
                require(manifests['qstudy']['scope'] == '/dashboard', 'QStudy scope excludes the overview')
                require(manifests['qmessage']['start_url'].split('?')[0] == '/qmessage/chats', 'QMessage does not launch conversations')
                catalog = client.get('/apps')
                require(catalog.status_code == 200 and all(item['name'] in catalog.text for item in manifests.values()), 'Public install catalog does not list every project')
                stage = 'initial HTML advertises the matching application'
                for path, app in (('/', 'qforce'), ('/qstudy', 'qstudy'), ('/dashboard','qstudy'),
                    ('/qball','qball'), ('/qcareer','qcareer'), ('/qtests','qtests'), ('/qmessage','qmessage'),
                    ('/login','qid'), ('/login?next=%2Fqcontrol','qcontrol')):
                    page = client.get(path)
                    require(page.status_code == 200, 'Application page unavailable: '+path)
                    parser = ManifestLinks(); parser.feed(page.text)
                    require(parser.paths == [f'/apps/{app}/manifest.webmanifest'], 'Initial HTML has no unique correct manifest: '+path)
                stage = 'strict app and image size routes'
                for path in ('/apps/unknown/manifest.webmanifest','/apps/unknown/icon/192.png','/apps/qstudy/icon/0.png','/apps/qstudy/icon/8192.png','/apps/qstudy/icon/192.jpg'):
                    require(client.get(path).status_code == 404, 'Unexpected application or size accepted: '+path)
                stage = 'worker headers and generic offline response'
                worker = client.get('/sw.js'); require(worker.status_code == 200, 'Service worker missing')
                require('javascript' in worker.headers.get('content-type',''), 'Worker MIME is not JavaScript')
                cache = worker.headers.get('cache-control','')
                require('no-store' in cache or 'no-cache' in cache or 'max-age=0' in cache, 'Service worker cannot update promptly')
                offline = client.get('/offline.html'); require(offline.status_code == 200 and 'text/html' in offline.headers.get('content-type',''), 'Offline document missing')
                require('NEVER_CACHE_PRIVATE_FIXTURE' not in offline.text and '<script' not in offline.text, 'Offline page contains user data or executable scripts')
                private = client.get('/api/private-fixture')
                require(private.status_code == 200 and 'no-store' in private.headers.get('cache-control',''), 'Same-origin API is cacheable')
                stage = 'updated administrator branding reaches install icon'
                before = client.get('/apps/qforce/icon/512.png'); assert_icon(before,512)
                toggle = stack.enter_context(httpx.Client(base_url=api_url, trust_env=False, timeout=5))
                require(toggle.post('/fixture/custom/force').status_code == 200, 'Fixture logo update failed')
                after = client.get('/apps/qforce/icon/512.png', headers={'Cookie':'qstudy_session=PRIVATE_FIXTURE_TOKEN', 'Authorization':'Bearer PRIVATE_FIXTURE_TOKEN'}); assert_icon(after,512)
                require(hashlib.sha256(before.content).digest() != hashlib.sha256(after.content).digest(), 'Install icon ignored current project branding')
                with Image.open(io.BytesIO(after.content)) as image:
                    require(image.convert('RGB').getpixel((256,256)) == (239,17,59), 'Configured logo was not rendered in icon')
                require(toggle.post('/fixture/custom/wrongbrand').status_code == 200, 'Fixture branding mismatch failed')
                mismatch = client.get('/apps/qforce/icon/512.png'); assert_icon(mismatch,512)
                require(mismatch.content == before.content, 'Install icon accepted another project logo source')
            finally:
                stop_child(site); stop_child(api)
        print('PASS: production PWA HTTP; eight unique manifests and scoped launches, standalone display, PNG192/512+Apple180+maskable icons, MIME/cache headers, app/size validation, generic offline page, no-store API and updated QControl logo. Disposable branding fixture only; device install prompt is not simulated.')
        return 0
    except Exception as error:
        print('FAIL ['+stage+']: '+(str(error) if isinstance(error, StackFailure) else type(error).__name__))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
