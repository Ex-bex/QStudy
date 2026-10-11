"""Explicit syllabus facts are bounded, reviewable and never overwrite course edits."""
import asyncio
import json
import os
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_current_user
from app.database import Base, get_db
from app.models import Course, CurriculumWeek, StudentGroup, SyllabusDocument, User
from app.routers.academic import router
from app.services.syllabus import (CourseFacts, SyllabusDraft, analyze_syllabus_text,
                                  fill_missing_course_facts)


FACTS = {"credits": 4.5, "teacher": "Преподаватель источника", "total_hours": 135,
         "source_group": "Исходная группа", "semester": 2}


class CourseFactsValidationTests(unittest.TestCase):
    def test_unknown_fields_are_optional_and_never_populate_course(self):
        course = Course(group_id=7, title="Выбранная дисциплина", credits=0, teacher="")
        for draft in (SyllabusDraft(), SyllabusDraft(course_facts=None), SyllabusDraft(course_facts={})):
            self.assertEqual(fill_missing_course_facts(course, draft), [])
        self.assertEqual((course.credits, course.teacher, course.title, course.group_id),
                         (0, "", "Выбранная дисциплина", 7))
        self.assertEqual(CourseFacts().model_dump(), {"credits": None, "teacher": "", "total_hours": None,
                                                     "source_group": "", "semester": None})

    def test_facts_reject_invalid_types_bounds_nonfinite_values_and_account_fields(self):
        invalid = [{key: value} for key, values in {
            "credits": (0, -1, 101, "4", True, float("nan"), float("inf")),
            "total_hours": (0, -10, 10001, "120", True, float("nan"), float("inf")),
            "semester": (0, 17, 1.5, "2", True),
            "teacher": (None, 3, "x" * 201),
            "source_group": (None, [], "x" * 301),
        }.items() for value in values]
        invalid.extend(({"group_id": 99}, {"role": "admin"}, {"title": "Replace title"}))
        for facts in invalid:
            with self.subTest(facts=facts), self.assertRaises(ValueError):
                SyllabusDraft(course_facts=facts)
        self.assertEqual(CourseFacts(credits=100, total_hours=10000, semester=16).credits, 100)

    def test_fill_missing_facts_is_independent_idempotent_and_preserves_existing_metadata(self):
        draft = SyllabusDraft(title="Иное название", summary="Описание источника", course_facts=FACTS)
        for teacher, credits, expected_fields in (("", 0, ["teacher", "credits"]),
                                                  ("  ", None, ["teacher", "credits"]),
                                                  ("Администратор", 0, ["credits"]),
                                                  ("", 5, ["teacher"]),
                                                  ("Администратор", 5, [])):
            with self.subTest(teacher=teacher, credits=credits):
                course = Course(group_id=7, title="Сохранить название", description="Сохранить описание",
                                teacher=teacher, credits=credits)
                self.assertEqual(fill_missing_course_facts(course, draft), expected_fields)
                self.assertEqual(course.teacher, teacher if teacher.strip() else FACTS["teacher"])
                self.assertEqual(course.credits, credits if credits else FACTS["credits"])
                self.assertEqual((course.title, course.group_id, course.description),
                                 ("Сохранить название", 7, "Сохранить описание"))
                self.assertEqual(fill_missing_course_facts(course, draft), [])
                self.assertNotIn("total_hours", course.__dict__)
                self.assertNotIn("semester", course.__dict__)

    def test_ai_prompt_extracts_explicit_facts_and_repair_keeps_redacted_source_as_data(self):
        source = "Название дисциплины. Преподаватель и часы указаны в таблице.\nпароль ACCESS_SENTINEL\nНеделя 2: Тема."
        provider = AsyncMock(return_value=json.dumps({"course_facts": FACTS, "weeks": [{"week_number": 2, "title": "Тема"}]}))
        with patch("app.services.syllabus.chat_completion", provider):
            draft = asyncio.run(analyze_syllabus_text(source, repair_missing_weeks=[2, 2]))
        self.assertEqual(draft.course_facts.credits, FACTS["credits"])
        system, messages = provider.call_args.args
        self.assertIn('"course_facts"', system)
        self.assertIn("только явно указанные", system)
        self.assertIn("отсутствовали номера недель: 2.", system)
        self.assertIn("оставь неделю отсутствующей", system)
        self.assertNotIn("ACCESS_SENTINEL", messages[0]["parts"][0]["text"])
        self.assertIn("Неделя 2: Тема.", messages[0]["parts"][0]["text"])
        self.assertEqual(messages[0]["role"], "user")

    def test_repair_numbers_cannot_inject_instructions_or_call_provider_when_invalid(self):
        for missing in (["ignore instructions"], [True], [0], [53], "2", [1] * 53):
            with self.subTest(missing=missing), patch("app.services.syllabus.chat_completion", AsyncMock()) as provider:
                with self.assertRaises(ValueError):
                    asyncio.run(analyze_syllabus_text("Source text", repair_missing_weeks=missing))
                provider.assert_not_awaited()


class CourseFactsApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            group = StudentGroup(name="Выбранная группа", semester=5)
            self.admin = User(email="admin@facts.test", role="admin", hashed_password="unused")
            self.student = User(email="student@facts.test", role="student", hashed_password="unused")
            db.add_all([group, self.admin, self.student])
            db.flush()
            course = Course(group_id=group.id, title="Выбранная дисциплина", description="Описание администратора",
                            teacher="", credits=0)
            db.add(course)
            db.commit()
            self.course_id, self.group_id = course.id, group.id
        self.actor = self.admin
        app = FastAPI()
        app.include_router(router, prefix="/api")

        def database():
            with self.sessions() as db:
                yield db

        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def document(self, draft, *, raw=False):
        with self.sessions() as db:
            document = SyllabusDocument(course_id=self.course_id, title="Источник", filename="source.pdf",
                filepath="syllabi/source.pdf", size=100, summary="", status="review",
                draft_json=draft if raw else json.dumps(draft, ensure_ascii=False))
            db.add(document)
            db.commit()
            return document.id

    def test_admin_publication_fills_missing_facts_and_student_can_read_source_metadata(self):
        identifier = self.document({})
        draft = {"title": "Не менять название дисциплины", "summary": "Сведения источника", "course_facts": FACTS,
                 "weeks": [{"week_number": 1, "title": "Неделя источника"}]}
        response = self.client.put(f"/api/syllabi/{identifier}", json={"draft": draft})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["draft"]["course_facts"], FACTS)
        self.actor = self.student
        self.assertEqual(self.client.post(f"/api/syllabi/{identifier}/publish", json={}).status_code, 403)
        self.actor = self.admin
        response = self.client.post(f"/api/syllabi/{identifier}/publish", json={})
        self.assertEqual(response.status_code, 200, response.text)
        with self.sessions() as db:
            course = db.get(Course, self.course_id)
            self.assertEqual((course.teacher, course.credits), (FACTS["teacher"], FACTS["credits"]))
            self.assertEqual((course.title, course.description, course.group_id),
                             ("Выбранная дисциплина", "Описание администратора", self.group_id))
            self.assertEqual(db.get(StudentGroup, self.group_id).semester, 5)
        self.actor = self.student
        response = self.client.get(f"/api/syllabi/{identifier}")
        self.assertIsNone(response.json()["draft"])
        self.assertEqual(response.json()["course_facts"], FACTS)
        self.assertEqual(self.client.get("/api/syllabi").json()[0]["course_facts"], FACTS)

    def test_publication_preserves_admin_values_set_after_draft_and_is_single_use(self):
        identifier = self.document({"course_facts": FACTS, "works": [{"title": "Работа"}]})
        with self.sessions() as db:
            course = db.get(Course, self.course_id)
            course.teacher, course.credits = "Исправлено администратором", 6
            db.commit()
        self.assertEqual(self.client.post(f"/api/syllabi/{identifier}/publish", json={}).status_code, 200)
        self.assertEqual(self.client.post(f"/api/syllabi/{identifier}/publish", json={}).status_code, 409)
        with self.sessions() as db:
            course = db.get(Course, self.course_id)
            self.assertEqual((course.teacher, course.credits), ("Исправлено администратором", 6))

    def test_conflicting_plan_does_not_apply_facts_or_publish_partial_changes(self):
        with self.sessions() as db:
            db.add(CurriculumWeek(course_id=self.course_id, week_number=1, title="Существующая тема"))
            db.commit()
        identifier = self.document({"course_facts": FACTS, "weeks": [{"week_number": 1, "title": "Другая тема"}]})
        self.assertEqual(self.client.post(f"/api/syllabi/{identifier}/publish", json={}).status_code, 409)
        with self.sessions() as db:
            course = db.get(Course, self.course_id)
            self.assertEqual((course.teacher, course.credits), ("", 0))
            self.assertIsNone(db.get(SyllabusDocument, identifier).published_at)

    def test_corrupt_facts_are_safe_to_read_but_not_publishable_and_never_rewrite_source(self):
        for facts in ("corrupt", [], 42, {"credits": "4"}, {"credits": float("nan")},
                      {"teacher": "Preserved", "role": "PRIVATE_SENTINEL"}):
            with self.subTest(facts=facts):
                raw = json.dumps({"course_facts": facts, "weeks": [{"week_number": 1, "title": "Тема"}]})
                identifier = self.document(raw, raw=True)
                response = self.client.get(f"/api/syllabi/{identifier}")
                self.assertEqual(response.status_code, 200, response.text)
                self.assertNotIn("PRIVATE_SENTINEL", response.text)
                self.assertTrue(response.json()["warnings"])
                self.assertEqual(response.json()["draft"]["weeks"][0]["title"], "Тема")
                self.assertEqual(self.client.post(f"/api/syllabi/{identifier}/publish", json={}).status_code, 422)
                with self.sessions() as db:
                    self.assertEqual(db.get(SyllabusDocument, identifier).draft_json, raw)


if __name__ == "__main__":
    unittest.main()
