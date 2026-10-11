"""Group curriculum scope, durable test generation and provenance migrations."""
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker

from app.auth import get_current_user
from app.database import Base, get_db
from app.job_models import AIJob
from app.models import (Course, CurriculumWeek, ModuleWork, Note, StudentGroup, Subject,
    SyllabusDocument, TestQuestion as QuizQuestion, TestSession as QuizSession, User, WorkSubmission)
from app.routers import learning, tests
from app.services import background
from app.services.learning_context import (LearningSelection, MAX_LEARNING_CONTEXT,
    build_learning_context, dump_learning_provenance, safe_learning_provenance,
    validate_current_learning_source)

RAW_QUESTIONS = json.dumps([{"question": "Generated question", "options": ["A", "B", "C", "D"],
                            "correct_index": 1, "explanation": "PRIVATE_GENERATED_ANSWER"}])


class LearningTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + str(Path(self.temp.name) / "learning.db"),
                                    connect_args={"check_same_thread": False})

        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False, autoflush=False)
        self.background_patch = patch.object(background, "SessionLocal", self.sessions)
        self.background_patch.start()
        with self.sessions() as db:
            own = StudentGroup(name="OWN_GROUP_PRIVATE_CODE")
            other = StudentGroup(name="FOREIGN_GROUP")
            db.add_all([own, other]); db.flush()
            self.student = User(email="student@learning.test", role="student", hashed_password="unused", group_id=own.id)
            self.admin = User(email="admin@learning.test", role="admin", hashed_password="unused")
            self.peer = User(email="peer@learning.test", role="student", hashed_password="unused", group_id=own.id)
            db.add_all([self.student, self.admin, self.peer]); db.flush()
            course = Course(group_id=own.id, title="Programming", teacher="PRIVATE_TEACHER", description="OTHER_MODULE_DESCRIPTION")
            foreign = Course(group_id=other.id, title="FOREIGN_COURSE")
            draft_only = Course(group_id=own.id, title="DRAFT_ONLY_COURSE")
            empty = Course(group_id=own.id, title="EMPTY_COURSE")
            works_only = Course(group_id=own.id, title="Independent projects")
            db.add_all([course, foreign, draft_only, empty, works_only]); db.flush()
            published = SyllabusDocument(course_id=course.id, title="Published syllabus", filename="published.pdf",
                filepath="unused", size=1, status="published", extracted_text="RAW_PDF_PRIVATE_SENTINEL", source_sha256="publishedhash")
            draft = SyllabusDocument(course_id=course.id, title="DRAFT_PRIVATE_SYLLABUS", filename="draft.pdf",
                filepath="unused", size=1, status="review", extracted_text="UNPUBLISHED_PRIVATE_SENTINEL")
            only_source = SyllabusDocument(course_id=draft_only.id, title="Draft only", filename="only.pdf", filepath="unused", size=1, status="review")
            db.add_all([published, draft, only_source]); db.flush()
            week1 = CurriculumWeek(course_id=course.id, week_number=1, module="Module 1", title="Variables", content="THEORY_MODULE_ONE", tasks="ASSIGNMENT_MODULE_ONE", source_syllabus_id=published.id)
            week2 = CurriculumWeek(course_id=course.id, week_number=2, module="Module 2", title="OTHER_MODULE_TITLE", content="OTHER_MODULE_PRIVATE", source_syllabus_id=published.id)
            week3 = CurriculumWeek(course_id=course.id, week_number=3, module="Module 1", title="UNPUBLISHED_TITLE", content="UNPUBLISHED_CONTENT", source_syllabus_id=draft.id)
            week4 = CurriculumWeek(course_id=course.id, week_number=4, module="Module 1", title="Manual topic", content="ADMIN_MANUAL_CONTENT")
            db.add_all([week1, week2, week3, week4,
                CurriculumWeek(course_id=draft_only.id, week_number=1, title="HIDDEN_DRAFT_ONLY", source_syllabus_id=only_source.id),
                CurriculumWeek(course_id=foreign.id, week_number=1, title="FOREIGN_WEEK")]); db.flush()
            work1 = ModuleWork(course_id=course.id, title="Variable practice", module="Module 1", week_number=1, description="SELECTED_WORK_CONTENT", source_syllabus_id=published.id)
            work2 = ModuleWork(course_id=course.id, title="OTHER_WORK_TITLE", module="Module 2", week_number=2, description="OTHER_WORK_CONTENT", source_syllabus_id=published.id)
            hidden = ModuleWork(course_id=course.id, title="HIDDEN_WORK", module="Module 1", week_number=1, source_syllabus_id=draft.id)
            project = ModuleWork(course_id=works_only.id, title="Project", module="Final", description="PROJECT_CONTENT")
            db.add_all([work1, work2, hidden, project]); db.flush()
            db.add(WorkSubmission(work_id=work1.id, user_id=self.student.id, content="STUDENT_PRIVATE_ANSWER"))
            subject = Subject(name="Personal subject"); db.add(subject); db.flush()
            db.add_all([Note(user_id=self.student.id, subject_id=subject.id, title="Own note", content="OWN_PERSONAL_NOTE"),
                        Note(user_id=self.peer.id, subject_id=subject.id, title="Peer note", content="PEER_PRIVATE_NOTE")])
            db.commit()
            self.course, self.foreign, self.draft_only, self.empty, self.works_only = course.id, foreign.id, draft_only.id, empty.id, works_only.id
            self.group, self.other_group = own.id, other.id
            self.week1, self.week2, self.week3, self.week4 = week1.id, week2.id, week3.id, week4.id
            self.work1, self.work2, self.hidden_work, self.project = work1.id, work2.id, hidden.id, project.id
            self.published, self.draft, self.subject = published.id, draft.id, subject.id
        self.actor = self.student
        app = FastAPI()
        app.include_router(learning.router, prefix="/api")
        app.include_router(tests.router, prefix="/api")

        def database():
            with self.sessions() as db:
                yield db

        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)

    async def asyncTearDown(self):
        self.client.close()
        self.background_patch.stop()
        self.engine.dispose()
        self.temp.cleanup()

    def build(self, **selection):
        with self.sessions() as db:
            return build_learning_context(db, self.actor, {"course_id": self.course, **selection})

    def start(self, **selection):
        response = self.client.post("/api/tests/start", json={"course_id": self.course, "module": "Module 1", "count": 1, **selection})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["job_id"]

    async def test_selection_is_strict_and_does_not_guess_modules_or_scopes(self):
        for selection in ({"course_id": True}, {"course_id": "1"}, {"week_numbers": [True]},
                          {"course_id": self.course, "week_numbers": [1, 1]}, {"course_id": self.course, "week_numbers": [53]},
                          {"course_id": self.course, "work_ids": [1, 1]}, {"course_id": self.course, "work_ids": [0]},
                          {"course_id": self.course, "use_web": "true"}, {"module": "Module 1"}, {"role": "admin"}):
            with self.subTest(selection=selection), self.assertRaises(ValueError):
                LearningSelection.model_validate(selection)
        for selection, status in (({"module": "1"}, 422), ({"module": "Module 1", "week_numbers": [2]}, 422),
                                  ({"week_numbers": [3]}, 422), ({"work_ids": [self.hidden_work]}, 422),
                                  ({"module": "Module 1", "work_ids": [self.work2]}, 422),
                                  ({"course_id": self.empty}, 422), ({"course_id": self.foreign}, 403)):
            with self.subTest(selection=selection), self.assertRaises(HTTPException) as failure:
                self.build(**selection)
            self.assertEqual(failure.exception.status_code, status)
        response = self.client.post("/api/tests/start", json={"course_id": self.course, "subject_ids": [self.subject]})
        self.assertEqual(response.status_code, 422)
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).count(), 0)

    async def test_module_context_excludes_other_modules_raw_documents_and_all_personal_content(self):
        source = self.build(module="Module 1")
        for expected in ("Variables", "THEORY_MODULE_ONE", "ADMIN_MANUAL_CONTENT", "SELECTED_WORK_CONTENT"):
            self.assertIn(expected, source.text)
        for forbidden in ("OTHER_MODULE", "OTHER_WORK", "UNPUBLISHED", "RAW_PDF", "PERSONAL_NOTE", "STUDENT_PRIVATE", "PEER_PRIVATE"):
            self.assertNotIn(forbidden, source.text)
        self.assertNotIn("PRIVATE_TEACHER", source.public_query)
        self.assertNotIn("OWN_GROUP_PRIVATE_CODE", source.public_query)
        self.assertNotIn("SELECTED_WORK_CONTENT", source.public_query)
        self.assertEqual(source.provenance["week_numbers"], [1, 4])
        self.assertEqual(source.provenance["work_ids"], [self.work1])
        self.assertEqual(source.provenance["syllabi"], [{"id": self.published, "title": "Published syllabus"}])

    async def test_work_and_week_intersections_are_exact_including_work_only_courses(self):
        source = self.build(module="Module 1", week_numbers=[1], work_ids=[self.work1])
        self.assertIn("SELECTED_WORK_CONTENT", source.text)
        self.assertNotIn("THEORY_MODULE_ONE", source.text)
        self.assertNotIn("ADMIN_MANUAL_CONTENT", source.text)
        self.assertEqual(source.provenance["weeks"], [])
        source = self.build(week_numbers=[1])
        self.assertIn("THEORY_MODULE_ONE", source.text)
        self.assertNotIn("ADMIN_MANUAL_CONTENT", source.text)
        project = self.build(course_id=self.works_only, module="Final", work_ids=[self.project])
        self.assertIn("PROJECT_CONTENT", project.text)
        self.assertEqual(project.provenance["week_numbers"], [])

    async def test_options_only_show_accessible_published_or_manual_curriculum(self):
        response = self.client.get("/api/learning/options")
        self.assertEqual(response.status_code, 200)
        courses = {course["id"]: course for course in response.json()["courses"]}
        self.assertEqual(set(courses), {self.course, self.works_only})
        self.assertEqual(courses[self.course]["modules"], ["Module 1", "Module 2"])
        self.assertEqual([week["week_number"] for week in courses[self.course]["weeks"]], [1, 2, 4])
        self.assertNotIn("HIDDEN_WORK", response.text)
        self.actor = self.admin
        self.assertIn(self.foreign, {course["id"] for course in self.client.get("/api/learning/options").json()["courses"]})
        self.actor = self.student
        with self.sessions() as db:
            db.get(User, self.student.id).group_id = None; db.commit()
        self.assertEqual(self.client.get("/api/learning/options").json(), {"courses": []})

    async def test_bounded_context_keeps_all_selected_titles_and_redacts_access_lines(self):
        with self.sessions() as db:
            for identifier in (self.week1, self.week4):
                db.get(CurriculumWeek, identifier).content = "пароль: ACCESS_SENTINEL\n" + "Учебное содержание. " * 1000
            db.commit()
        source = self.build(module="Module 1")
        self.assertLessEqual(len(source.text), MAX_LEARNING_CONTEXT)
        self.assertIn("Variables", source.text)
        self.assertIn("Manual topic", source.text)
        self.assertIn("Variable practice", source.text)
        self.assertNotIn("ACCESS_SENTINEL", source.text)

    async def test_current_source_detects_edits_deletions_unpublication_and_membership_change(self):
        initial = self.build(module="Module 1")
        with self.sessions() as db:
            db.get(CurriculumWeek, self.week1).tasks = "Changed requirement"; db.commit()
        with self.sessions() as db, self.assertRaises(HTTPException) as failure:
            validate_current_learning_source(db, self.student, {"course_id": self.course, "module": "Module 1"}, initial.fingerprint)
        self.assertEqual(failure.exception.status_code, 409)
        with self.sessions() as db:
            db.get(SyllabusDocument, self.published).status = "review"; db.commit()
        source = self.build(module="Module 1")
        self.assertNotIn("Variables", source.text)
        self.assertEqual(source.provenance["work_ids"], [])
        with self.sessions() as db:
            db.get(User, self.student.id).group_id = self.other_group; db.commit()
        with self.assertRaises(HTTPException) as failure:
            self.build()
        self.assertEqual(failure.exception.status_code, 403)

    async def test_safe_public_provenance_discards_private_fields_and_unsafe_links(self):
        source = self.build(module="Module 1").provenance
        source["prompt"] = "PROMPT_SENTINEL"
        source["weeks"][0]["tasks"] = "TASK_BODY_SENTINEL"
        source["research"] = {"status": "verified", "checked_at": "2026-10-11T00:00:00Z",
            "sources": [{"title": "Safe docs", "url": "https://docs.python.org/3/"},
                        {"title": "Private", "url": "http://127.0.0.1/private"}],
            "warnings": [], "research_context": "RESEARCH_PRIVATE_SENTINEL"}
        encoded = dump_learning_provenance(source)
        for secret in ("PROMPT_SENTINEL", "TASK_BODY_SENTINEL", "RESEARCH_PRIVATE_SENTINEL", "127.0.0.1"):
            self.assertNotIn(secret, encoded)
        self.assertEqual(safe_learning_provenance(encoded)["research"]["status"], "verified")
        self.assertEqual(len(safe_learning_provenance(encoded)["research"]["sources"]), 1)
        for malformed in ("{bad", "null", "[]", None, [1], {"prompt": "private"}):
            self.assertEqual(safe_learning_provenance(malformed), {})

    async def test_test_generation_uses_exact_course_scope_and_persists_public_sources(self):
        job_id = self.start()
        provider = AsyncMock(return_value=RAW_QUESTIONS)
        with patch.object(tests, "generate_content", provider):
            self.assertTrue(await background.process_one_job())
        prompt = provider.call_args.args[0]
        self.assertIn("THEORY_MODULE_ONE", prompt)
        self.assertNotIn("OTHER_MODULE", prompt)
        self.assertNotIn("OWN_PERSONAL_NOTE", prompt)
        with self.sessions() as db:
            job = db.get(AIJob, job_id)
            self.assertEqual(job.status, "done", job.error)
            session = db.query(QuizSession).one()
            identifier = session.id
            self.assertEqual(db.query(QuizQuestion).count(), 1)
            self.assertNotIn("PRIVATE_GENERATED_ANSWER", session.source_context_json)
        response = self.client.get(f"/api/tests/{identifier}")
        self.assertNotIn("correct_index", response.json()["questions"][0])
        self.assertEqual(response.json()["source_context"]["module"], "Module 1")
        self.assertEqual(response.json()["source_context"]["research"]["status"], "disabled")

    async def test_restart_reuses_raw_checkpoint_and_never_duplicates_questions(self):
        job_id = self.start()
        context, _ = background._claim_next()
        context.save_checkpoint({"raw": RAW_QUESTIONS})
        with self.sessions() as db:
            db.get(AIJob, job_id).lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
        self.engine.dispose()
        provider = AsyncMock(side_effect=AssertionError("Checkpoint must avoid repeated AI"))
        with patch.object(tests, "generate_content", provider):
            self.assertTrue(await background.process_one_job())
            self.assertFalse(await background.process_one_job())
        provider.assert_not_awaited()
        with self.sessions() as db:
            self.assertEqual(db.query(QuizQuestion).count(), 1)
            self.assertEqual(db.get(AIJob, job_id).status, "done")
            self.assertEqual(json.loads(db.query(QuizSession).one().source_context_json)["course_id"], self.course)

    async def test_membership_change_before_worker_cancels_without_provider_or_output(self):
        job_id = self.start()
        with self.sessions() as db:
            db.get(User, self.student.id).group_id = self.other_group; db.commit()
        provider = AsyncMock(return_value=RAW_QUESTIONS)
        with patch.object(tests, "generate_content", provider):
            self.assertTrue(await background.process_one_job())
        provider.assert_not_awaited()
        with self.sessions() as db:
            self.assertEqual(db.get(AIJob, job_id).status, "error")
            self.assertEqual(db.query(QuizSession).one().status, "error")
            self.assertEqual(db.query(QuizQuestion).count(), 0)

    async def test_source_change_during_provider_call_cannot_publish_stale_questions(self):
        job_id = self.start()

        async def edited_source(*args, **kwargs):
            with self.sessions() as db:
                db.get(CurriculumWeek, self.week1).content = "Updated source"; db.commit()
            return RAW_QUESTIONS

        with patch.object(tests, "generate_content", edited_source):
            await background.process_one_job()
        with self.sessions() as db:
            self.assertEqual(db.get(AIJob, job_id).status, "error")
            self.assertEqual(db.query(QuizQuestion).count(), 0)
            self.assertEqual(db.query(QuizSession).one().status, "error")

    async def test_online_uses_public_query_and_preserves_verified_research(self):
        self.start(use_web=True)
        research = {"status": "verified", "checked_at": "2026-10-11T00:00:00Z", "warnings": [],
                    "sources": [{"title": "Python documentation", "url": "https://docs.python.org/3/"}]}
        with patch("app.services.ai.generate_learning_content", AsyncMock(return_value=(RAW_QUESTIONS, research))) as provider:
            await background.process_one_job()
        self.assertTrue(provider.await_count)
        query = provider.call_args.kwargs["public_query"]
        self.assertIn("Programming", query)
        for private in ("PRIVATE_TEACHER", "OWN_GROUP", "ASSIGNMENT_MODULE_ONE", "OTHER_MODULE"):
            self.assertNotIn(private, query)
        with self.sessions() as db:
            context = safe_learning_provenance(db.query(QuizSession).one().source_context_json)
            self.assertEqual(context["research"]["status"], "verified")
            self.assertEqual(context["research"]["sources"][0]["url"], "https://docs.python.org/3/")

    async def test_legacy_personal_selection_keeps_ownership_and_old_worker_payload_supported(self):
        response = self.client.post("/api/tests/start", json={"subject_ids": [self.subject], "count": 1})
        self.assertEqual(response.status_code, 200, response.text)
        provider = AsyncMock(return_value=RAW_QUESTIONS)
        with patch.object(tests, "generate_content", provider):
            await background.process_one_job()
        self.assertIn("OWN_PERSONAL_NOTE", provider.call_args.args[0])
        self.assertNotIn("PEER_PRIVATE_NOTE", provider.call_args.args[0])
        with self.sessions() as db:
            session = QuizSession(user_id=self.student.id, status="generating", subject_ids_json=json.dumps([self.subject]))
            db.add(session); db.flush()
            job = background.enqueue_job(db, self.student.id, "test", "Legacy test", {"session_id": session.id,
                "subject_ids": [self.subject], "topic_ids": [], "count": 1, "prompt": "Legacy"}, f"test:{session.id}")
            db.commit(); job_id = job.id
        context, _ = background._claim_next(); context.save_checkpoint({"raw": RAW_QUESTIONS})
        with self.sessions() as db:
            db.get(AIJob, job_id).lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
        with patch.object(tests, "generate_content", AsyncMock(side_effect=AssertionError("Use old checkpoint"))):
            await background.process_one_job()
        with self.sessions() as db:
            self.assertEqual(db.query(QuizQuestion).count(), 2)
            self.assertEqual(db.get(AIJob, job_id).status, "done")

    async def test_additive_migration_preserves_existing_rows_and_legacy_lecture_upgrade(self):
        from app import main
        tables = ("test_sessions", "tasks", "flashcards", "exam_sessions", "lectures", "chat_messages")
        with self.engine.begin() as connection:
            for table in tables:
                connection.execute(text(f'ALTER TABLE "{table}" DROP COLUMN source_context_json'))
            connection.execute(text("DROP TABLE lectures"))
            connection.execute(text("CREATE TABLE lectures (id INTEGER PRIMARY KEY, user_id INTEGER, topic_id INTEGER UNIQUE, content TEXT, status VARCHAR, materials_hash VARCHAR, created_at DATETIME, updated_at DATETIME)"))
            connection.execute(text("INSERT INTO lectures(id,user_id,content,status) VALUES(1,1,'Existing lecture','ready')"))
            connection.execute(text("INSERT INTO tasks(id,user_id,question,answer) VALUES(1,1,'Existing question','Existing answer')"))
        with patch.object(main, "engine", self.engine), patch.object(main, "SessionLocal", self.sessions), \
                patch("app.services.syllabus.seed_academic_defaults"), patch("app.services.reference_curriculum.seed_sourced_curriculum"), \
                patch("app.services.reference_timetable.seed_sourced_timetable"):
            main.initialize_database()
            with self.engine.begin() as connection:
                connection.execute(text("UPDATE lectures SET source_context_json='{}' WHERE id=1"))
            main.initialize_database()
        with self.engine.connect() as connection:
            for table in tables:
                self.assertIn("source_context_json", {column["name"] for column in inspect(connection).get_columns(table)})
            self.assertEqual(connection.execute(text("SELECT content,source_context_json FROM lectures WHERE id=1")).one(), ("Existing lecture", "{}"))
            self.assertEqual(connection.execute(text("SELECT question,answer,source_context_json FROM tasks WHERE id=1")).one(), ("Existing question", "Existing answer", "{}"))


if __name__ == "__main__":
    unittest.main()
