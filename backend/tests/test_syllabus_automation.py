"""Offline ingestion tests: real durable queue, temporary database and fake AI."""
import asyncio
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from docx import Document
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth import get_current_user
from app.config import settings
from app.database import Base, get_db
from app.job_models import AIJob
from app.models import Course, CurriculumWeek, ModuleWork, StudentGroup, SyllabusDocument, User, WeekProgress, WorkSubmission
from app.operational_models import AuditLog
from app.routers.academic import router
from app.services import background
from app.services.syllabus import SyllabusDraft
from app.services.syllabus_import import import_syllabus
from app.services.ai import AIError


class AutomaticSyllabusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + str(Path(self.temp.name) / "fixture.db"), connect_args={"check_same_thread": False})
        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.previous_key, self.previous_upload = settings.GEMINI_API_KEY, settings.UPLOAD_DIR
        settings.GEMINI_API_KEY, settings.UPLOAD_DIR = "", self.temp.name
        self.queue_database = patch.object(background, "SessionLocal", self.sessions)
        self.queue_database.start()
        with self.sessions() as db:
            group = StudentGroup(name="ИП-26-3кс")
            other = StudentGroup(name="Другая группа")
            db.add_all([group, other]); db.flush()
            self.admin = User(name="Администратор", email="admin@fixture.example", hashed_password="unused", role="admin", group_id=group.id, is_active=True)
            self.student = User(name="Студент", email="student@fixture.example", hashed_password="unused", role="student", group_id=group.id, is_active=True)
            self.course = Course(group_id=group.id, title="Выбранная дисциплина", teacher="Сохранить преподавателя")
            self.other_course = Course(group_id=other.id, title="Не менять эту дисциплину")
            db.add_all([self.admin, self.student, self.course, self.other_course]); db.commit()
        self.actor = self.admin
        app = FastAPI(); app.include_router(router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)
        document = Document()
        document.add_paragraph("Учебный силабус. Неделя 1: Введение. Неделя 2: Практика. Работа: выполнить упражнение.")
        buffer = io.BytesIO(); document.save(buffer); self.source = buffer.getvalue()
        self.draft = SyllabusDraft(summary="Цели и результаты из документа", weeks=[{"week_number": 1, "title": "Введение", "tasks": "Прочитать главу"}, {"week_number": 2, "title": "Практика"}], works=[{"title": "Упражнение", "week_number": 2, "kind": "practice"}])

    def tearDown(self):
        self.client.close()
        self.queue_database.stop()
        settings.GEMINI_API_KEY, settings.UPLOAD_DIR = self.previous_key, self.previous_upload
        self.engine.dispose(); self.temp.cleanup()

    def upload(self, filename="syllabus.docx"):
        response = self.client.post("/api/syllabi/upload", data={"course_id": self.course.id}, files={"file": (filename, self.source, "application/pdf" if filename.endswith(".pdf") else "application/vnd.openxmlformats-officedocument.wordprocessingml.document")})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def process(self, draft=None):
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(return_value=draft or self.draft)):
            self.assertTrue(asyncio.run(background.process_one_job()))

    def test_no_key_and_duplicate_upload_are_explicit_and_keep_source(self):
        document = self.upload()
        self.assertEqual(document["status"], "needs_configuration")
        duplicate = self.upload()
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["id"], document["id"])
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).count(), 0)
            stored = db.query(SyllabusDocument).one()
            self.assertTrue((Path(settings.UPLOAD_DIR) / stored.filepath).is_file())
        self.actor = self.student
        self.assertEqual(self.client.post(f"/api/syllabi/{document['id']}/analyze").status_code, 403)
        self.assertEqual(self.client.get(f"/api/syllabi/{document['id']}").status_code, 404)

    def test_empty_selected_course_is_filled_and_audited_automatically(self):
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload()
        self.assertEqual(document["status"], "queued")
        self.process()
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertEqual(stored.status, "published")
            self.assertEqual(db.query(CurriculumWeek).filter_by(course_id=self.course.id).count(), 2)
            self.assertEqual(db.query(ModuleWork).filter_by(course_id=self.course.id).count(), 1)
            course = db.get(Course, self.course.id)
            self.assertEqual(course.description, self.draft.summary)
            self.assertEqual(course.title, "Выбранная дисциплина")
            self.assertEqual(course.teacher, "Сохранить преподавателя")
            self.assertEqual(db.query(CurriculumWeek).filter_by(course_id=self.other_course.id).count(), 0)
            self.assertEqual(db.query(AIJob).one().status, "done")
            self.assertIn("syllabus.auto_publish", [row.action for row in db.query(AuditLog).all()])
        self.actor = self.student
        self.assertEqual(self.client.get(f"/api/syllabi/{document['id']}").status_code, 200)

    def scan(self):
        import pymupdf
        with pymupdf.open() as text_document:
            page = text_document.new_page(width=400, height=500)
            page.insert_text((30, 40), "Syllabus week 1: Introduction and practice", fontsize=12)
            image = page.get_pixmap().tobytes("png")
        with pymupdf.open() as scanned:
            page = scanned.new_page(width=400, height=500)
            page.insert_image(page.rect, stream=image)
            self.source = scanned.tobytes()

    def test_blank_pdf_queues_inspection_without_fabricating_curriculum(self):
        import fitz
        with fitz.open() as pdf:
            pdf.new_page()
            self.source = pdf.tobytes()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload("scan.pdf")
        self.assertEqual(document["status"], "queued")
        # A blank page has nothing to recognize; no provider call is made.
        with patch("app.services.syllabus_import.recognize_pdf", return_value=("", [])), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock()) as ai:
            self.assertTrue(asyncio.run(background.process_one_job()))
            ai.assert_not_called()
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).one().status, "done")
            self.assertEqual(db.query(SyllabusDocument).one().status, "needs_ocr")
            self.assertEqual(db.query(CurriculumWeek).count(), 0)

    def test_scan_is_read_without_ai_key_and_retry_uses_saved_text(self):
        self.scan()
        document = self.upload("scan.pdf")
        self.assertEqual(document["status"], "queued")
        text = "Учебный силабус. Неделя 1: Введение. Работа: выполнить упражнение."
        with patch("app.services.syllabus_import.recognize_pdf", return_value=(text, ["Текст распознан автоматически."])) as ocr, \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock()) as ai:
            self.assertTrue(asyncio.run(background.process_one_job()))
            ocr.assert_called_once()
            ai.assert_not_called()
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertEqual(stored.extracted_text, text)
            self.assertEqual(stored.status, "needs_configuration")
            self.assertEqual(db.query(CurriculumWeek).count(), 0)
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            response = self.client.post(f"/api/syllabi/{document['id']}/analyze")
            self.assertEqual(response.status_code, 200, response.text)
            with patch("app.services.syllabus_import.recognize_pdf", side_effect=AssertionError("OCR must not repeat after stored text")):
                self.process()
        with self.sessions() as db:
            self.assertEqual(db.get(SyllabusDocument, document["id"]).status, "published")
            self.assertEqual(db.query(CurriculumWeek).count(), 2)

    def test_ocr_checkpoint_survives_restart_and_redacts_before_ai(self):
        self.scan()
        document = self.upload("scan.pdf")
        with patch("app.services.syllabus_import.recognize_pdf", return_value=(
                "Учебный силабус. Неделя 1: Введение и практика.\nПароль: private-fixture-value", [])):
            self.assertTrue(asyncio.run(background.process_one_job()))
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertNotIn("private-fixture-value", stored.extracted_text)
            self.assertTrue(stored.source_restricted)
            checkpoint = json.loads(db.query(AIJob).one().checkpoint_json)
            self.assertNotIn("private-fixture-value", checkpoint["ocr_text"])
        # Simulate an interrupted attempt whose OCR checkpoint was already stored.
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            self.client.post(f"/api/syllabi/{document['id']}/analyze")
            context, _ = background._claim_next()
            context.save_checkpoint(checkpoint)
            with self.sessions() as db:
                job = db.get(AIJob, context.job_id)
                job.lease_expires_at = datetime.utcnow() - timedelta(seconds=1)
                # Force the worker to use OCR mode on resume, as a pre-commit crash would.
                payload = json.loads(job.payload_json)
                payload["ocr_required"] = True
                job.payload_json = json.dumps(payload)
                db.commit()
            background.recover_expired_jobs()
            with patch("app.services.syllabus_import.recognize_pdf", side_effect=AssertionError("Saved OCR must survive restart")), \
                    patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(return_value=self.draft)) as ai:
                self.assertTrue(asyncio.run(background.process_one_job()))
                self.assertNotIn("private-fixture-value", ai.call_args.args[0])
        with self.sessions() as db:
            self.assertEqual(db.get(SyllabusDocument, document["id"]).status, "published")
            self.assertEqual(db.query(CurriculumWeek).count(), 2)

    def gapped_draft(self):
        return SyllabusDraft(weeks=[{"week_number": number, "title": f"Week {number}"}
                                   for number in (1, 2, 4)],
            works=[{"title": "Existing source assignment", "week_number": 4}], summary="Source summary")

    def assert_gap_review(self, document_id):
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document_id)
            self.assertEqual(stored.status, "review")
            self.assertIsNone(stored.published_at)
            self.assertEqual([week["week_number"] for week in json.loads(stored.draft_json)["weeks"]], [1, 2, 4])
            warnings = json.loads(stored.warnings_json)
            self.assertTrue(any("номера недель: 3." in warning and "оригиналом" in warning for warning in warnings))
            self.assertEqual(db.query(CurriculumWeek).count(), 0)
            self.assertEqual(db.query(ModuleWork).count(), 0)
            self.assertEqual(db.get(Course, self.course.id).description, "")
            job = db.query(AIJob).order_by(AIJob.created_at.desc()).first()
            self.assertEqual(job.status, "done")
            self.assertEqual(json.loads(job.result_json)["status"], "review")
            self.assertEqual(json.loads(job.result_json)["weeks_created"], 0)
            self.assertEqual(db.query(AuditLog).filter_by(action="syllabus.auto_publish").count(), 0)
            self.assertEqual(db.query(AuditLog).filter_by(action="syllabus.import_review").count(), 1)

    def test_current_ocr_missing_week_saves_review_without_curriculum_writes(self):
        self.scan()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload("scan.pdf")
            # The current OCR flag protects even a recognizer without its marker.
            with patch("app.services.syllabus_import.recognize_pdf", return_value=(
                    "A scanned syllabus lists weeks 1, 2 and 4, and contains an assignment.", [])), \
                    patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(return_value=self.gapped_draft())) as ai:
                self.assertTrue(asyncio.run(background.process_one_job()))
                self.assertEqual(ai.await_count, 2)
                self.assertEqual(ai.call_args.kwargs, {"repair_missing_weeks": [3]})
        self.assert_gap_review(document["id"])
        with self.sessions() as db:
            stage = json.loads(db.query(AIJob).one().checkpoint_json)["gap_repair"]
            self.assertTrue(stage["attempted"])
            self.assertEqual(stage["status"], "incomplete")
            self.assertEqual(stage["observed_week_numbers"], [1, 2, 4])
            self.assertEqual(stage["delta"]["weeks"], [])

    def test_saved_ocr_marker_protects_retry_without_repeating_ocr(self):
        self.assert_saved_ocr_marker_protects_retry("Windows")

    def test_saved_tesseract_marker_protects_retry_without_repeating_ocr(self):
        self.assert_saved_ocr_marker_protects_retry("Tesseract")

    def assert_saved_ocr_marker_protects_retry(self, engine):
        self.scan()
        document = self.upload("scan.pdf")
        with patch("app.services.syllabus_import.recognize_pdf", return_value=(
                "A scanned syllabus lists weeks 1, 2 and 4, and contains an assignment.",
                [f"Применено локальное OCR {engine}: 1 страница."])):
            self.assertTrue(asyncio.run(background.process_one_job()))
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            response = self.client.post(f"/api/syllabi/{document['id']}/analyze")
            self.assertEqual(response.status_code, 200)
            with self.sessions() as db:
                job = db.query(AIJob).order_by(AIJob.created_at.desc()).first()
                self.assertFalse(json.loads(job.payload_json)["ocr_required"])
            with patch("app.services.syllabus_import.recognize_pdf", side_effect=AssertionError("OCR must not repeat")):
                self.process(self.gapped_draft())
        self.assert_gap_review(document["id"])

    def test_native_noncontinuous_week_plan_still_publishes(self):
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload()
        self.process(self.gapped_draft())
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertEqual(stored.status, "published")
            self.assertEqual([week.week_number for week in db.query(CurriculumWeek).order_by(CurriculumWeek.week_number)], [1, 2, 4])
            self.assertEqual(db.query(ModuleWork).count(), 1)
            self.assertFalse(any("номера недель:" in warning for warning in json.loads(stored.warnings_json)))

    def test_ocr_warning_is_not_duplicated_in_review_or_publication(self):
        self.scan()
        marker = "Применено локальное OCR Windows: 1 страница."
        for status, draft in (("review", self.gapped_draft()), ("published", self.draft)):
            with self.subTest(status=status):
                # A harmless trailing PDF comment creates a distinct source, so
                # duplicate-upload recovery cannot hide either branch.
                self.source += f"\n% QA {status}\n".encode()
                with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
                    document = self.upload("scan.pdf")
                    with patch("app.services.syllabus_import.recognize_pdf", return_value=(
                            "A scanned syllabus contains week records and assignments for study.", [marker])):
                        self.process(draft)
                with self.sessions() as db:
                    stored = db.get(SyllabusDocument, document["id"])
                    self.assertEqual(stored.status, status)
                    self.assertEqual(json.loads(stored.warnings_json).count(marker), 1)

    def repaired_draft(self):
        return SyllabusDraft(weeks=[{"week_number": number, "title": f"Second response week {number}"}
                                   for number in (1, 2, 3, 4)],
            works=[{"title": "Existing source assignment", "week_number": 4, "description": "Changed by second response"},
                   {"title": "existing  source assignment", "week_number": 4},
                   {"title": "New source assignment", "week_number": 3},
                   {"title": "new  source assignment", "week_number": 3, "description": "Duplicate variant"}],
            summary="Second response summary")

    def start_scan_import(self):
        self.scan()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            return self.upload("scan.pdf")

    def ocr_source(self):
        return ("Week 1: Introduction. Week 2: Practice. Week 3: Source-confirmed topic. "
                "Week 4: Revision. New source assignment in week 3.",
                ["Применено локальное OCR Windows: 1 страница."])

    def assert_repaired_publication(self, document_id):
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document_id)
            self.assertEqual(stored.status, "published")
            weeks = db.query(CurriculumWeek).order_by(CurriculumWeek.week_number).all()
            self.assertEqual([week.week_number for week in weeks], [1, 2, 3, 4])
            self.assertEqual([week.title for week in weeks], ["Week 1", "Week 2", "Second response week 3", "Week 4"])
            self.assertEqual(db.query(ModuleWork).count(), 2)
            self.assertEqual(db.query(ModuleWork).filter_by(week_number=4).one().title, "Existing source assignment")
            self.assertEqual(stored.summary, "Source summary")
            stage = json.loads(db.query(AIJob).one().checkpoint_json)["gap_repair"]
            self.assertTrue(stage["attempted"])
            self.assertEqual(stage["status"], "accepted")
            self.assertEqual(stage["missing"], [3])
            self.assertEqual(db.query(AuditLog).filter_by(action="syllabus.auto_publish").count(), 1)

    def test_automatic_gap_repair_keeps_original_topics_dedupes_work_and_fills_empty_facts(self):
        document = self.start_scan_import()
        first = SyllabusDraft.model_validate({**self.gapped_draft().model_dump(),
            "course_facts": {"credits": 5.0, "teacher": "Source teacher"}})
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                    side_effect=[first, self.repaired_draft()])) as ai:
            self.assertTrue(asyncio.run(background.process_one_job()))
            self.assertEqual(ai.await_count, 2)
            self.assertEqual(ai.call_args.kwargs, {"repair_missing_weeks": [3]})
            self.assertEqual(ai.call_args_list[0].args[0], ai.call_args_list[1].args[0])
        self.assert_repaired_publication(document["id"])
        with self.sessions() as db:
            course = db.get(Course, self.course.id)
            self.assertEqual(course.credits, 5)
            self.assertEqual(course.teacher, "Сохранить преподавателя")
            self.assertEqual(json.loads(db.get(SyllabusDocument, document["id"]).draft_json)["course_facts"]["credits"], 5)
        self.assertFalse(asyncio.run(background.process_one_job()))

    def test_invalid_second_schema_keeps_valid_first_draft_for_review(self):
        document = self.start_scan_import()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                    side_effect=[self.gapped_draft(), {"weeks": "Invalid second format"}])):
            self.assertTrue(asyncio.run(background.process_one_job()))
        self.assert_gap_review(document["id"])
        with self.sessions() as db:
            self.assertEqual(json.loads(db.query(AIJob).one().checkpoint_json)["gap_repair"]["status"], "invalid")

    def test_repair_candidate_missing_original_week_is_not_published(self):
        document = self.start_scan_import()
        candidate = SyllabusDraft(weeks=[{"week_number": number, "title": f"Week {number}"}
                                        for number in (2, 3, 4)])
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                    side_effect=[self.gapped_draft(), candidate])):
            self.assertTrue(asyncio.run(background.process_one_job()))
        self.assert_gap_review(document["id"])

    def test_completed_repair_checkpoint_resumes_without_second_ai_or_duplicate_results(self):
        document = self.start_scan_import()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                    side_effect=[self.gapped_draft(), self.repaired_draft()])) as ai, \
                patch.object(background.JobContext, "complete", side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(background.process_one_job())
            self.assertEqual(ai.await_count, 2)
        with self.sessions() as db:
            job = db.query(AIJob).one()
            self.assertEqual(job.status, "queued")
            self.assertEqual(json.loads(job.checkpoint_json)["gap_repair"]["status"], "accepted")
            self.assertEqual(db.query(CurriculumWeek).count(), 0)
        self.engine.dispose()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", side_effect=AssertionError("OCR stage already checkpointed")), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                    side_effect=AssertionError("Completed repair must not call AI again"))) as ai:
            self.assertTrue(asyncio.run(background.process_one_job()))
            ai.assert_not_called()
        self.assert_repaired_publication(document["id"])
        self.assertFalse(asyncio.run(background.process_one_job()))

    def test_recovery_provider_retries_are_bounded_and_last_failure_preserves_first_draft(self):
        document = self.start_scan_import()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                    side_effect=[self.gapped_draft(), AIError("Service unavailable")])):
            self.assertTrue(asyncio.run(background.process_one_job()))
        for attempt in (2, 3):
            with self.sessions() as db:
                job = db.query(AIJob).one(); job.available_at = datetime.utcnow(); db.commit()
            with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                    patch("app.services.syllabus_import.recognize_pdf", side_effect=AssertionError("OCR must not repeat")), \
                    patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                        side_effect=AIError("Service unavailable"))) as ai:
                self.assertTrue(asyncio.run(background.process_one_job()))
                self.assertEqual(ai.await_count, 1)
                self.assertEqual(ai.call_args.kwargs, {"repair_missing_weeks": [3]})
        self.assert_gap_review(document["id"])
        with self.sessions() as db:
            job = db.query(AIJob).one()
            self.assertEqual(job.attempts, 3)
            self.assertEqual(json.loads(job.checkpoint_json)["gap_repair"]["status"], "unavailable")

    def large_gap_drafts(self, extra_works=0):
        # Either response alone fits the durable checkpoint. Keeping both full
        # responses would exceed its 1 MiB limit, even for a single missing row.
        weeks = [{"week_number": number, "title": f"Week {number}", "content": "x" * 20_000}
                 for number in range(1, 47)]
        first = SyllabusDraft(weeks=[week for week in weeks if week["week_number"] != 3])
        second = SyllabusDraft(weeks=weeks, works=[
            {"title": f"Confirmed assignment {number}", "week_number": 3, "description": "y" * 20_000}
            for number in range(extra_works)])
        self.assertGreater(len(json.dumps({"ai_output": first.model_dump(),
            "candidate": second.model_dump()}).encode("utf-8")), 1024 * 1024)
        return first, second

    def test_large_repair_saves_only_delta_and_publishes_without_checkpoint_overflow(self):
        document = self.start_scan_import()
        first, second = self.large_gap_drafts()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(side_effect=[first, second])) as ai:
            self.assertTrue(asyncio.run(background.process_one_job()))
            self.assertEqual(ai.await_count, 2)
        with self.sessions() as db:
            job = db.query(AIJob).one()
            checkpoint = json.loads(job.checkpoint_json)
            self.assertEqual(job.status, "done")
            self.assertLessEqual(len(job.checkpoint_json.encode("utf-8")), 1024 * 1024)
            self.assertNotIn("candidate", checkpoint["gap_repair"])
            self.assertEqual([week["week_number"] for week in checkpoint["gap_repair"]["delta"]["weeks"]], [3])
            self.assertEqual(db.get(SyllabusDocument, document["id"]).status, "published")
            self.assertEqual(db.query(CurriculumWeek).count(), 46)
            self.assertEqual(db.query(CurriculumWeek).filter_by(week_number=3).one().content, "x" * 20_000)

    def test_oversized_repair_keeps_first_draft_and_resumes_review_without_repeating_ai(self):
        document = self.start_scan_import()
        first, second = self.large_gap_drafts(extra_works=12)
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(side_effect=[first, second])) as ai, \
                patch.object(background.JobContext, "complete", side_effect=asyncio.CancelledError):
            with self.assertRaises(asyncio.CancelledError):
                asyncio.run(background.process_one_job())
            self.assertEqual(ai.await_count, 2)
        with self.sessions() as db:
            job = db.query(AIJob).one()
            self.assertEqual(job.status, "queued")
            checkpoint = json.loads(job.checkpoint_json)
            self.assertEqual(checkpoint["gap_repair"]["status"], "limit")
            self.assertEqual(checkpoint["ai_output"], first.model_dump())
            self.assertEqual(db.query(CurriculumWeek).count(), 0)
        self.engine.dispose()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", side_effect=AssertionError("OCR already saved")), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(
                    side_effect=AssertionError("Completed oversized repair must not be repeated"))) as ai:
            self.assertTrue(asyncio.run(background.process_one_job()))
            ai.assert_not_called()
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertEqual(stored.status, "review")
            self.assertIsNone(stored.published_at)
            self.assertEqual(json.loads(stored.draft_json), first.model_dump())
            self.assertTrue(any("допустимый объём" in message for message in json.loads(stored.warnings_json)))
            self.assertEqual(db.query(CurriculumWeek).count(), 0)
            self.assertEqual(db.query(ModuleWork).count(), 0)
            self.assertEqual(db.query(AIJob).one().status, "done")
            self.assertEqual(db.query(AuditLog).filter_by(action="syllabus.auto_publish").count(), 0)

    def test_gap_repair_preserves_same_named_work_from_different_modules(self):
        document = self.start_scan_import()
        first = SyllabusDraft.model_validate({**self.gapped_draft().model_dump(), "works": [
            {"title": "СРС", "module": "Модуль 1", "description": "Original module one task"}]})
        second = SyllabusDraft.model_validate({**self.repaired_draft().model_dump(), "works": [
            {"title": " срс ", "module": "модуль  1", "description": "Second response changed wording"},
            {"title": "СРС", "module": "Модуль 2", "description": "Distinct module two task"}]})
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=self.ocr_source()), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(side_effect=[first, second])):
            self.assertTrue(asyncio.run(background.process_one_job()))
        with self.sessions() as db:
            self.assertEqual(db.get(SyllabusDocument, document["id"]).status, "published")
            works = db.query(ModuleWork).order_by(ModuleWork.module).all()
            self.assertEqual([(work.module, work.description) for work in works], [
                ("Модуль 1", "Original module one task"), ("Модуль 2", "Distinct module two task")])
            self.assertTrue(all(work.week_number is None for work in works))

    def test_repair_includes_source_confirmed_edge_weeks_and_their_works(self):
        document = self.start_scan_import()
        first = SyllabusDraft(weeks=[{"week_number": number, "title": f"Original week {number}"}
                                    for number in (1, 3)])
        second = SyllabusDraft(weeks=[{"week_number": number, "title": f"Confirmed week {number}"}
                                     for number in range(1, 6)],
            works=[{"title": "Final source assignment", "week_number": 5}],
            course_facts={"credits": 4.0, "teacher": "Source teacher"})
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"), \
                patch("app.services.syllabus_import.recognize_pdf", return_value=(
                    "The source explicitly lists weeks 1, 2, 3, 4, 5, with an assignment in week 5.",
                    ["Применено локальное OCR Windows: 1 страница."])), \
                patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(side_effect=[first, second])) as ai:
            self.assertTrue(asyncio.run(background.process_one_job()))
            self.assertEqual(ai.call_args.kwargs, {"repair_missing_weeks": [2]})
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertEqual(stored.status, "published")
            weeks = db.query(CurriculumWeek).order_by(CurriculumWeek.week_number).all()
            self.assertEqual([week.week_number for week in weeks], [1, 2, 3, 4, 5])
            self.assertEqual([week.title for week in weeks], ["Original week 1", "Confirmed week 2",
                "Original week 3", "Confirmed week 4", "Confirmed week 5"])
            self.assertEqual(db.query(ModuleWork).one().week_number, 5)
            stage = json.loads(db.query(AIJob).one().checkpoint_json)["gap_repair"]
            self.assertEqual([week["week_number"] for week in stage["delta"]["weeks"]], [2, 4, 5])
            self.assertEqual(json.loads(stored.draft_json)["course_facts"]["credits"], 4)
            self.assertEqual(db.get(Course, self.course.id).credits, 4)
            self.assertEqual(db.get(Course, self.course.id).teacher, "Сохранить преподавателя")

    def test_existing_plan_progress_and_student_answers_are_preserved(self):
        with self.sessions() as db:
            course = db.get(Course, self.course.id); course.description = "Ручное описание"
            week = CurriculumWeek(course_id=course.id, week_number=1, title="Ручная тема")
            work = ModuleWork(course_id=course.id, title="Ручная работа")
            db.add_all([week, work]); db.flush()
            progress = WeekProgress(week_id=week.id, user_id=self.student.id, completed=True, note="Не потерять")
            answer = WorkSubmission(work_id=work.id, user_id=self.student.id, content="Ответ студента", status="submitted")
            db.add_all([progress, answer]); db.commit()
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload()
        self.process()
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertEqual(stored.status, "review")
            self.assertEqual(json.loads(stored.draft_json)["weeks"][0]["title"], "Введение")
            self.assertEqual(db.query(CurriculumWeek).one().title, "Ручная тема")
            self.assertTrue(db.query(WeekProgress).one().completed)
            self.assertEqual(db.query(WorkSubmission).one().content, "Ответ студента")
            self.assertEqual(db.get(Course, self.course.id).description, "Ручное описание")
        self.actor = self.student
        self.assertEqual(self.client.get(f"/api/syllabi/{document['id']}").status_code, 404)

    def test_invalid_ai_schema_is_a_failed_job_and_cannot_write_curriculum(self):
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload()
            with patch("app.services.syllabus.chat_completion", AsyncMock(return_value='{"role":"admin","weeks":[{"week_number":1,"title":"Injected"}]}')):
                self.assertTrue(asyncio.run(background.process_one_job()))
        detail = self.client.get(f"/api/syllabi/{document['id']}").json()
        self.assertEqual(detail["status"], "import_error")
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).one().status, "error")
            self.assertEqual(db.query(CurriculumWeek).count(), 0)
            self.assertEqual(db.get(User, self.student.id).role, "student")
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            retried = self.client.post(f"/api/syllabi/{document['id']}/analyze")
        self.assertEqual(retried.status_code, 200, retried.text)
        self.assertEqual(retried.json()["status"], "queued")

    def test_restart_reuses_checkpoint_and_applies_once(self):
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload()
            context, _ = background._claim_next()
            context.save_checkpoint({"ai_output": self.draft.model_dump()})
            with self.sessions() as db:
                job = db.get(AIJob, context.job_id)
                job.lease_expires_at = datetime.utcnow() - timedelta(seconds=1)
                db.commit()
            background.recover_expired_jobs()
            with patch("app.services.syllabus_import.analyze_syllabus_text", AsyncMock(side_effect=AssertionError("AI must not be called after checkpoint"))):
                self.assertTrue(asyncio.run(background.process_one_job()))
        self.assertFalse(asyncio.run(background.process_one_job()))
        duplicate = self.upload()
        self.assertTrue(duplicate["duplicate"])
        self.assertEqual(duplicate["id"], document["id"])
        with self.sessions() as db:
            self.assertEqual(db.query(CurriculumWeek).count(), 2)
            self.assertEqual(db.query(ModuleWork).count(), 1)
            self.assertEqual(db.query(AIJob).count(), 1)
            self.assertEqual(db.query(AuditLog).filter_by(action="syllabus.auto_publish").count(), 1)

    def test_manual_edit_during_ai_analysis_is_not_overwritten(self):
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            document = self.upload()
            async def edited_draft(text):
                with self.sessions() as db:
                    stored = db.get(SyllabusDocument, document["id"])
                    stored.summary = "Изменено вручную"
                    stored.draft_json = SyllabusDraft(weeks=[{"week_number": 3, "title": "Ручной черновик"}]).model_dump_json()
                    stored.status = "review"; db.commit()
                return self.draft
            with patch("app.services.syllabus_import.analyze_syllabus_text", edited_draft):
                self.assertTrue(asyncio.run(background.process_one_job()))
        with self.sessions() as db:
            stored = db.get(SyllabusDocument, document["id"])
            self.assertEqual(stored.summary, "Изменено вручную")
            self.assertEqual(json.loads(stored.draft_json)["weeks"][0]["title"], "Ручной черновик")
            self.assertEqual(db.query(CurriculumWeek).count(), 0)

    def test_duplicate_ai_work_rows_are_applied_only_once(self):
        work = {"title": "Контрольная работа", "week_number": 1, "kind": "module"}
        draft = SyllabusDraft(weeks=[{"week_number": 1, "title": "Введение"}], works=[work, work])
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            self.upload()
        self.process(draft)
        with self.sessions() as db:
            self.assertEqual(db.query(ModuleWork).count(), 1)

    def test_administrator_role_revocation_cancels_before_publication(self):
        with patch.object(settings, "GEMINI_API_KEY", "fixture-key"):
            self.upload()
        with self.sessions() as db:
            db.get(User, self.admin.id).role = "student"; db.commit()
        self.process()
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).one().status, "error")
            self.assertEqual(db.query(CurriculumWeek).count(), 0)


if __name__ == "__main__":
    unittest.main()
