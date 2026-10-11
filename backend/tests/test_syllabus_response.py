"""Legacy syllabus response normalization never rewrites stored publication data."""
import json
import os
import tempfile
import unittest
from pathlib import Path

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from app.auth import get_current_user
from app.database import Base, get_db
from app.models import Course, StudentGroup, SyllabusDocument, User
from app.routers import academic
from app.services.syllabus import SyllabusDraft


class SyllabusResponseTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + str(Path(self.temp.name) / "legacy.db"),
                                    connect_args={"check_same_thread": False})
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            actor = User(email="qa@example.test", role="admin", hashed_password="unused")
            group = StudentGroup(name="Temporary group")
            db.add_all([actor, group]); db.flush()
            course = Course(group_id=group.id, title="Existing discipline")
            db.add(course); db.flush()
            self.actor, self.course_id = actor, course.id
            db.commit()
        app = FastAPI()
        app.include_router(academic.router)
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()
        self.temp.cleanup()

    def fixture(self, raw, warnings="[]", status="needs_ocr"):
        with self.sessions() as db:
            document = SyllabusDocument(course_id=self.course_id, title="Existing title",
                summary="Existing summary", filename="legacy.pdf", filepath="syllabi/legacy.pdf",
                size=100, status=status, draft_json=raw, warnings_json=warnings)
            db.add(document); db.commit()
            return document.id

    def response(self, identifier):
        response = self.client.get(f"/syllabi/{identifier}")
        self.assertEqual(response.status_code, 200)
        value = response.json()
        self.assertEqual(set(value["draft"]), {"title", "summary", "weeks", "works", "course_facts"})
        self.assertIsInstance(value["draft"]["title"], str)
        self.assertIsInstance(value["draft"]["summary"], str)
        self.assertIsInstance(value["draft"]["weeks"], list)
        self.assertIsInstance(value["draft"]["works"], list)
        self.assertEqual(value["weeks"], value["draft"]["weeks"])
        self.assertTrue(all(isinstance(warning, str) and len(warning) <= 1000 for warning in value["warnings"]))
        self.assertLessEqual(len(value["warnings"]), 20)
        return value

    def assert_raw_preserved(self, identifier, raw, warnings):
        with self.sessions() as db:
            document = db.get(SyllabusDocument, identifier)
            self.assertEqual(document.draft_json, raw)
            self.assertEqual(document.warnings_json, warnings)

    def test_missing_null_invalid_and_nonobject_drafts_are_safe_canonical_responses(self):
        for raw in ("{}", "null", "{invalid", "[]", '"text"', "42"):
            with self.subTest(raw=raw):
                identifier = self.fixture(raw)
                value = self.response(identifier)
                self.assertEqual(value["draft"], {"title": "Existing title", "summary": "Existing summary",
                                                   "weeks": [], "works": [], "course_facts": None})
                if raw != "{}":
                    self.assertTrue(value["warnings"])
                self.assert_raw_preserved(identifier, raw, "[]")

    def test_partial_malformed_arrays_preserve_valid_rows_and_warn_without_rewriting(self):
        raw = json.dumps({"title": "Preserved title", "summary": None,
            "weeks": [None, 3, {"week_number": 2, "title": "Valid week", "content": "  Preserve spacing  "},
                      {"week_number": 0, "title": "Invalid week"}, {"title": "Missing number"}],
            "works": {"not": "a list"}, "unexpected": "must not leak"})
        identifier = self.fixture(raw)
        value = self.response(identifier)
        self.assertEqual(value["draft"]["title"], "Preserved title")
        self.assertEqual(value["draft"]["summary"], "Existing summary")
        self.assertEqual(len(value["draft"]["weeks"]), 1)
        self.assertEqual(value["draft"]["weeks"][0]["content"], "  Preserve spacing  ")
        self.assertEqual(value["draft"]["weeks"][0]["tasks"], "")
        self.assertEqual(value["draft"]["works"], [])
        self.assertTrue(value["warnings"])
        self.assert_raw_preserved(identifier, raw, "[]")
        with self.assertRaises(ValueError):
            SyllabusDraft.model_validate_json(raw)

    def test_invalid_stored_draft_returns_safe_publish_validation_error(self):
        identifier = self.fixture('{bad-secret-fixture', status="review")
        response = self.client.post(f"/syllabi/{identifier}/publish", json={"replace_existing": False})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn('bad-secret-fixture', response.text)
        self.assert_raw_preserved(identifier, '{bad-secret-fixture', "[]")

    def test_unknown_row_fields_do_not_disclose_values_or_erase_valid_content(self):
        raw = json.dumps({"weeks": [{"week_number": 1, "title": "Preserved", "legacy": "private unknown"}],
                          "works": [{"title": "Preserved work", "extra": "private unknown"}]})
        identifier = self.fixture(raw)
        value = self.response(identifier)
        self.assertEqual(value["draft"]["weeks"][0]["title"], "Preserved")
        self.assertEqual(value["draft"]["works"][0]["title"], "Preserved work")
        self.assertNotIn("private unknown", json.dumps(value))
        self.assertTrue(value["warnings"])
        self.assert_raw_preserved(identifier, raw, "[]")
        with self.assertRaises(ValueError):
            SyllabusDraft.model_validate_json(raw)

    def test_published_canonical_draft_is_unchanged_and_student_cannot_receive_it(self):
        draft = SyllabusDraft.model_validate({"title": "Published title", "summary": "Published summary",
            "weeks": [{"week_number": 1, "title": "Week", "content": "Existing content"}],
            "works": [{"title": "Existing work", "week_number": 1, "kind": "practice"}]}).model_dump()
        raw = json.dumps(draft, ensure_ascii=False)
        identifier = self.fixture(raw, status="published")
        value = self.response(identifier)
        self.assertEqual(value["draft"], draft)
        self.assertEqual(value["warnings"], [])
        self.assert_raw_preserved(identifier, raw, "[]")
        self.actor.role = "student"
        response = self.client.get(f"/syllabi/{identifier}")
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["draft"])

    def test_warning_corruption_and_oversized_warning_lists_are_bounded(self):
        warnings_values = ("null", "{}", "{bad", json.dumps([None, 4, {}, "Valid warning"]),
                           json.dumps(["x" * 5000] * 100))
        for warnings in warnings_values:
            with self.subTest(kind=type(warnings).__name__):
                identifier = self.fixture("{}", warnings)
                value = self.response(identifier)
                self.assertTrue(value["warnings"])
                self.assert_raw_preserved(identifier, "{}", warnings)

    def test_invalid_preview_does_not_make_stored_bad_plan_publishable(self):
        raw = json.dumps({"title": "Existing title", "weeks": [{"week_number": -1, "title": "Invalid"}], "works": []})
        identifier = self.fixture(raw, status="review")
        value = self.response(identifier)
        self.assertEqual(value["draft"]["weeks"], [])
        self.assertTrue(value["warnings"])
        with self.sessions() as db:
            document = db.get(SyllabusDocument, identifier)
            with self.assertRaises(ValueError):
                SyllabusDraft.model_validate_json(document.draft_json)
        self.assert_raw_preserved(identifier, raw, "[]")


if __name__ == "__main__":
    unittest.main()
