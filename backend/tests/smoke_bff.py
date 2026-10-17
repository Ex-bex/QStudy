"""Optional live smoke test. Creates isolated QA accounts and cleans them up.
Run from backend after starting API + web: python tests/smoke_bff.py
No existing account credentials or data are changed.
"""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import secrets
import uuid
import json
import os
import hashlib
import time
import re
from datetime import datetime
from urllib.parse import urlsplit
import httpx
from app.auth import hash_password
from app.database import SessionLocal
from app.models import User, StudentGroup, PasswordResetToken
from app.job_models import AIJob
from app.services.password_recovery import LOCAL_OUTBOX

def local_base_url():
    override = os.environ.get('QSTUDY_TEST_URL', '').rstrip('/')
    if override:
        parsed = urlsplit(override)
        if parsed.scheme not in ('http', 'https') or parsed.hostname not in ('127.0.0.1', 'localhost') or parsed.username or parsed.password:
            raise ValueError('Live smoke tests require a localhost URL')
        return override
    project = Path(__file__).resolve().parents[2]
    state_file = project / '.local' / 'processes.json'
    if state_file.is_file():
        state = json.loads(state_file.read_text(encoding='utf-8-sig'))
        if Path(state['workspace']).resolve() == project.resolve() and state.get('frontend'):
            port = int(state['frontend']['port'])
            if not 1 <= port <= 65535:
                raise ValueError('Invalid launcher frontend port')
            return f'http://127.0.0.1:{port}'
    return 'http://127.0.0.1:3000'


BASE = local_base_url()
name = uuid.uuid4().hex
password = secrets.token_urlsafe(20) + 'A3'
created_users = []
created_subjects = []
created_emails = set()
created_mail_paths = set()
checks = []
clients = []


def client():
    result = httpx.Client(base_url=BASE, headers={'Origin': BASE}, timeout=30)
    clients.append(result)
    return result


def checked(response, status, label):
    if response.status_code != status:
        raise AssertionError(f'{label}: expected {status}, got {response.status_code}')
    checks.append(label)
    return response


def capture_cookie(client, response):
    # This preview can run a production build over localhost HTTP. Httpx does not
    # implement browsers' localhost Secure-cookie exception; explicitly replay it.
    cookie = response.cookies.get('qstudy_session')
    if not cookie:
        raise AssertionError('Missing session cookie')
    client.headers['Cookie'] = 'qstudy_session=' + cookie
    return cookie


def no_private_fields(value):
    forbidden = {'hashed_password', 'password', 'token', 'access_token', 'token_hash',
                 'payload_json', 'checkpoint_json', 'lease_owner', 'lease_expires_at',
                 'secret_key', 'smtp_password'}
    if isinstance(value, dict):
        assert not forbidden.intersection(value), 'Private field exposed through BFF'
        for item in value.values():
            no_private_fields(item)
    elif isinstance(value, list):
        for item in value:
            no_private_fields(item)


def own_local_messages():
    # Only messages for this run's random QA addresses may be removed.
    if LOCAL_OUTBOX.resolve() != LOCAL_OUTBOX.absolute():
        raise AssertionError('Recovery storage is redirected')
    for path in LOCAL_OUTBOX.glob('reset-*.json'):
        if path.is_symlink():
            continue
        try:
            message = json.loads(path.read_text(encoding='utf-8'))
        except (OSError, ValueError):
            continue
        if str(message.get('recipient', '')).lower() in created_emails:
            created_mail_paths.add(path)
            yield path, message


def local_reset_token(email, user_id):
    # Delivery is asynchronous. Never print its link, token, email or contents.
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        with SessionLocal() as db:
            record = db.query(PasswordResetToken).filter(
                PasswordResetToken.user_id == user_id).order_by(PasswordResetToken.id.desc()).first()
            digest = record.token_hash if record and record.delivery_status == 'delivered' else None
        for _, message in own_local_messages():
            if str(message.get('recipient', '')).lower() != email:
                continue
            link = urlsplit(str(message.get('link', '')))
            if not link.fragment.startswith('token='):
                continue
            token = link.fragment[6:]
            if digest and hashlib.sha256(token.encode()).hexdigest() == digest:
                return token
        time.sleep(0.1)
    raise AssertionError('Local QA recovery message was not delivered')


