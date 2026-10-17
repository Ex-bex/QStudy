"""QCareer: real production BFF, common login and disposable SQLite integration.

Run with --run after building frontend. No live accounts, database, .env or public
listeners are used. Course questions are deterministic fixtures, not paid AI.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack, closing
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile

from lumaball_stack import ROOT, StackFailure, base_environment, free_port, require, stop_child, wait_healthy

FIXTURE = '''import json
from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.database import Base, engine, SessionLocal
from app.models import User, StudentGroup, Course, SyllabusDocument, CurriculumWeek, ModuleWork, TestSession, TestQuestion
from app.auth import hash_password
from app.routers import auth_routes, career, tests, academic, branding
from app.services.career import initialize_career

@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if db.get(User, 1) is None:
            db.add_all([StudentGroup(id=1, name='Career fixture group'), StudentGroup(id=2, name='Other fixture group')])
            db.flush()
            db.add_all([User(id=1, email='career-admin@example.com', name='Administrator', role='admin', hashed_password=hash_password('FixtureCareer4729')),
                User(id=2, email='career-student@example.com', name='Student', role='student', group_id=1, hashed_password=hash_password('FixtureCareer4729')),
                User(id=3, email='career-other@example.com', name='Other student', role='student', group_id=2, hashed_password=hash_password('FixtureCareer4729'))])
            db.add(Course(id=1, group_id=1, title='Fixture subject', description='Controlled learning material'))
            db.flush()
            db.add(SyllabusDocument(id=1, course_id=1, uploaded_by=1, title='Fixture syllabus', filename='fixture.pdf', filepath='fixture.pdf', size=1, status='published'))
            db.flush()
            db.add(CurriculumWeek(id=1, course_id=1, week_number=1, title='Fixture week', module='Module 1', source_syllabus_id=1))
            db.add(ModuleWork(id=1, course_id=1, title='Fixture assignment', module='Module 1', week_number=1, max_score=100, source_syllabus_id=1))
            provenance = {'version':1,'mode':'course','course_id':1,'group_id':1,'module':'Module 1','week_numbers':[1],'work_ids':[1],
                'weeks':[{'week_number':1,'module':'Module 1','source_syllabus_id':1}],
                'works':[{'id':1,'week_number':1,'module':'Module 1','source_syllabus_id':1}], 'syllabi':[{'id':1,'title':'Fixture syllabus'}]}
            db.add(TestSession(id=1, user_id=2, source_context_json=json.dumps(provenance), status='active', difficulty='medium'))
            db.flush()
            db.add(TestQuestion(id=1, session_id=1, order=0, question='Fixture question', options='["A","B","C","D"]', correct_index=0, explanation='Fixture explanation'))
            db.commit()
        initialize_career(db)
    try:
        yield
    finally:
        engine.dispose()

app = FastAPI(lifespan=lifespan)
for module in (auth_routes, career, tests, academic, branding):
    app.include_router(module.router, prefix='/api')

@app.get('/api/health')
def health():
    return {'service':'QStudy','status':'ok'}
'''


def checked(response, status=200):
    require(response.status_code == status, f'HTTP {response.status_code}, expected {status}')
    return response.json()


def login(client, email):
    response = client.post('/api/auth/login', data={'username': email, 'password': 'FixtureCareer4729'})
    data = checked(response)
    require('access_token' not in data and client.cookies.get('qstudy_session'), 'Common login did not create the private session cookie')
    cookie = response.headers.get('set-cookie', '').lower()
    require('httponly' in cookie and 'samesite=strict' in cookie, 'Session cookie protections were lost')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    args = parser.parse_args()
    if not args.run:
        print('SKIP: pass --run after building frontend.')
        return 0
    import httpx
    from PIL import Image
    stage = 'fixture setup'
    try:
        require((ROOT / 'frontend/.next/BUILD_ID').is_file(), 'Build frontend before integration')
        require(not any((ROOT / 'frontend' / file).exists() for file in ('.env', '.env.local', '.env.production', '.env.production.local')), 'Isolated integration cannot load private frontend dotenv files')
        node = shutil.which('node')
        require(node is not None, 'Node executable missing')
        with tempfile.TemporaryDirectory(prefix='qstudy-career-stack-') as temporary, ExitStack() as stack:
            folder = Path(temporary)
            (folder / 'career_fixture.py').write_text(FIXTURE, encoding='utf-8')
            database = folder / 'fixture.sqlite3'
            api_port = free_port()
            site_port = free_port((api_port,))
            api_url, site_url = f'http://127.0.0.1:{api_port}', f'http://127.0.0.1:{site_port}'
            env = base_environment()
            env.update({'SECRET_KEY': secrets.token_hex(32), 'BFF_PROXY_SECRET': secrets.token_hex(32),
                'DATABASE_URL': 'sqlite:///' + database.as_posix(), 'UPLOAD_DIR': str(folder / 'uploads'),
                'BACKUP_DIR': str(folder / 'backups'), 'BACKUPS_ENABLED': 'false', 'RATE_LIMIT_ENABLED': 'false',
                'QSTUDY_MANAGED_RUNTIME': '1', 'PUBLIC_BASE_URL': site_url, 'CORS_ORIGINS': site_url,
                'ALLOW_PUBLIC_HTTP': 'false', 'RECOVERY_DELIVERY': 'disabled', 'GEMINI_API_KEY': '',
                'SMTP_HOST': '', 'SMTP_PASSWORD': '', 'PYTHONPATH': str(ROOT / 'backend'), 'PYTHONUTF8': '1',
                'PYTHONUNBUFFERED': '1', 'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1',
                'TRUST_PROXY_HEADERS': 'true', 'QSTUDY_ACCESS_MODE': 'local', 'BACKEND_URL': api_url})
            api_log = stack.enter_context((folder / 'api.log').open('wb'))
            front_log = stack.enter_context((folder / 'frontend.log').open('wb'))
            api, frontend = None, None
            def start_api():
                child = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'career_fixture:app', '--host', '127.0.0.1', '--port', str(api_port), '--no-access-log', '--log-level', 'error'],
                    cwd=folder, env=env, stdin=subprocess.DEVNULL, stdout=api_log, stderr=subprocess.STDOUT)
                try:
                    wait_healthy(api_url + '/api/health', child, seconds=35, log_path=folder / 'api.log')
                except Exception:
                    stop_child(child)
                    raise
                return child
            try:
                stage = 'API startup'
                api = start_api()
                frontend = subprocess.Popen([node, str(ROOT / 'frontend/server.mjs'), '--hostname', '127.0.0.1', '--port', str(site_port)],
                    cwd=ROOT / 'frontend', env=env, stdin=subprocess.DEVNULL, stdout=front_log, stderr=subprocess.STDOUT)
                wait_healthy(site_url + '/api/health', frontend, log_path=folder / 'frontend.log')
                def client():
                    return stack.enter_context(httpx.Client(base_url=site_url, headers={'Origin':site_url}, timeout=20, trust_env=False))
                public, admin, student, other = client(), client(), client(), client()
                stage = 'shared login and access boundaries'
                require(public.get('/qcareer').status_code == 200, 'Career public landing did not render')
                require(public.get('/brand/qforcelogo_qcareer.png').status_code == 200, 'QCareer brand logo missing')
                checked(public.get('/api/career/config'))
                require(public.get('/api/career/me').status_code == 401, 'Anonymous profile exposed')
                for account, email in ((admin,'career-admin@example.com'),(student,'career-student@example.com'),(other,'career-other@example.com')):
                    login(account,email)
                require(student.get('/api/admin/career/config').status_code == 403, 'Student became global administrator')
                require(student.patch('/api/career/profile',json={'user_id':3,'about':'forged'}).status_code == 422, 'Student could target someone else')
                stage = 'administrator skills, direction and curriculum mappings'
                skill = checked(admin.post('/api/admin/career/skills',json={'slug':'fixture-skill','name':'Fixture skill','category':'Fixture'}),201)
                direction = checked(admin.post('/api/admin/career/directions',json={'slug':'fixture-direction','title':'Fixture direction','requirements':[{'skill_id':skill['id'],'level':4}], 'career_paths':['Possible professional role'],'study_paths':['Further study']}),201)
                checked(student.patch('/api/career/profile',json={'target_direction_id':direction['id'],'interests':['Engineering'],'about':'Learning goal'}))
                link = checked(admin.post('/api/admin/career/learning-links',json={'skill_id':skill['id'],'course_id':1,'module':'Module 1','week_number':1,'syllabus_id':1,'target_level':2,'min_score':70}),201)
                initial = checked(student.get('/api/career/me'))
                require(next(s for s in initial['skills'] if s['id']==skill['id'])['level']==0,'Uncompleted learning granted skills')
                require(initial['recommendations']['steps'],'Mapped published curriculum produced no learning steps')
                stage = 'real question answer and finished test evidence'
                checked(student.post('/api/tests/1/answer/1',json={'option_index':0}))
                checked(student.post('/api/tests/1/finish'))
                verified = checked(student.get('/api/career/me'))
                require(next(s for s in verified['skills'] if s['id']==skill['id'])['level']==2,'Finished course test did not prove mapped skill')
                require(next(s for s in checked(other.get('/api/career/me'))['skills'] if s['id']==skill['id'])['level']==0,'Other student inherited evidence')
                stage = 'graded module work and idempotent evidence'
                work_link = checked(admin.post('/api/admin/career/learning-links',json={'skill_id':skill['id'],'course_id':1,'module':'Module 1','work_id':1,'syllabus_id':1,'target_level':4,'min_score':70}),201)
                submission = checked(student.put('/api/works/1/submission',json={'content':'Fixture submitted work','status':'submitted'}))
                checked(admin.put(f"/api/submissions/{submission['id']}/grade",json={'grade':100,'feedback':'Verified fixture work'}))
                workspace = checked(student.get('/api/career/me'))
                level = next(s for s in workspace['skills'] if s['id']==skill['id'])['level']
                require(level==4 and workspace['summary']['readiness']==100,'Graded work did not update target coverage')
                require(checked(student.get('/api/career/me'))['summary']==workspace['summary'],'Reading profile multiplied credit')
                stage = 'publication dates and personal saved opportunities'
                now = datetime.now(timezone.utc)
                opportunity = checked(admin.post('/api/admin/career/opportunities',json={'title':'Verified study opportunity','kind':'study','direction_id':direction['id'],'url':'https://example.org/study','published_at':(now-timedelta(hours=1)).isoformat(),'expires_at':(now+timedelta(days=3)).isoformat()}),201)
                expired = checked(admin.post('/api/admin/career/opportunities',json={'title':'Expired fixture','kind':'internship','published_at':(now-timedelta(days=3)).isoformat(),'expires_at':(now-timedelta(days=1)).isoformat()}),201)
                items = checked(student.get('/api/career/opportunities'))['items']
                require(any(i['id']==opportunity['id'] for i in items) and not any(i['id']==expired['id'] for i in items),'Publication dates were ignored')
                checked(student.put(f"/api/career/opportunities/{opportunity['id']}/save"))
                require(checked(student.get('/api/career/opportunities?saved=true'))['items'],'Saved opportunity was lost')
                require(not checked(other.get('/api/career/opportunities?saved=true'))['items'],'Saved list exposed another student')
                require(admin.post('/api/admin/career/opportunities',json={'title':'Invalid URL','kind':'job','url':'javascript:alert(1)'}).status_code==422,'Unsafe opportunity URL accepted')
                stage = 'replaceable transparent logo'
                image = Image.new('RGBA',(64,64),(0,0,0,0)); image.putpixel((32,32),(245,110,30,255))
                png = io.BytesIO(); image.save(png,format='PNG')
                logo = checked(admin.put('/api/branding/career-logo',files={'file':('prototype.png',png.getvalue(),'image/png')}))
                require(checked(public.get('/api/career/config'))['logo_url']==logo['logo_url'],'Career logo configuration did not change')
                require(public.get(logo['logo_url']).status_code==200,'Uploaded logo could not be viewed publicly')
                stage = 'same database restart persistence'
                stop_child(api); api=None
                api=start_api()
                restored = checked(student.get('/api/career/me'))
                require(restored['profile']['target_direction_id']==direction['id'] and restored['summary']==workspace['summary'],'Career state did not survive API restart')
                require(checked(public.get('/api/career/config'))['logo_url']==logo['logo_url'],'Logo did not survive API restart')
                require(checked(student.get('/api/career/opportunities?saved=true'))['items'],'Saved opportunity did not survive restart')
                stage = 'deletion revokes derived evidence without deleting academic records'
                checked(admin.delete(f"/api/admin/career/learning-links/{work_link['id']}"))
                require(next(s for s in checked(student.get('/api/career/me'))['skills'] if s['id']==skill['id'])['level']==2,'Deleted mapping retained evidence')
                checked(admin.delete(f"/api/admin/career/learning-links/{link['id']}"))
                require(next(s for s in checked(student.get('/api/career/me'))['skills'] if s['id']==skill['id'])['level']==0,'Deleted mapping retained test evidence')
                with closing(sqlite3.connect(database)) as db:
                    require(db.execute('SELECT COUNT(*) FROM users').fetchone()[0]==3,'Unexpected accounts created')
                    require(db.execute('SELECT score FROM test_sessions WHERE id=1').fetchone()[0]==100,'Academic test was overwritten')
                    require(db.execute('SELECT grade FROM work_submissions WHERE id=?',(submission['id'],)).fetchone()[0]==100,'Academic grade was overwritten')
                    require(db.execute('PRAGMA integrity_check').fetchone()==('ok',),'Shared database integrity failed')
                print('PASS: QCareer production HTTP/BFF shared HttpOnly login, student/admin isolation, curriculum mappings, real test completion, graded-work evidence, personal saved opportunities, publication expiry, transparent logo, restart persistence and revocation without academic data loss.')
                return 0
            finally:
                stop_child(frontend)
                stop_child(api)
    except Exception as error:
        reason = str(error) if isinstance(error,StackFailure) else type(error).__name__
        print(f'FAIL: QCareer isolated stack at {stage}: {reason}',file=sys.stderr)
        return 1


if __name__=='__main__':
    raise SystemExit(main())
