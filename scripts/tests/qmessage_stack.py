"""Opt-in QMessage integration through the real compiled same-origin frontend.

Uses four disposable Q-ID accounts, loopback listeners and temporary SQLite.
Never reads live credentials, sends mail, contacts AI or changes the user's data.
Run with --run after the production frontend build.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack, closing
import io
import json
from pathlib import Path
import re
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from uuid import uuid4

from lumaball_stack import ROOT, StackFailure, base_environment, free_port, require, stop_child, wait_healthy
from qtests_stack import checked, login

FIXTURE = '''from contextlib import asynccontextmanager
from fastapi import FastAPI
from app.database import Base, engine, SessionLocal
from app.models import User, Note
from app.auth import hash_password
from app import qmessage_models
from app.routers import auth_routes, branding, qmessage, admin
from app.services.qmessage import initialize_qmessage

@asynccontextmanager
async def lifespan(app):
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        if db.get(User, 1) is None:
            db.add_all([
                User(id=1, email='qtests-admin@example.com', name='Administrator', role='admin', hashed_password=hash_password('FixtureQTests4729')),
                User(id=2, email='qtests-student@example.com', name='Айдана Серік', role='student', hashed_password=hash_password('FixtureQTests4729')),
                User(id=3, email='qtests-other@example.com', name='Бекзат Нурлан', role='student', hashed_password=hash_password('FixtureQTests4729')),
                User(id=4, email='message-outsider@example.com', name='Unrelated student', role='student', hashed_password=hash_password('FixtureQTests4729'))])
            db.flush()
            db.add(Note(user_id=2, title='Preserved before messaging', content='Existing personal learning note'))
            db.commit()
        initialize_qmessage(db)
    try:
        yield
    finally:
        engine.dispose()

app = FastAPI(lifespan=lifespan)
for module in (auth_routes, branding, qmessage, admin):
    app.include_router(module.router, prefix='/api')
@app.get('/api/health')
def health(): return {'status':'ok','service':'QStudy'}
'''


def new_message(client, conversation_id, text='', **fields):
    payload = {'text': text, 'client_id': str(uuid4()), **fields}
    response = client.post(f'/api/qmessage/conversations/{conversation_id}/messages', json=payload)
    return checked(response, 201)


def picture():
    from PIL import Image, PngImagePlugin
    image = Image.new('RGB', (80, 64), (18, 150, 140))
    output = io.BytesIO()
    info = PngImagePlugin.PngInfo(); info.add_text('private', 'MUST_NOT_SURVIVE_SANITATION')
    image.save(output, format='PNG', pnginfo=info)
    return output.getvalue()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', action='store_true')
    if not parser.parse_args().run:
        print('SKIP: opt in with --run after building frontend.'); return 0
    import httpx
    stage = 'setup'
    try:
        require((ROOT / 'frontend/.next/BUILD_ID').is_file(), 'Build frontend first')
        require(not any((ROOT / 'frontend' / name).exists() for name in ('.env', '.env.local', '.env.production', '.env.production.local')), 'Private frontend dotenv is unsupported by isolated tests')
        with tempfile.TemporaryDirectory(prefix='qmessage-stack-') as temporary, ExitStack() as stack:
            folder = Path(temporary)
            (folder / 'message_fixture.py').write_text(FIXTURE, encoding='utf-8')
            database = folder / 'fixture.sqlite3'
            api_port = free_port(); site_port = free_port((api_port,))
            api_url = f'http://127.0.0.1:{api_port}'; site_url = f'http://127.0.0.1:{site_port}'
            environment = base_environment()
            environment.update({'SECRET_KEY': secrets.token_hex(32), 'BFF_PROXY_SECRET': secrets.token_hex(32),
                'DATABASE_URL': 'sqlite:///' + database.as_posix(), 'UPLOAD_DIR': str(folder / 'uploads'),
                'BACKUP_DIR': str(folder / 'backups'), 'BACKUPS_ENABLED': 'false', 'RATE_LIMIT_ENABLED': 'false',
                'QSTUDY_MANAGED_RUNTIME': '1', 'PUBLIC_BASE_URL': site_url, 'CORS_ORIGINS': site_url,
                'ALLOW_PUBLIC_HTTP': 'false', 'RECOVERY_DELIVERY': 'disabled', 'GEMINI_API_KEY': '', 'SMTP_HOST': '', 'SMTP_PASSWORD': '',
                'PYTHONPATH': str(ROOT / 'backend'), 'PYTHONUTF8': '1', 'NODE_ENV': 'production', 'NEXT_TELEMETRY_DISABLED': '1',
                'TRUST_PROXY_HEADERS': 'true', 'QSTUDY_ACCESS_MODE': 'local', 'BACKEND_URL': api_url})
            api_log = stack.enter_context((folder / 'api.log').open('wb'))
            site_log = stack.enter_context((folder / 'site.log').open('wb'))
            api = site = None
            def start_api():
                child = subprocess.Popen([sys.executable, '-m', 'uvicorn', 'message_fixture:app', '--host', '127.0.0.1', '--port', str(api_port), '--no-access-log', '--log-level', 'error'], cwd=folder, env=environment, stdin=subprocess.DEVNULL, stdout=api_log, stderr=subprocess.STDOUT)
                try: wait_healthy(api_url + '/api/health', child, log_path=folder / 'api.log')
                except Exception: stop_child(child); raise
                return child
            def client():
                return stack.enter_context(httpx.Client(base_url=site_url, headers={'Origin':site_url}, trust_env=False, timeout=35))
            try:
                stage = 'startup'; api = start_api()
                site = subprocess.Popen([shutil.which('node'), str(ROOT / 'frontend/server.mjs'), '--hostname', '127.0.0.1', '--port', str(site_port)], cwd=ROOT / 'frontend', env=environment, stdin=subprocess.DEVNULL, stdout=site_log, stderr=subprocess.STDOUT)
                wait_healthy(site_url + '/api/health', site, log_path=folder / 'site.log')
                public, alice, bob, outsider, administrator = (client() for _ in range(5))
                stage = 'public routes and shared Q-ID'
                landing = public.get('/qmessage'); require(landing.status_code == 200 and '<title>QMessage' in landing.text, 'QMessage landing or metadata failed')
                require('href="/qmessage"' in public.get('/').text, 'QForce lacks the QMessage project link')
                require(public.get('/api/qmessage/conversations').status_code == 401, 'Anonymous conversations exposed')
                require(public.get('/qcontrol/qmessage').status_code == 307, 'QControl messaging is not protected')
                for c, email in ((alice,'qtests-student@example.com'), (bob,'qtests-other@example.com'), (outsider,'message-outsider@example.com'), (administrator,'qtests-admin@example.com')):
                    login(c, email)
                require(alice.get('/qmessage/chats').status_code == 200, 'Q-ID did not open messenger')
                require(alice.get('/qcontrol/qmessage').status_code == 307 and alice.get('/api/admin/qmessage/overview').status_code == 403, 'Student received messenger controls')
                require(administrator.get('/qcontrol/qmessage').status_code == 200, 'Administrator cannot open messaging controls')
                config = checked(public.get('/api/qmessage/config')); require(config['enabled'] and config['title'] == 'QMessage', 'Messenger defaults wrong')
                stage = 'name discovery and idempotent conversation'
                found = checked(alice.get('/api/qmessage/users', params={'q':'бЕКЗАТ'}))['items']
                require(any(row['id'] == 3 for row in found), 'Cyrillic case-insensitive search failed')
                require(all('email' not in row and 'hashed_password' not in row for row in found), 'Search disclosed private account fields')
                conversation = checked(alice.post('/api/qmessage/conversations', json={'user_id':3}), 201)
                identifier = conversation['id']; base = f'/api/qmessage/conversations/{identifier}'
                require(checked(bob.post('/api/qmessage/conversations', json={'user_id':2}))['id'] == identifier, 'Two users created duplicate direct rooms')
                for c in (outsider, administrator):
                    require(c.get(base + '/messages').status_code == 404, 'Nonmember can read correspondence')
                require(alice.post(base + '/messages', headers={'Origin':'https://other.example'}, json={'text':'forged','client_id':str(uuid4())}).status_code == 403, 'Cross-site message accepted')
                stage = 'live delivery, unread and retries'
                initial_cursor = checked(bob.get('/api/qmessage/conversations'))['cursor']
                payload = {'text':'Привет, Бекзат! 👋','client_id':str(uuid4())}
                with ThreadPoolExecutor(max_workers=1) as pool:
                    waiting = pool.submit(bob.get, '/api/qmessage/events', params={'after':initial_cursor,'wait':10})
                    time.sleep(.2)
                    sent_at = time.monotonic()
                    first = checked(alice.post(base + '/messages', json=payload), 201)
                    event = checked(waiting.result(timeout=15))
                    require(time.monotonic() - sent_at < 5, 'Live event delivery was too slow')
                require(any(item['message_id'] == first['id'] for item in event['items']), 'Receiver did not receive its message event')
                require(all('text' not in item for item in event['items']), 'Event metadata leaks message text')
                repeated = checked(alice.post(base + '/messages', json=payload))
                require(repeated['id'] == first['id'], 'Retry duplicated the message')
                require(alice.post(base + '/messages', json={**payload,'text':'different retry'}).status_code == 409, 'Idempotency key accepted changed content')
                inbox = checked(bob.get('/api/qmessage/conversations'))['items']
                require(next(row for row in inbox if row['id'] == identifier)['unread_count'] == 1, 'Unread count failed')
                checked(bob.post(base + '/read', json={'message_id':first['id']}))
                require(next(row for row in checked(alice.get('/api/qmessage/conversations'))['items'] if row['id'] == identifier)['peer_read_message_id'] == first['id'], 'Read receipt did not reach the author')
                stage = 'replies, reactions, search, edits and stickers'
                reply = new_message(bob, identifier, 'Привет! Всё получилось 🙂', reply_to_id=first['id'])
                require(reply['reply_to']['text'] == first['text'], 'Reply points to the wrong message')
                changed = checked(alice.patch(f"/api/qmessage/messages/{first['id']}", json={'text':'Привет! Исправил сообщение 👋'}))
                require(changed['edited_at'] and 'Исправил' in changed['text'], 'Message edit was not persisted')
                reaction = checked(bob.put(f"/api/qmessage/messages/{first['id']}/reaction", json={'emoji':'❤️'}))
                require(any(row['emoji'] == '❤️' and row['count'] == 1 for row in reaction['reactions']), 'Reaction not saved')
                require(bob.patch(f"/api/qmessage/messages/{first['id']}", json={'text':'forged edit'}).status_code == 403, 'Peer edited another author')
                require(checked(alice.get(base + '/messages', params={'q':'исПРАВИЛ'}))['items'][0]['id'] == first['id'], 'Unicode conversation search failed')
                catalog = checked(alice.get('/api/qmessage/stickers'))['items']
                require(len(catalog) >= 8, 'Default sticker catalog absent')
                for sticker in catalog:
                    if sticker['image_url']: require(public.get(sticker['image_url']).status_code == 200, 'Bundled sticker source missing')
                sticker = new_message(alice, identifier, sticker_id=catalog[0]['id'])
                require(sticker['sticker']['id'] == catalog[0]['id'], 'Sticker send failed')
                checked(bob.post(base + '/typing', json={'typing':True}))
                require(checked(alice.get(base + '/typing'))['typing'], 'Typing status missing')
                stage = 'private normalized photo'
                attachment = checked(alice.post(base + '/attachments', files={'file':('фото.png',picture(),'image/png')}), 201)
                photo_message = new_message(alice, identifier, 'Наше фото', attachment_id=attachment['id'])
                image = bob.get(photo_message['attachment']['url'])
                require(image.status_code == 200 and image.headers['content-type'] == 'image/png' and b'MUST_NOT_SURVIVE' not in image.content, 'Photo sanitation or private delivery failed')
                require(outsider.get(attachment['url']).status_code == 404 and administrator.get(attachment['url']).status_code == 404, 'Photo leaked outside the conversation')
                stage = 'durability across restart'
                stop_child(api); api = start_api()
                history = checked(bob.get(base + '/messages'))['items']
                require({first['id'],reply['id'],sticker['id'],photo_message['id']} <= {row['id'] for row in history}, 'Restart lost correspondence')
                require(bob.get(attachment['url']).content == image.content, 'Restart lost attachment bytes')
                require(checked(bob.get('/api/qmessage/events', params={'after':initial_cursor,'wait':0}))['items'], 'Restart lost unread delivery events')
                stage = 'blocks and report-based moderation'
                checked(bob.put('/api/qmessage/users/2/block', json={'blocked':True}))
                require(alice.post(base + '/messages', json={'text':'blocked','client_id':str(uuid4())}).status_code == 403, 'Blocked sender can still send')
                require(bob.get(base + '/messages').status_code == 200, 'Block deleted private history')
                checked(bob.put('/api/qmessage/users/2/block', json={'blocked':False}))
                report = checked(bob.post(f"/api/qmessage/messages/{first['id']}/report", json={'reason':'Проверка модерации тестового сообщения'}), 201)
                reports = checked(administrator.get('/api/admin/qmessage/reports'))['items']
                require(any(row['id'] == report['id'] and row['message']['id'] == first['id'] for row in reports), 'Reported content did not reach authorized moderation')
                checked(administrator.post(f"/api/admin/qmessage/reports/{report['id']}/resolve", json={'delete_message':True}))
                history = checked(bob.get(base + '/messages'))['items']
                removed = next(row for row in history if row['id'] == first['id'])
                require(removed['deleted'] and not removed['text'], 'Moderation retained the removed message')
                require(next(row for row in history if row['id'] == reply['id'])['reply_to']['deleted'], 'Reply retained deleted original text')
                checked(administrator.patch('/api/admin/qmessage/users/2/ban', json={'banned':True,'reason':'Проверка ограничений'}))
                require(alice.post(base + '/messages', json={'text':'banned','client_id':str(uuid4())}).status_code == 403, 'Messaging ban is ineffective')
                checked(administrator.patch('/api/admin/qmessage/users/2/ban', json={'banned':False,'reason':''}))
                stage = 'catalog and service controls'
                custom = checked(administrator.post('/api/admin/qmessage/stickers', json={'id':'fixture-sticker','label':'Тестовый стикер','emoji':'✨','active':True,'position':100}), 201)
                checked(administrator.put(f"/api/admin/qmessage/stickers/{custom['id']}/image", files={'file':('sticker.png',picture(),'image/png')}))
                custom = next(row for row in checked(alice.get('/api/qmessage/stickers'))['items'] if row['id'] == custom['id'])
                require(public.get(custom['image_url']).status_code == 200, 'Custom sticker image unavailable')
                checked(administrator.delete(f"/api/admin/qmessage/stickers/{custom['id']}"))
                require(not any(row['id'] == custom['id'] for row in checked(alice.get('/api/qmessage/stickers'))['items']), 'Removed sticker remains available for sending')
                checked(administrator.patch('/api/admin/qmessage/settings', json={'enabled':False,'announcement':'Техническое обслуживание'}))
                require(alice.post(base + '/messages', json={'text':'disabled','client_id':str(uuid4())}).status_code == 503, 'Disabled messenger accepts new messages')
                require(administrator.get('/api/admin/qmessage/overview').status_code == 200, 'Disabling messenger removed administration access')
                checked(administrator.patch('/api/admin/qmessage/settings', json={'enabled':True,'announcement':''}))
                stage = 'revocation during a pending long poll'
                outsider_cursor = checked(outsider.get('/api/qmessage/conversations'))['cursor']
                with ThreadPoolExecutor(max_workers=1) as pool:
                    pending = pool.submit(outsider.get, '/api/qmessage/events', params={'after':outsider_cursor,'wait':10})
                    time.sleep(.2)
                    checked(administrator.post('/api/admin/users/4/password', json={'password':'FixtureQTests4729'}))
                    revoked = pending.result(timeout=15)
                require(revoked.status_code == 401, 'A long poll survived Q-ID revocation')
                require('qstudy_session=' not in revoked.headers.get('set-cookie',''), 'A stale long poll could erase a newly issued Q-ID cookie')
                stage = 'privacy and shared data'
                checked(alice.delete(f"/api/qmessage/messages/{photo_message['id']}"))
                require(bob.get(attachment['url']).status_code == 404, 'Deleted photo remains accessible')
                with closing(sqlite3.connect(database)) as db:
                    require(db.execute('SELECT COUNT(*) FROM users').fetchone() == (4,), 'Messenger created a separate identity store')
                    require(db.execute('SELECT content FROM notes').fetchone() == ('Existing personal learning note',), 'Messenger changed existing study data')
                    require(db.execute('PRAGMA integrity_check').fetchone() == ('ok',) and not db.execute('PRAGMA foreign_key_check').fetchall(), 'Shared database integrity failed')
                    audit = db.execute("SELECT fields_json,metadata_json FROM audit_logs WHERE action LIKE 'qmessage.%'").fetchall()
                    require(all('Привет' not in ''.join(row) for row in audit), 'Audit log captured private correspondence')
            finally:
                stop_child(site); stop_child(api)
        print('PASS: QMessage through production BFF; common Q-ID, Unicode people search, private direct conversation, live delivery, idempotent retries, read receipts, replies/edit/reaction/search/stickers, private photos, restart/history/event durability, blocks/reports/moderation/bans/catalog/settings, CSRF and outsider boundaries, preserved shared data. Disposable accounts only.')
        return 0
    except Exception as error:
        print('FAIL [' + stage + ']: ' + (str(error) if isinstance(error, StackFailure) else type(error).__name__))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
