"""Real temporary queue/SQLite checks for legacy tools using a group's syllabus."""
import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")
from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth import get_current_user
from app.database import Base, get_db
from app.job_models import AIJob
from app.models import (Course, CurriculumWeek, ExamSession, Flashcard, Lecture,
    ModuleWork, Note, StudentGroup, Subject, Task, Topic, User)
from app.routers import cards, exam, lectures, tasks
from app.services import background


class LearningToolsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine('sqlite:///' + str(Path(self.temp.name) / 'tools.db'),
            connect_args={'check_same_thread': False})
        @event.listens_for(self.engine, 'connect')
        def keys(connection, _):
            connection.execute('PRAGMA foreign_keys=ON')
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.queue_patch = patch.object(background, 'SessionLocal', self.sessions)
        self.queue_patch.start()
        with self.sessions() as db:
            group, other = StudentGroup(name='Our group'), StudentGroup(name='Other group')
            db.add_all([group, other]); db.flush()
            self.user = User(email='owner@fixture.local', hashed_password='unused', group_id=group.id)
            self.peer = User(email='peer@fixture.local', hashed_password='unused', group_id=other.id)
            db.add_all([self.user, self.peer]); db.flush()
            course = Course(group_id=group.id, title='Алгоритмы')
            foreign = Course(group_id=other.id, title='Чужая дисциплина')
            subject = Subject(name='Личный предмет')
            db.add_all([course, foreign, subject]); db.flush()
            topic = Topic(subject_id=subject.id, title='Личная тема')
            db.add(topic); db.flush()
            first = CurriculumWeek(course_id=course.id, week_number=1, title='Сортировка',
                module='Модуль 1', content='SOURCE_M1_CONTENT')
            second = CurriculumWeek(course_id=course.id, week_number=8, title='Сети',
                module='Модуль 2', content='FORBIDDEN_M2_CONTENT')
            work = ModuleWork(course_id=course.id, title='Практика сортировки', module='Модуль 1',
                week_number=1, description='SOURCE_WORK_ONLY')
            db.add_all([first, second, work,
                CurriculumWeek(course_id=foreign.id, week_number=1, title='Чужая тема'),
                Note(user_id=self.user.id, subject_id=subject.id, topic_id=topic.id,
                     title='Private note', content='PRIVATE_NOTE_NOT_FOR_SEARCH')]); db.commit()
            self.course, self.foreign, self.week, self.work = course.id, foreign.id, first.id, work.id
            self.subject, self.topic = subject.id, topic.id
        self.actor = self.user
        app = FastAPI()
        for router in (tasks, cards, exam, lectures):
            app.include_router(router.router, prefix='/api')
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.queue_patch.stop()
        self.engine.dispose()
        self.temp.cleanup()

    async def wait_job(self, identifier, user_id):
        try:
            await background.process_one_job()
        except asyncio.CancelledError:
            raise HTTPException(502, 'Interrupted fixture')
        with self.sessions() as db:
            job = db.get(AIJob, identifier)
            if job.status != 'done':
                raise HTTPException(502, job.error or job.status)
            return json.loads(job.result_json)

    def selection(self, **changes):
        return {'course_id': self.course, 'module': 'Модуль 1', **changes}

    def generated(self, kind, body=None):
        endpoint = {'tasks': '/tasks/generate', 'cards': '/cards/generate',
                    'exam': '/exam/start', 'lecture': '/lectures/generate'}[kind]
        raw = {'tasks': '[{"question":"Q","answer":"A","hint":"H"}]',
               'cards': '[{"front":"Q","back":"A"}]',
               'exam': '[{"question":"Q","reference":"A"}]',
               'lecture': '# Учебная лекция\nОбъяснение выбранной темы.'}[kind]
        router = {'tasks': tasks, 'cards': cards, 'exam': exam, 'lecture': lectures}[kind]
        with patch.object(router, 'generate_content', AsyncMock(return_value=raw)) as provider, \
                patch.object(background, 'await_job_result', self.wait_job):
            response = self.client.post('/api' + endpoint, json=body or self.selection())
            if kind == 'lecture' and response.status_code == 200:
                asyncio.run(background.process_one_job())
            return response, provider

    def test_all_four_tools_generate_from_exact_module_without_personal_or_foreign_data(self):
        for kind, model in [('tasks', Task), ('cards', Flashcard), ('exam', ExamSession), ('lecture', Lecture)]:
            with self.subTest(kind=kind):
                response, provider = self.generated(kind)
                self.assertEqual(response.status_code, 200, response.text)
                prompt = provider.call_args.args[0]
                self.assertIn('SOURCE_M1_CONTENT', prompt)
                self.assertNotIn('FORBIDDEN_M2_CONTENT', prompt)
                self.assertNotIn('PRIVATE_NOTE_NOT_FOR_SEARCH', prompt)
                with self.sessions() as db:
                    item = db.query(model).filter(model.user_id == self.user.id).order_by(model.id.desc()).first()
                    source = json.loads(item.source_context_json)
                    self.assertEqual((source['course_id'], source['module']), (self.course, 'Модуль 1'))
                    self.assertEqual(source['research']['status'], 'disabled')
                    self.assertNotIn('SOURCE_M1_CONTENT', json.dumps(source))

    def test_work_selection_excludes_week_body_and_other_module(self):
        response, provider = self.generated('tasks', self.selection(work_ids=[self.work]))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('SOURCE_WORK_ONLY', provider.call_args.args[0])
        self.assertNotIn('SOURCE_M1_CONTENT', provider.call_args.args[0])

    def test_cross_group_and_mixed_sources_fail_before_any_provider_or_job(self):
        for endpoint in ['/tasks/generate', '/cards/generate', '/exam/start', '/lectures/generate']:
            response = self.client.post('/api' + endpoint, json={'course_id': self.foreign})
            self.assertEqual(response.status_code, 403, response.text)
        response = self.client.post('/api/tasks/generate', json=self.selection(subject_id=self.subject))
        self.assertEqual(response.status_code, 422, response.text)
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).count(), 0)

    def test_changed_program_during_generation_cannot_publish_stale_card(self):
        async def mutate(*args, **kwargs):
            with self.sessions() as db:
                db.get(CurriculumWeek, self.week).content = 'NEW_ADMIN_CONTENT'
                db.commit()
            return '[{"front":"Q","back":"A"}]'
        with patch.object(cards, 'generate_content', side_effect=mutate), \
                patch.object(background, 'await_job_result', self.wait_job):
            response = self.client.post('/api/cards/generate', json=self.selection())
        self.assertEqual(response.status_code, 502, response.text)
        with self.sessions() as db:
            self.assertEqual(db.query(Flashcard).count(), 0)
            self.assertEqual(db.query(AIJob).one().status, 'error')

    def test_queued_lecture_revokes_access_when_student_leaves_group(self):
        response = self.client.post('/api/lectures/generate', json=self.selection())
        with self.sessions() as db:
            db.get(User, self.user.id).group_id = self.peer.group_id
            db.commit()
        with patch.object(lectures, 'generate_content', AsyncMock()) as provider:
            asyncio.run(background.process_one_job())
        provider.assert_not_awaited()
        with self.sessions() as db:
            self.assertEqual(db.get(AIJob, response.json()['job_id']).status, 'error')
            self.assertEqual(db.get(Lecture, response.json()['lecture_id']).content, '')

    def test_grounded_card_restarts_from_checkpoint_with_one_research_and_one_generation(self):
        research = {'status': 'verified', 'checked_at': '2026-10-11T00:00:00+00:00',
            'sources': [{'title': 'Python docs', 'url': 'https://docs.python.org/3/howto/sorting.html'}],
            'warnings': [], 'search_suggestions_html': ''}
        async def raw_response(*args, **kwargs):
            return {'candidates': [{'content': {'parts': [{'text': '[{"front":"Q","back":"A"}]'}]}}]}
        with patch.object(background, 'await_job_result', self.wait_job), \
             patch('app.services.web_research.research_public_topic', AsyncMock(return_value=('Public theory', research))) as search, \
             patch('app.services.ai._post_gemini', side_effect=raw_response) as provider, \
             patch.object(background.JobContext, 'complete', side_effect=asyncio.CancelledError):
            response = self.client.post('/api/cards/generate', json=self.selection(use_web=True))
        self.assertEqual(response.status_code, 502)
        with self.sessions() as db:
            self.assertEqual(db.query(Flashcard).count(), 0)
            job = db.query(AIJob).one()
            self.assertEqual(job.status, 'queued')
            self.assertIn('learning_raw', json.loads(job.checkpoint_json))
        with patch('app.services.web_research.research_public_topic', AsyncMock(side_effect=AssertionError('Research already saved'))), \
             patch('app.services.ai._post_gemini', AsyncMock(side_effect=AssertionError('Answer already saved'))):
            asyncio.run(background.process_one_job())
        self.assertEqual(provider.call_count, 1)
        self.assertEqual(search.await_count, 1)
        with self.sessions() as db:
            card = db.query(Flashcard).one()
            self.assertEqual(json.loads(card.source_context_json)['research']['sources'], research['sources'])
            self.assertEqual(db.query(AIJob).one().status, 'done')

    def test_legacy_personal_tools_still_work_and_keep_own_notes(self):
        response, provider = self.generated('tasks', {'subject_id': self.subject, 'topic_id': self.topic})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('PRIVATE_NOTE_NOT_FOR_SEARCH', provider.call_args.args[0])
        self.assertNotIn('SOURCE_M1_CONTENT', provider.call_args.args[0])

    def test_all_topics_personal_selection_keeps_the_known_program(self):
        with self.sessions() as db:
            db.add(Topic(subject_id=self.subject, title='Additional known topic'))
            db.commit()
        response, provider = self.generated('exam', {'subject_ids': [self.subject]})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn('Additional known topic', provider.call_args.args[0])
        self.assertIn('Личная тема', provider.call_args.args[0])

    def test_identical_active_requests_ignore_different_provenance_timestamps(self):
        for endpoint in ['/tasks/generate', '/cards/generate']:
            with self.subTest(endpoint=endpoint):
                with patch.object(background, 'await_job_result',
                    AsyncMock(side_effect=HTTPException(503, 'Still queued'))):
                    first = self.client.post('/api' + endpoint, json=self.selection())
                    second = self.client.post('/api' + endpoint, json=self.selection())
                self.assertEqual(first.status_code, 503, first.text)
                self.assertEqual(second.status_code, 409, second.text)
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).count(), 2)

    def test_course_lecture_crud_is_personal_and_blocks_edits_during_generation(self):
        response = self.client.post('/api/lectures/generate', json=self.selection())
        identifier = response.json()['lecture_id']
        self.assertEqual(self.client.patch(f'/api/lectures/{identifier}', json={'content': 'Edit'}).status_code, 409)
        with patch.object(lectures, 'generate_content', AsyncMock(return_value='# Original')):
            asyncio.run(background.process_one_job())
        self.actor = self.peer
        self.assertEqual(self.client.get(f'/api/lectures/{identifier}').status_code, 404)
        self.assertEqual(self.client.delete(f'/api/lectures/{identifier}').status_code, 404)
        self.actor = self.user
        self.assertEqual(self.client.patch(f'/api/lectures/{identifier}', json={'content': '# Edited'}).status_code, 200)
        self.assertEqual(self.client.get(f'/api/lectures/{identifier}').json()['content'], '# Edited')
        self.assertEqual(self.client.delete(f'/api/lectures/{identifier}').status_code, 200)


if __name__ == '__main__':
    unittest.main()
