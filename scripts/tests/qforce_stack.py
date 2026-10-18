"""Public QForce/QStudy routing and director photos through the production BFF.

Opt in with --run after the frontend build. Uses disposable SQLite and loopback
listeners only; never loads private credentials or paid AI.
"""
import argparse
from contextlib import ExitStack
import io
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import sys
import tempfile

from lumaball_stack import ROOT, StackFailure, base_environment, free_port, require, stop_child, wait_healthy
from qtests_stack import FIXTURE, checked, login

FIXTURE = FIXTURE.replace('from app.routers import auth_routes, qtests, branding',
    'from app.routers import auth_routes, qtests, branding, developers\nfrom app.services.developers import seed_developer_departments')
FIXTURE = FIXTURE.replace("    if os.environ.get('QTESTS_FIXTURE_WORKERS')", "        seed_developer_departments(db)\n    if os.environ.get('QTESTS_FIXTURE_WORKERS')")
FIXTURE = FIXTURE.replace('for module in (auth_routes, qtests, branding):', 'for module in (auth_routes, qtests, branding, developers):')


def photo():
    from PIL import Image
    output = io.BytesIO()
    Image.new('RGB', (64, 80), (45, 80, 110)).save(output, format='JPEG')
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    if not parser.parse_args().run:
        print('SKIP: pass --run after frontend build.'); return 0
    import httpx
    stage = 'setup'
    try:
        require((ROOT / 'frontend/.next/BUILD_ID').is_file(), 'Build frontend first')
        require(not any((ROOT / 'frontend' / name).exists() for name in ('.env', '.env.local', '.env.production', '.env.production.local')), 'Private frontend dotenv is unsupported by isolated tests')
        with tempfile.TemporaryDirectory(prefix='qforce-stack-') as temporary, ExitStack() as stack:
            folder = Path(temporary); (folder / 'qforce_fixture.py').write_text(FIXTURE, encoding='utf-8')
            api_port = free_port(); site_port = free_port((api_port,))
            api_url = f'http://127.0.0.1:{api_port}'; site_url = f'http://127.0.0.1:{site_port}'
            environment = base_environment()
            environment.update({'SECRET_KEY': secrets.token_hex(32), 'BFF_PROXY_SECRET': secrets.token_hex(32),
                'DATABASE_URL': 'sqlite:///' + (folder / 'fixture.sqlite3').as_posix(), 'UPLOAD_DIR': str(folder / 'uploads'),
                'BACKUP_DIR': str(folder / 'backups'), 'BACKUPS_ENABLED': 'false', 'RATE_LIMIT_ENABLED': 'false',
                'QSTUDY_MANAGED_RUNTIME': '1', 'PUBLIC_BASE_URL': site_url, 'CORS_ORIGINS': site_url,
                'ALLOW_PUBLIC_HTTP': 'false', 'RECOVERY_DELIVERY': 'disabled', 'GEMINI_API_KEY': '', 'SMTP_HOST': '', 'SMTP_PASSWORD': '',
                'PYTHONPATH': str(ROOT / 'backend'), 'PYTHONUTF8': '1', 'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1',
                'TRUST_PROXY_HEADERS': 'true', 'QSTUDY_ACCESS_MODE': 'local', 'BACKEND_URL': api_url, 'QTESTS_FIXTURE_WORKERS': '0'})
            api_log = stack.enter_context((folder / 'api.log').open('wb'))
            site_log = stack.enter_context((folder / 'site.log').open('wb'))
            api = site = None
            def start_api():
                child = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'qforce_fixture:app', '--host', '127.0.0.1', '--port', str(api_port), '--no-access-log', '--log-level', 'error'], cwd=folder, env=environment, stdin=subprocess.DEVNULL, stdout=api_log, stderr=subprocess.STDOUT)
                try: wait_healthy(api_url + '/api/health', child, log_path=folder / 'api.log')
                except Exception: stop_child(child); raise
                return child
            try:
                stage = 'startup'; api = start_api()
                site = subprocess.Popen([shutil.which('node'), str(ROOT / 'frontend/server.mjs'), '--hostname', '127.0.0.1', '--port', str(site_port)], cwd=ROOT / 'frontend', env=environment, stdin=subprocess.DEVNULL, stdout=site_log, stderr=subprocess.STDOUT)
                wait_healthy(site_url + '/api/health', site, log_path=folder / 'site.log')
                public = stack.enter_context(httpx.Client(base_url=site_url, headers={'Origin': site_url}, trust_env=False, timeout=25))
                admin = stack.enter_context(httpx.Client(base_url=site_url, headers={'Origin': site_url}, trust_env=False, timeout=25))
                student = stack.enter_context(httpx.Client(base_url=site_url, headers={'Origin': site_url}, trust_env=False, timeout=25))
                stage = 'public routing'
                home = public.get('/'); require(home.status_code == 200 and '<title>QForce' in home.text, 'Root did not render QForce metadata')
                for target in ('/qstudy', '/qtests', '/qcareer', '/qball', '/login', '/qcontrol'):
                    require(f'href="{target}"' in home.text, 'Missing ecosystem destination: ' + target)
                study = public.get('/qstudy'); require(study.status_code == 200 and '<title>QStudy' in study.text and 'Меньше хаоса' in study.text, 'QStudy landing was not preserved')
                require(public.get('/developers').status_code == 200, 'Developer contacts route failed')
                assets = set(re.findall(r'(?:src|href)="(/_next/static/[^"<>]+\.(?:js|css))"', home.text + study.text))
                for asset in assets: require(public.get(asset).status_code == 200, 'Production asset missing')
                departments = checked(public.get('/api/developers'))['departments']
                require(len(departments) == 4 and all(row['director_photo_url'] is None for row in departments), 'Directory defaults or portrait placeholders incorrect')
                department = departments[0]; identifier = department['id']; before_logo = department['logo_url']
                endpoint = f'/api/branding/departments/{identifier}/director-photo'
                stage = 'roles and source upload'
                require(public.put(endpoint, files={'file': ('photo.jpg', photo(), 'image/jpeg')}).status_code == 401, 'Anonymous photo upload allowed')
                login(admin, 'qtests-admin@example.com'); login(student, 'qtests-student@example.com')
                require(student.put(endpoint, files={'file': ('photo.jpg', photo(), 'image/jpeg')}).status_code == 403, 'Student photo upload allowed')
                uploaded = checked(admin.put(endpoint, files={'file': ('photo.jpg', photo(), 'image/jpeg')}))
                require(uploaded['director_photo_custom'] and uploaded['logo_url'] == before_logo, 'Photo and logo were mixed')
                url = uploaded['director_photo_url']; require(re.fullmatch(r'/api/branding/assets/director-\d+/[a-f0-9]{64}\.png', url) is not None, 'Unsafe public portrait URL')
                picture = public.get(url); require(picture.status_code == 200 and picture.headers['content-type'] == 'image/png', 'Public PNG cannot pass the BFF')
                require('immutable' in picture.headers.get('cache-control', ''), 'Portrait cache contract was lost')
                require(public.get('/api/developers').json()['departments'][0]['director_photo_url'] == url, 'Directory did not publish the uploaded portrait')
                stage = 'restart persistence'; stop_child(api); api = start_api()
                require(public.get(url).content == picture.content, 'Portrait did not survive restart')
                stage = 'reset and independent logo'
                reset = checked(admin.delete(endpoint)); require(reset['director_photo_url'] is None and reset['logo_url'] == before_logo, 'Reset changed the department logo')
                require(public.get(url).status_code == 404, 'Deleted portrait remained addressable')
                require(student.delete(endpoint).status_code == 403, 'Student reset allowed')
            finally:
                stop_child(site); stop_child(api)
        print('PASS: QForce home, six ecosystem links, preserved QStudy landing, production assets, live directory, authenticated administrator JPEG-to-PNG upload through BFF, public immutable director asset, restart persistence, independent logo/reset and access boundaries. Disposable data only.')
        return 0
    except (StackFailure, AssertionError) as error:
        print('FAIL [' + stage + ']: ' + str(error)); return 1


if __name__ == '__main__':
    raise SystemExit(main())
