"""Source fidelity and privilege tests; no live database or HTML execution."""
import hashlib
import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_current_user
from app.database import Base, get_db
from app.models import AcademicSetting, Course, CurriculumWeek, ModuleWork, ScheduleEntry, StudentGroup, User
from app.routers.academic import router
from app.services.academic_context import MAX_ACADEMIC_CONTEXT, academic_context
from app.services.reference_timetable import REFERENCE_KEY, SOURCE_SHA256, reviewed_timetable, seed_sourced_timetable


class TimetableTests(unittest.TestCase):
    def setUp(self):
        project_root = Path(__file__).resolve().parents[2]
        self.source = project_root / "local-documents" / "spravochnik-9.html"
        if not self.source.is_file():
            self.source = project_root / "spravochnik-9.html"
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        @event.listens_for(self.engine, "connect")
        def enable_fk(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            group = StudentGroup(name="ИП-26-3кс", description="Сохранить описание", curator="Сохранить куратора")
            db.add(group)
            db.flush()
            course = Course(group_id=group.id, title="Мамандыққа кіріспе", teacher="Исходный преподаватель", credits=4)
            db.add(course)
            db.flush()
            self.group_id, self.course_id = group.id, course.id
            db.add_all([CurriculumWeek(course_id=course.id, week_number=i, title=f"Тема {i}") for i in range(1, 16)])
            db.add(ModuleWork(course_id=course.id, title="Сохранённая работа"))
            self.admin = User(email="admin@timetable.example", hashed_password="unused", role="admin", group_id=group.id)
            self.student = User(email="student@timetable.example", hashed_password="unused", role="student", group_id=group.id)
            db.add_all([self.admin, self.student])
            db.commit()
        app = FastAPI()
        app.include_router(router, prefix="/api")
        self.actor = self.admin
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def seed(self):
        # Import behavior uses the committed, checksum-verified JSON snapshot.
        # Only this exact synthetic source's digest is trusted in this scope;
        # hashing the snapshot and rejecting arbitrary HTML still use real SHA.
        fixture_content = b"<!doctype html><title>QStudy synthetic source fixture</title>"
        real_sha256 = hashlib.sha256

        def fixture_digest(content, *args, **kwargs):
            if content == fixture_content:
                return SimpleNamespace(hexdigest=lambda: SOURCE_SHA256)
            return real_sha256(content, *args, **kwargs)

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "synthetic-timetable.html"
            source.write_bytes(fixture_content)
            with self.sessions() as db, patch(
                "app.services.reference_timetable.hashlib.sha256", side_effect=fixture_digest
            ):
                result = seed_sourced_timetable(db, source)
        self.assertTrue(result["imported"], result)

    def test_private_original_html_matches_verified_hash_when_available(self):
        if not self.source.is_file():
            self.skipTest("Verified original HTML is not present in this checkout")
        self.assertEqual(hashlib.sha256(self.source.read_bytes()).hexdigest(), SOURCE_SHA256)

    def test_imports_every_record_and_every_start_without_invented_end_or_parity(self):
        self.seed()
        with self.sessions() as db:
            self.assertEqual(db.query(StudentGroup).count(), 61)
            self.assertEqual(db.query(StudentGroup).filter(StudentGroup.study_year.is_(None)).count(), 37)
            self.assertEqual(db.query(StudentGroup).filter_by(study_year=1, semester=1).count(), 24)
            entries = {row.source_row_id: row for row in db.query(ScheduleEntry).all()}
            self.assertEqual(len(entries), 770)
            self.assertEqual(sum(len(json.loads(row.start_times_json)) for row in entries.values()), 1370)
            for item in reviewed_timetable()["expanded_lessons"]:
                row = entries[item["source_record_key"]]
                self.assertEqual(json.loads(row.start_times_json), item["start_times"])
                self.assertEqual((row.room, row.teacher, row.source_raw), (item["room"], item["teacher"], item["source_text"]))
                self.assertEqual((row.source_file, row.source_sheet, row.source_cell, row.source_sha256),
                                 (item["source_workbook"], item["source_sheet"], item["source_cell"], item["source_sha256"]))
                self.assertEqual(row.source_container_sha256, SOURCE_SHA256)
                self.assertEqual(row.end_time, "")
                self.assertEqual(row.week_pattern, "unspecified")
            self.assertEqual(db.execute(text("PRAGMA foreign_key_check")).all(), [])

    def test_existing_course_curriculum_and_administrator_changes_survive_restart(self):
        self.seed()
        with self.sessions() as db:
            group = db.get(StudentGroup, self.group_id)
            self.assertEqual((group.description, group.curator), ("Сохранить описание", "Сохранить куратора"))
            courses = db.query(Course).filter_by(group_id=self.group_id).all()
            self.assertEqual(len(courses), 8)
            intro = db.get(Course, self.course_id)
            self.assertEqual((intro.teacher, intro.credits), ("Исходный преподаватель", 4))
            self.assertEqual(db.query(CurriculumWeek).filter_by(course_id=intro.id).count(), 15)
            self.assertEqual(db.query(ModuleWork).filter_by(course_id=intro.id).count(), 1)
            rows = db.query(ScheduleEntry).join(Course).filter(Course.group_id == group.id).all()
            self.assertEqual(len(rows), 9)
            self.assertEqual(sum(len(json.loads(row.start_times_json)) for row in rows), 15)
            self.assertTrue(any(row.course_id == intro.id for row in rows))
            rows[0].notes = "Правка администратора"
            edited_id = rows[0].id
            db.delete(rows[1])
            other = db.query(StudentGroup).filter(StudentGroup.id != group.id).first()
            deleted_group_id = other.id
            db.delete(other)
            intro.title = "Название после правки"
            db.commit()
            before = db.query(ScheduleEntry).count()
            self.assertEqual(seed_sourced_timetable(db, self.source)["reason"], "already_imported")
            self.assertEqual(db.query(ScheduleEntry).count(), before)
            self.assertIsNone(db.get(StudentGroup, deleted_group_id))
            self.assertEqual(db.get(ScheduleEntry, edited_id).notes, "Правка администратора")
            self.assertEqual(db.get(Course, self.course_id).title, "Название после правки")

    def test_changed_source_is_rejected_without_partial_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "untrusted.html"
            source.write_text("<script>doNotExecute()</script>", encoding="utf-8")
            with self.sessions() as db:
                self.assertEqual(seed_sourced_timetable(db, source)["reason"], "source_changed")
                self.assertIsNone(db.get(AcademicSetting, REFERENCE_KEY))
                self.assertEqual(db.query(StudentGroup).count(), 1)
                self.assertEqual(db.query(ScheduleEntry).count(), 0)

    def test_source_metadata_and_snapshot_date_are_explicit_to_students(self):
        self.seed()
        self.actor = self.student
        result = self.client.get("/api/academic/timetable-source")
        self.assertEqual(result.status_code, 200)
        data = result.json()
        self.assertEqual(data["counts"]["group_schedule_records"], 770)
        self.assertEqual(data["current_counts"]["start_slots"], 1370)
        self.assertEqual(data["updated_at"], "2026-09-29")
        self.assertEqual(data["utc_offset"], "+05:00")
        self.assertTrue(data["warnings"])
        self.assertNotIn("local_original", result.text)
        self.assertNotIn("<script", result.text)
        group = self.client.get(f"/api/groups/{self.group_id}").json()
        self.assertEqual((group["study_year"], group["semester"]), (1, 1))
        self.assertTrue(all(row["end_time"] is None and row["week_pattern"] == "unspecified" for row in group["schedule"]))
        monday = self.client.get(f"/api/groups/{self.group_id}/schedule?on=2026-10-12").json()
        self.assertTrue(monday)
        self.assertTrue(all(row["day_of_week"] == 1 for row in monday))
        self.assertEqual(self.client.delete(f"/api/schedule/{monday[0]['id']}").status_code, 403)

    def test_admin_can_edit_unknown_end_multi_start_and_cannot_forge_provenance(self):
        endpoint = f"/api/groups/{self.group_id}/schedule"
        payload = {"course_id": self.course_id, "day_of_week": 1, "start_time": "08:30", "start_times": ["08:30", "09:35"],
                   "end_time": None, "teacher": "Преподаватель занятия", "notes": "Проверить в деканате", "week_pattern": "unspecified"}
        result = self.client.post(endpoint, json=payload)
        self.assertEqual(result.status_code, 201, result.text)
        row = result.json()
        self.assertIsNone(row["end_time"])
        self.assertEqual(row["teacher"], payload["teacher"])
        self.assertEqual(self.client.post(endpoint, json={**payload, "start_time": "09:35", "start_times": ["09:35"]}).status_code, 409)
        self.assertEqual(self.client.post(endpoint, json={**payload, "end_time": "09:00"}).status_code, 422)
        self.assertEqual(self.client.post(endpoint, json={**payload, "start_times": ["08:30", "29:00"]}).status_code, 422)
        self.assertEqual(self.client.put(f"/api/schedule/{row['id']}", json={**payload, "source_file": "forged.xlsx"}).status_code, 422)
        changed = self.client.put(f"/api/schedule/{row['id']}", json={**payload, "notes": "Обновлено"})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["notes"], "Обновлено")
        self.assertEqual(self.client.put(f"/api/groups/{self.group_id}", json={"name": "ИП-26-3кс", "study_year": 99}).status_code, 422)

    def test_ai_context_contains_only_own_schedule_and_marks_unknowns(self):
        self.seed()
        with self.sessions() as db:
            foreign_group = db.query(StudentGroup).filter(StudentGroup.id != self.group_id).first()
            foreign_course = Course(group_id=foreign_group.id, title="PRIVATE_FOREIGN_TIMETABLE_SENTINEL")
            db.add(foreign_course)
            db.flush()
            db.add(ScheduleEntry(course_id=foreign_course.id, day_of_week=1, start_time="00:01", end_time="", teacher="FOREIGN_TEACHER_SENTINEL"))
            db.commit()
            context = academic_context(db, self.student, "Расписание занятий и аудитории")
            self.assertLessEqual(len(context), MAX_ACADEMIC_CONTEXT)
            sunday = academic_context(db, self.student, "Жексенбі күні не бар?")
            self.assertIn("Для дня «Воскресенье»", sunday)
            self.assertIn("начала слотов: 08:30, 09:35", context)
            self.assertIn("окончание: не указано", context)
            self.assertIn("2026-09-29", context)
            self.assertIn("806Г", context)
            self.assertNotIn("PRIVATE_FOREIGN", context)
            self.assertNotIn("FOREIGN_TEACHER", context)
            self.assertIn("UTC+05:00", context)
            self.assertIn("дата снимка", context)
            self.assertIn("не подтверждены", context)

    def test_relative_date_question_prioritizes_requested_day_without_claiming_term_validity(self):
        self.seed()
        class Wednesday(datetime):
            @classmethod
            def now(cls, tz=None):
                return cls(2026, 10, 7, 10, 0, tzinfo=timezone.utc).astimezone(tz)
        with self.sessions() as db, patch("app.services.academic_context.datetime", Wednesday):
            context = academic_context(db, self.student, "Что завтра?")
            start = context.index("РАСПИСАНИЕ ГРУППЫ")
            self.assertIn("Четверг:", context[start:].splitlines()[1])
            self.assertIn("2026-10-07T15:00+05:00", context)
            self.assertIn("не подтверждает проведение занятия", context)
            self.assertLessEqual(len(context), MAX_ACADEMIC_CONTEXT)

    def test_additive_upgrade_preserves_preexisting_clock_and_no_end_schema_rebuild(self):
        from app import main
        old = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        with old.begin() as conn:
            conn.execute(text("CREATE TABLE schedule_entries (id INTEGER PRIMARY KEY, course_id INTEGER NOT NULL, day_of_week INTEGER NOT NULL, start_time VARCHAR(5) NOT NULL, end_time VARCHAR(5) NOT NULL, room VARCHAR(100), lesson_type VARCHAR(100), week_pattern VARCHAR(20))"))
            conn.execute(text("INSERT INTO schedule_entries VALUES(1,1,1,'08:00','09:00','100','Лекция','odd')"))
        with patch.object(main, "engine", old), patch.object(main, "SessionLocal", sessionmaker(bind=old)), \
                patch("app.services.syllabus.seed_academic_defaults"), patch("app.services.reference_curriculum.seed_sourced_curriculum"), \
                patch("app.services.reference_timetable.seed_sourced_timetable"):
            main.initialize_database()
            main.initialize_database()
        with old.connect() as conn:
            self.assertEqual(conn.execute(text("SELECT start_time,end_time,room FROM schedule_entries WHERE id=1")).one(), ("08:00", "09:00", "100"))
            self.assertEqual(conn.execute(text("SELECT start_times_json,source_file FROM schedule_entries WHERE id=1")).one(), ("[]", ""))
        old.dispose()


if __name__ == "__main__":
    unittest.main()
