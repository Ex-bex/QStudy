"""Authentication, authorization, ownership and migration regression tests."""
import os
os.environ.setdefault('SECRET_KEY', 'test-only-qstudy-secret-key-32-characters-long')
import tempfile
import unittest
import asyncio
from pathlib import Path
from unittest.mock import patch, AsyncMock
from datetime import datetime, timedelta, timezone
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
import jwt
from app.auth import create_access_token, hash_password
from app.config import settings
from app.database import Base, get_db
from app.models import User, StudentGroup, Note, ChatSession, ChatMessage, Course, CurriculumWeek, WeekProgress, ModuleWork, WorkSubmission
from app.routers import auth_routes, admin, subjects, notes, tasks, cards, files, chat, lectures, tests, exam
from app.security import _attempts, rate_limit, BodySizeLimitMiddleware
from app.services.ai import AIError
from app.services import background
from app.job_models import AIJob


class SecurityApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = 'Password-test-1950'
        cls.password_hash = hash_password(cls.password)

    def setUp(self):
        self.engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        @event.listens_for(self.engine, 'connect')
        def foreign_keys(connection, record):
            connection.execute('PRAGMA foreign_keys=ON')
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            group = StudentGroup(name='ИП-26-3кс')
            db.add(group)
            db.flush()
            self.group_id = group.id
            people = [User(email=email, name=role, hashed_password=self.password_hash, role=role, group_id=group.id)
                      for email, role in (('admin@example.com', 'admin'), ('student@example.com', 'student'), ('peer@example.com', 'student'))]
            db.add_all(people)
            db.commit()
            self.admin_id, self.student_id, self.peer_id = [u.id for u in people]
        self.temp = tempfile.TemporaryDirectory()
        self.previous_upload = settings.UPLOAD_DIR
        settings.UPLOAD_DIR = self.temp.name
        _attempts.clear()
        app = FastAPI()
        for module in (auth_routes, admin, subjects, notes, tasks, cards, files, chat, lectures, tests, exam):
            app.include_router(module.router, prefix='/api')
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app)
        self.as_user(self.student_id)

    def tearDown(self):
        self.client.close()
        settings.UPLOAD_DIR = self.previous_upload
        self.engine.dispose()
        self.temp.cleanup()
        _attempts.clear()

    def as_user(self, user_id, version=0):
        self.client.headers['Authorization'] = 'Bearer ' + create_access_token(user_id, version)

    def create_subject(self):
        self.as_user(self.admin_id)
        result = self.client.post('/api/subjects', json={'name': 'Математика'})
        self.assertEqual(result.status_code, 201, result.text)
        self.as_user(self.student_id)
        return result.json()['id']

    def test_registration_and_invalid_tokens(self):
        data = {'email': 'NEW@example.com', 'password': self.password, 'name': 'Новый'}
        self.assertEqual(self.client.post('/api/auth/register', json={**data, 'role': 'admin'}).status_code, 422)
        result = self.client.post('/api/auth/register', json=data)
        self.assertEqual(result.status_code, 201, result.text)
        self.assertEqual(result.json()['role'], 'student')
        self.assertEqual(result.json()['email'], 'new@example.com')
        self.assertEqual(result.json()['group_id'], self.group_id)
        self.assertNotIn('hashed_password', result.json())
        self.assertEqual(self.client.post('/api/auth/register', json=data).status_code, 409)
        self.assertEqual(self.client.post('/api/auth/register', json={**data, 'password': 'short'}).status_code, 422)
        for payload in ({'sub': 'not-an-id', 'ver': 0}, {'sub': str(self.student_id), 'ver': None},
                        {'sub': str(self.student_id), 'ver': 0, 'aud': 'another-app'},
                        {'sub': str(self.student_id), 'ver': 0, 'exp': datetime.now(timezone.utc) - timedelta(minutes=1)}):
            claims = {'iss': 'qstudy', 'aud': 'qstudy-web', 'iat': datetime.now(timezone.utc), 'exp': datetime.now(timezone.utc) + timedelta(minutes=5), **payload}
            self.client.headers['Authorization'] = 'Bearer ' + jwt.encode(claims, settings.SECRET_KEY, algorithm='HS256')
            self.assertEqual(self.client.get('/api/auth/me').status_code, 401)

    def test_student_cannot_manage_global_content_or_accounts(self):
        sid = self.create_subject()
        self.assertEqual(self.client.get('/api/subjects').json()[0]['id'], sid)
        for method, path, data in (('post', '/api/subjects', {'name': 'Hack'}), ('patch', f'/api/subjects/{sid}', {'name': 'Hack'}), ('delete', f'/api/subjects/{sid}', None), ('get', '/api/admin/users', None)):
            response = self.client.request(method, path, json=data)
            self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(self.client.patch('/api/auth/me', json={'name': 'H', 'role': 'admin'}).status_code, 422)
        self.assertEqual(self.client.patch('/api/auth/me', json={'name': 'H', 'group_id': 900}).status_code, 422)

    def test_jwt_rejects_algorithm_switch_even_with_correct_signing_secret(self):
        claims = {'sub': str(self.student_id), 'ver': 0, 'iss': 'qstudy', 'aud': 'qstudy-web',
                  'iat': datetime.now(timezone.utc), 'exp': datetime.now(timezone.utc) + timedelta(minutes=5)}
        self.client.headers['Authorization'] = 'Bearer ' + jwt.encode(claims, settings.SECRET_KEY, algorithm='HS384')
        self.assertEqual(self.client.get('/api/auth/me').status_code, 401)

    def test_personal_records_owner_scope_and_relations(self):
        sid = self.create_subject()
        note = self.client.post('/api/notes', json={'title': 'Личная заметка', 'subject_id': sid}).json()
        task = self.client.post('/api/tasks', json={'question': 'Вопрос'}).json()
        card = self.client.post('/api/cards', json={'front': 'Вопрос', 'back': 'Ответ'}).json()
        session = self.client.post('/api/chat/sessions', json={'title': 'Чат'}).json()
        self.as_user(self.peer_id)
        self.assertEqual(self.client.get('/api/notes').json(), [])
        for path, data in ((f"/api/notes/{note['id']}", {'title': 'Чужая'}), (f"/api/tasks/{task['id']}", {'question': 'Чужая'}), (f"/api/cards/{card['id']}", {'front': 'Чужая', 'back': 'Чужая'}), (f"/api/chat/sessions/{session['id']}", {'title': 'Чужая'})):
            self.assertEqual(self.client.patch(path, json=data).status_code, 404)
            self.assertEqual(self.client.delete(path).status_code, 404)
        self.assertEqual(self.client.post('/api/notes', json={'subject_id': 9999}).status_code, 404)
        self.assertEqual(self.client.post('/api/tasks/generate', json={'subject_id': sid, 'topic_id': 9999}).status_code, 404)

    def test_password_reset_disable_logout_revoke(self):
        result = self.client.post('/api/auth/password', json={'current_password': self.password, 'new_password': 'Updated-password-2026'})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(self.client.get('/api/auth/me').status_code, 401)
        self.client.headers['Authorization'] = 'Bearer ' + result.json()['access_token']
        self.assertEqual(self.client.get('/api/auth/me').status_code, 200)
        self.assertEqual(self.client.post('/api/auth/logout').status_code, 200)
        self.assertEqual(self.client.get('/api/auth/me').status_code, 401)
        self.as_user(self.admin_id)
        self.assertEqual(self.client.post(f'/api/admin/users/{self.student_id}/password', json={'password': self.password}).status_code, 200)
        self.assertEqual(self.client.patch(f'/api/admin/users/{self.student_id}', json={'is_active': False}).status_code, 200)
        self.client.headers.pop('Authorization')
        self.assertEqual(self.client.post('/api/auth/login', data={'username': 'student@example.com', 'password': self.password}).status_code, 401)

    def test_admin_lockout_and_account_deletion_cleanup(self):
        with self.sessions() as db:
            course = Course(group_id=self.group_id, title='Курс')
            db.add(course)
            db.flush()
            week = CurriculumWeek(course_id=course.id, week_number=1, title='Тема')
            work = ModuleWork(course_id=course.id, title='Работа')
            session = ChatSession(user_id=self.student_id, title='Чат')
            db.add_all([week, work, session])
            db.flush()
            db.add_all([WeekProgress(user_id=self.student_id, week_id=week.id), WorkSubmission(user_id=self.student_id, work_id=work.id), ChatMessage(session_id=session.id, role='user', content='private')])
            db.commit()
        self.as_user(self.admin_id)
        self.assertEqual(self.client.delete(f'/api/admin/users/{self.admin_id}').status_code, 409)
        self.assertEqual(self.client.patch(f'/api/admin/users/{self.admin_id}', json={'role': 'student'}).status_code, 409)
        self.assertEqual(self.client.patch(f'/api/admin/users/{self.admin_id}', json={'is_active': False}).status_code, 409)
        response = self.client.delete(f'/api/admin/users/{self.student_id}')
        self.assertEqual(response.status_code, 200, response.text)
        with self.sessions() as db:
            self.assertEqual(db.query(WeekProgress).count(), 0)
            self.assertEqual(db.query(WorkSubmission).count(), 0)
            self.assertEqual(db.query(ChatMessage).count(), 0)
            self.assertEqual(db.query(Course).count(), 1)
        self.assertEqual(self.client.post('/api/admin/users', json={'email': 'created@example.com', 'password': self.password}).status_code, 201)
        self.assertEqual(self.client.get('/api/admin/stats').status_code, 200)

    def test_private_upload_validation(self):
        for name, data in (('file.pdf', b''), ('file.pdf', b'not a PDF'), ('file.exe', b'bad')):
            response = self.client.post('/api/files/upload', files={'file': (name, data)})
            self.assertEqual(response.status_code, 400, response.text)
        result = self.client.post('/api/files/upload', files={'file': ('../../private.txt', b'hello')})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()['filename'], 'private.txt')
        self.assertNotIn('filepath', result.json())
        file_id = result.json()['id']
        self.as_user(self.peer_id)
        self.assertEqual(self.client.get(f'/api/files/{file_id}/download').status_code, 404)
        self.assertEqual(self.client.delete(f'/api/files/{file_id}').status_code, 404)
        with patch.object(settings, 'MAX_UPLOAD_BYTES', 8):
            self.assertEqual(self.client.post('/api/files/upload', files={'file': ('big.txt', b'0123456789')}).status_code, 413)
        self.assertEqual(len(list(Path(self.temp.name).iterdir())), 1)

    def test_independent_lectures_and_chat_context(self):
        sid = self.create_subject()
        self.as_user(self.admin_id)
        topic = self.client.post(f'/api/subjects/{sid}/topics', json={'title': 'Общая тема'}).json()
        self.as_user(self.student_id)
        first = self.client.get(f"/api/lectures/topic/{topic['id']}")
        self.assertEqual(first.status_code, 200)
        self.as_user(self.peer_id)
        second = self.client.get(f"/api/lectures/topic/{topic['id']}")
        self.assertEqual(second.status_code, 200)
        self.assertNotEqual(first.json()['id'], second.json()['id'])
        self.as_user(self.student_id)
        self.client.post('/api/notes', json={'title': 'Производные', 'content': 'Производная синуса равна косинусу.'})
        with self.sessions() as db:
            db.add(Note(user_id=self.peer_id, title='Производные секрет', content='Private peer content'))
            db.commit()
        mocked = AsyncMock(return_value='Производная sin(x) — cos(x).')
        with patch('app.routers.chat.chat_completion', mocked):
            response = self.client.post('/api/chat/send', json={'message': 'Объясни производные'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('cos(x)', response.json()['assistant_message']['content'])
        self.assertIn('Производная синуса', mocked.call_args.args[0])
        self.assertNotIn('Private peer content', mocked.call_args.args[0])

    def test_rate_limit(self):
        for _ in range(3):
            rate_limit('test-only', 3, 60)
        with self.assertRaises(Exception) as raised:
            rate_limit('test-only', 3, 60)
        self.assertEqual(raised.exception.status_code, 429)

    def test_lecture_generation_persists_state_and_keeps_content_on_error(self):
        sid = self.create_subject()
        self.as_user(self.admin_id)
        topic = self.client.post(f'/api/subjects/{sid}/topics', json={'title': 'Тема'}).json()
        self.as_user(self.student_id)
        path = f"/api/lectures/topic/{topic['id']}"
        self.client.get(path)
        self.client.patch(path, json={'content': 'Существующий конспект'})
        response = self.client.post(path + '/generate')
        self.assertEqual(response.status_code, 200)
        job_id = response.json()['job_id']
        self.assertEqual(self.client.get(path).json()['status'], 'generating')
        self.assertEqual(self.client.patch(path, json={'content': 'Правка'}).status_code, 409)
        self.assertEqual(self.client.delete(path).status_code, 409)
        self.assertEqual(self.client.post(path + '/generate').status_code, 409)
        with patch('app.services.background.SessionLocal', self.sessions), patch('app.routers.lectures.generate_content', AsyncMock(side_effect=AIError('ИИ недоступен'))):
            for _ in range(3):
                with self.sessions() as db:
                    db.get(AIJob, job_id).available_at = datetime.utcnow()
                    db.commit()
                asyncio.run(background.process_one_job())
        result = self.client.get(path).json()
        self.assertEqual(result['status'], 'error')
        self.assertEqual(result['content'], 'Существующий конспект')
        self.assertEqual(self.client.post(path + '/generate').status_code, 200)
        with patch('app.services.background.SessionLocal', self.sessions), patch('app.routers.lectures.generate_content', AsyncMock(return_value='Новая лекция')):
            asyncio.run(background.process_one_job())
        self.assertEqual(self.client.get(path).json()['status'], 'ready')
        self.assertEqual(self.client.get(path).json()['content'], 'Новая лекция')

    def test_chunked_request_size_limit(self):
        app = FastAPI()
        app.add_middleware(BodySizeLimitMiddleware)
        @app.post('/body')
        async def body(request: Request):
            return {'size': len(await request.body())}
        with TestClient(app) as client:
            response = client.post('/body', content=iter([b'x' * 600000, b'x' * 600000]))
        self.assertEqual(response.status_code, 413)

    def test_non_destructive_migrations(self):
        from app import main
        old_engine = create_engine('sqlite://', connect_args={'check_same_thread': False}, poolclass=StaticPool)
        with old_engine.begin() as conn:
            conn.execute(text('CREATE TABLE users (id INTEGER PRIMARY KEY, email VARCHAR, hashed_password VARCHAR, created_at DATETIME)'))
            conn.execute(text("INSERT INTO users VALUES (1,'old@example.com','old-hash',NULL)"))
            conn.execute(text('CREATE TABLE lectures (id INTEGER PRIMARY KEY, user_id INTEGER, topic_id INTEGER UNIQUE, content TEXT, status VARCHAR, materials_hash VARCHAR, created_at DATETIME, updated_at DATETIME)'))
            conn.execute(text("INSERT INTO lectures VALUES (1,1,1,'preserved','ready','',NULL,NULL)"))
        with patch.object(main, 'engine', old_engine), patch.object(main, 'SessionLocal', sessionmaker(bind=old_engine)):
            main.initialize_database()
            main.initialize_database()
        with old_engine.connect() as conn:
            self.assertEqual(conn.execute(text('SELECT role FROM users WHERE id=1')).scalar(), 'student')
            self.assertEqual(conn.execute(text('SELECT content FROM lectures WHERE id=1')).scalar(), 'preserved')
            conn.execute(text("INSERT INTO lectures (id,user_id,topic_id,content) VALUES (2,2,1,'second')"))
        old_engine.dispose()


if __name__ == '__main__':
    unittest.main()