admin = client()
try:
    with SessionLocal() as db:
        group = db.query(StudentGroup).first()
        actor = User(email=f'qa-admin-{name}@example.com', name='Temporary QA admin', role='admin',
                     hashed_password=hash_password(password), group_id=group.id if group else None)
        db.add(actor)
        db.commit()
        admin_id = actor.id
        admin_email = actor.email
    response = checked(admin.post('/api/auth/login', data={'username': admin_email, 'password': password}), 200, 'admin login')
    assert 'access_token' not in response.json() and 'token' not in response.json()
    assert 'HttpOnly' in response.headers['set-cookie'] and 'SameSite=strict' in response.headers['set-cookie']
    capture_cookie(admin, response)
    checked(admin.get('/api/auth/me'), 200, 'cookie authenticated profile')
    audit = checked(admin.get('/api/admin/audit', params={'limit': 5}), 200, 'admin audit read').json()
    assert isinstance(audit['items'], list) and audit['limit'] == 5 and audit['total'] >= 0
    no_private_fields(audit)
    backups = checked(admin.get('/api/admin/backups'), 200, 'admin backup status read').json()
    assert isinstance(backups['items'], list) and isinstance(backups['status'], dict)
    no_private_fields(backups)
    if backups['items']:
        archive = backups['items'][0]['name']
        assert re.fullmatch(r'qstudy-\d{8}-\d{6}-[a-f0-9]{8}\.zip', archive)
        # Inspect the download in memory; never export database/upload contents.
        with admin.stream('GET', f'/api/admin/backups/{archive}/download') as download:
            checked(download, 200, 'admin existing backup ZIP download')
            assert download.headers.get('content-type', '').split(';')[0] == 'application/zip'
            prefix = b''
            for chunk in download.iter_bytes():
                prefix += chunk[:2 - len(prefix)]
                if len(prefix) == 2:
                    break
            assert prefix == b'PK', 'Backup download is not a ZIP stream'
    else:
        print('SKIP: backup ZIP download (no existing archive; smoke does not create backups)')
    checked(admin.post('/api/subjects', json={'name': 'QA'}, headers={'Origin': 'https://foreign.example'}), 403, 'cross-origin CSRF denied')
    opposite_scheme = 'https' if urlsplit(BASE).scheme == 'http' else 'http'
    checked(admin.post('/api/subjects', json={'name': 'QA'}, headers={'Origin': f'{opposite_scheme}://{urlsplit(BASE).netloc}'}), 403, 'cross-scheme CSRF denied')
    no_origin = httpx.post(BASE + '/api/auth/login', data={'username': admin_email, 'password': password}, timeout=30)
    checked(no_origin, 403, 'missing Origin denied')
    students = []
    registration_groups = checked(admin.get('/api/auth/registration-groups'), 200, 'public registration groups').json()
    selected_group = registration_groups[0]['id'] if registration_groups else None
    for index in (1, 2):
        student = client()
        response = checked(student.post('/api/auth/register', json={'email': f'qa-student-{index}-{name}@example.com', 'password': password, 'name': 'Temporary QA student', 'group_id': selected_group}), 201, f'student {index} registration')
        created_users.append(response.json()['id'])
        created_emails.add(response.json()['email'].lower())
        assert response.json()['role'] == 'student'
        assert 'access_token' not in response.json() and 'token' not in response.json()
        capture_cookie(student, response)
        students.append(student)
    one, two = students
    checked(one.get('/api/admin/users'), 403, 'student admin dashboard denied')
    checked(one.get('/api/admin/audit'), 403, 'student audit denied')
    checked(one.get('/api/admin/backups'), 403, 'student backup read denied')
    checked(one.post('/api/admin/backups'), 403, 'student backup creation denied')
    checked(one.get('/api/admin/backups/qstudy-20261010-000000-1234abcd.zip/download'),
        403, 'student ZIP download reaches admin guard')
    checked(one.get('/api/admin/backups/qstudy-20261010-000000-1234abcd.zip.exe/download'),
        400, 'malformed backup path denied by BFF')
    with SessionLocal() as db:
        fixture_job = AIJob(id=uuid.uuid4().hex, user_id=created_users[0], kind='qa_smoke',
            title='Temporary private QA completion', status='done', payload_json='{"private":"QA source"}',
            checkpoint_json='{"private":"QA checkpoint"}', result_json='{"qa":true}',
            finished_at=datetime.utcnow())
        db.add(fixture_job)
        db.commit()
        fixture_job_id = fixture_job.id
    own_jobs = checked(one.get('/api/notifications/jobs'), 200, 'own durable job list').json()
    assert isinstance(own_jobs, list) and any(job['id'] == fixture_job_id for job in own_jobs)
    no_private_fields(own_jobs)
    peer_jobs = checked(two.get('/api/notifications/jobs'), 200, 'peer durable job list').json()
    assert all(job['id'] != fixture_job_id for job in peer_jobs)
    checked(two.get(f'/api/notifications/jobs/{fixture_job_id}'), 404, 'peer job result denied')
    checked(two.post(f'/api/notifications/{fixture_job_id}/ack'), 404, 'peer notification acknowledgement denied')
    first_notifications = checked(one.get('/api/notifications'), 200, 'durable notification read').json()
    second_notifications = checked(one.get('/api/notifications'), 200, 'durable notification repeat read').json()
    assert any(job['id'] == fixture_job_id for job in first_notifications)
    assert any(job['id'] == fixture_job_id for job in second_notifications)
    checked(one.post(f'/api/notifications/{fixture_job_id}/ack'), 200, 'own notification acknowledgement')
    assert all(job['id'] != fixture_job_id for job in checked(one.get('/api/notifications'), 200,
        'acknowledged notification hidden').json())
    checked(one.post('/api/subjects', json={'name': 'QA'}), 403, 'student global mutation denied')
    checked(one.patch('/api/auth/me', json={'name': 'Escalation', 'role': 'admin'}), 422, 'profile escalation denied')
    subject = checked(admin.post('/api/subjects', json={'name': 'Temporary QA subject'}), 201, 'admin subject create').json()
    created_subjects.append(subject['id'])
    note = checked(one.post('/api/notes', json={'title': 'Temporary private QA note', 'subject_id': subject['id']}), 200, 'private note create').json()
    checked(two.patch(f"/api/notes/{note['id']}", json={'title': 'Attempted overwrite'}), 404, 'peer note edit denied')
    checked(two.delete(f"/api/notes/{note['id']}"), 404, 'peer note delete denied')
    groups = checked(one.get('/api/groups'), 200, 'seeded groups visible').json()
    assert groups
    own_group = next(group for group in groups if group['name'] == 'ИП-26-3кс')
    group_detail = checked(one.get(f"/api/groups/{own_group['id']}"), 200, 'seeded courses visible').json()
    assert group_detail['courses']
    introduction = next(course for course in group_detail['courses'] if course['title'] == 'Мамандыққа кіріспе')
    course = checked(one.get(f"/api/courses/{introduction['id']}"), 200, 'source curriculum visible').json()
    assert len(course['weeks']) == 15 and len(course['works']) == 8
    checked(admin.patch(f'/api/admin/users/{admin_id}', json={'role': 'student'}), 409, 'self demotion denied')
    old_cookie = one.headers['Cookie']
    response = checked(one.post('/api/auth/password', json={'current_password': password, 'new_password': password + '9'}), 200, 'password change')
    capture_cookie(one, response)
    checked(one.get('/api/auth/me', headers={'Cookie': old_cookie}), 401, 'previous session revoked')
    checked(one.get('/api/auth/me'), 200, 'replacement session works')
    checked(one.post('/api/auth/logout'), 200, 'logout')
    checked(one.get('/api/auth/me'), 401, 'logout revokes session')

    recovery = client()
    options = checked(recovery.get('/api/auth/recovery-options'), 200, 'public recovery options').json()
    assert options['delivery'] == 'local', 'Recovery smoke requires local delivery; no email is sent'
    assert isinstance(options['expires_minutes'], int) and options['expires_minutes'] > 0
    before_reset = checked(two.get('/api/auth/me'), 200, 'recovery account before reset').json()
    previous_session = two.headers['Cookie']
    existing = checked(recovery.post('/api/auth/forgot-password', json={'email': before_reset['email']}),
        200, 'QA forgot password').json()
    unknown = checked(recovery.post('/api/auth/forgot-password', json={'email': f'qa-unknown-{name}@example.com'}),
        200, 'unknown forgot password').json()
    assert existing == unknown and existing['ok'] is True and existing['delivery'] == 'local'
    no_private_fields(existing)
    assert 'link' not in existing
    token = local_reset_token(before_reset['email'].lower(), before_reset['id'])
    checks.append('local QA recovery delivery verified privately')
    replacement_password = secrets.token_urlsafe(20) + 'Recovery4'
    reset = checked(recovery.post('/api/auth/reset-password', json={'token': token,
        'new_password': replacement_password}), 200, 'one-time password reset').json()
    no_private_fields(reset)
    checked(recovery.post('/api/auth/reset-password', json={'token': token,
        'new_password': replacement_password + '9'}), 400, 'reset token replay denied')
    token = None
    checked(two.get('/api/auth/me', headers={'Cookie': previous_session}), 401, 'reset revokes previous session')
    checked(recovery.post('/api/auth/login', data={'username': before_reset['email'], 'password': password}),
        401, 'previous password denied after recovery')
    response = checked(two.post('/api/auth/login', data={'username': before_reset['email'],
        'password': replacement_password}), 200, 'recovered account login')
    no_private_fields(response.json())
    capture_cookie(two, response)
    after_reset = checked(two.get('/api/auth/me'), 200, 'recovered session authenticated').json()
    assert all(after_reset[key] == before_reset[key] for key in ('id', 'email', 'name', 'role', 'group_id'))
    print('PASS:', len(checks), 'live BFF/session/authorization checks')
    for label in checks:
        print(' -', label)
finally:
    for subject_id in created_subjects:
        try:
            response = admin.delete(f'/api/subjects/{subject_id}')
            cleaned = response.status_code == 200
        except httpx.HTTPError:
            cleaned = False
        if not cleaned:
            print('Cleanup requires attention for QA subject', subject_id)
    for user_id in created_users:
        try:
            response = admin.delete(f'/api/admin/users/{user_id}')
            cleaned = response.status_code == 200
        except httpx.HTTPError:
            cleaned = False
        if not cleaned:
            print('Cleanup requires attention for QA account', user_id)
    # Also catches delivery that completed just before a failed smoke assertion.
    try:
        list(own_local_messages())
    except (OSError, AssertionError):
        print('Cleanup requires attention for local QA recovery messages')
    for path in created_mail_paths:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            print('Cleanup requires attention for a local QA recovery message')
    with SessionLocal() as db:
        actor = db.query(User).filter(User.email == f'qa-admin-{name}@example.com').first()
        if actor:
            db.delete(actor)
            db.commit()
    for session in clients:
        session.close()
