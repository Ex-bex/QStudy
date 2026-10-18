"""Real HTTP + SQLite QTests tests; no Gemini requests or production data."""
import asyncio
import io
import json
import os
import unittest
import zipfile
import tempfile
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch
from xml.sax.saxutils import escape

os.environ.setdefault("SECRET_KEY", "qtests-only-test-secret-key-with-more-than-32-characters")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth import create_access_token
from app.config import settings
from app.database import Base, get_db
from app.job_models import AIJob
from app.models import User
from app.qtests_models import QTestsAttempt, QTestsAttemptQuestion, QTestsBank, QTestsBankQuestion
from app.routers import admin, qtests
from app.services import background


def document(count=3, marked=False, explanation=False):
    lines = []
    for number in range(1, count + 1):
        lines.extend([f"{number}. Сколько будет {number} + 1?", f"A) {number + 1}",
                      f"B) {number + 2}", f"C) {number + 3}", f"D) {number + 4}"])
        if marked:
            lines.append("Правильный ответ: A")
        if explanation:
            lines.append(f"Объяснение: При добавлении единицы к {number} получается {number + 1}.")
    content = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>' +
        "".join("<w:p><w:r><w:t>" + escape(line) + "</w:t></w:r></w:p>" for line in lines) + "</w:body></w:document>")
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
        archive.writestr("word/document.xml", content)
    return stream.getvalue()


class QTestsAPITests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + str(Path(self.temporary.name) / "qtests.db"), connect_args={"check_same_thread": False, "timeout": 15})
        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False, autoflush=False)
        with self.sessions() as db:
            rows = [User(email="owner@example.com", name="Owner", role="student", hashed_password="test"),
                    User(email="other@example.com", name="Other", role="student", hashed_password="test"),
                    User(email="admin@example.com", name="Admin", role="admin", hashed_password="test")]
            db.add_all(rows); db.commit()
            self.owner, self.other, self.admin = [row.id for row in rows]
        app = FastAPI(); app.include_router(qtests.router, prefix="/api"); app.include_router(admin.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app, raise_server_exceptions=False)
        self.patches = [patch.object(background, "SessionLocal", self.sessions), patch.object(settings, "GEMINI_API_KEY", "")]
        for item in self.patches:
            item.start()
        self.as_user(self.owner)

    def tearDown(self):
        self.client.close()
        for item in reversed(self.patches):
            item.stop()
        self.engine.dispose()
        self.temporary.cleanup()

    def as_user(self, identifier):
        self.client.headers.clear()
        if identifier:
            self.client.headers["Authorization"] = "Bearer " + create_access_token(identifier)

    def upload(self, count=3, mode="first", marked=False, explanation=False):
        response = self.client.post("/api/qtests/banks", files={"file": ("Тест.docx", document(count, marked, explanation), "application/vnd.openxmlformats-officedocument.wordprocessingml.document")},
            data={"title": "Банк вопросов", "answer_mode": mode})
        self.assertEqual(response.status_code, 202, response.text)
        return response.json()

    def import_ready(self, count=3, **kwargs):
        result = self.upload(count, **kwargs)
        self.assertTrue(asyncio.run(background.process_one_job()))
        response = self.client.get(f'/api/qtests/banks/{result["bank"]["id"]}')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "ready", response.text)
        return response.json()

    def start(self, bank, count=40):
        response = self.client.post(f'/api/qtests/banks/{bank["id"]}/attempts', json={"count": count})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def test_300_questions_select_40_unique_and_shuffle_correct_mapping(self):
        bank = self.import_ready(300)
        self.assertEqual(bank["question_count"], 300)
        original = {q["question"]: q["options"][q["correct_index"]] for q in bank["questions"]}
        attempt = self.start(bank)
        self.assertEqual(attempt["question_count"], 40)
        self.assertEqual(len({q["question"] for q in attempt["questions"]}), 40)
        self.assertTrue(all("correct_index" not in q and "explanation" not in q for q in attempt["questions"]))
        with self.sessions() as db:
            rows = db.query(QTestsAttemptQuestion).filter(QTestsAttemptQuestion.attempt_id == attempt["id"]).all()
            self.assertTrue(any(q.correct_index != 0 for q in rows))
            self.assertTrue(all(json.loads(q.options_json)[q.correct_index] == original[q.question] for q in rows))
        second = self.start(bank)
        self.assertNotEqual([q["question"] for q in attempt["questions"]], [q["question"] for q in second["questions"]])

    def test_answer_is_saved_reveals_only_answered_and_cannot_be_changed(self):
        bank = self.import_ready(3, explanation=True); attempt = self.start(bank)
        question = attempt["questions"][0]
        answer = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": question["id"], "answer_index": 0})
        self.assertEqual(answer.status_code, 200, answer.text)
        self.assertEqual(answer.json()["answered_count"], 1)
        self.assertIn("correct_index", answer.json()["questions"][0])
        self.assertNotIn("correct_index", answer.json()["questions"][1])
        self.assertIn("При добавлении", answer.json()["questions"][0]["explanation"])
        repeated = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": question["id"], "answer_index": 1})
        self.assertEqual(repeated.status_code, 409)
        # A fresh client/session models refresh/restart: persisted progress remains.
        loaded = self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()
        self.assertEqual(loaded["questions"][0]["user_index"], 0)

    def test_finish_counts_unanswered_wrong_and_reveals_keys(self):
        attempt = self.start(self.import_ready(5))
        response = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/finish')
        self.assertEqual(response.status_code, 200)
        result = response.json()
        self.assertEqual((result["status"], result["score"], result["answered_count"]), ("finished", 0, 0))
        self.assertTrue(all("correct_index" in row for row in result["questions"]))
        self.assertEqual(self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": result["questions"][0]["id"], "answer_index": 0}).status_code, 409)

    def test_banks_and_attempts_are_private_with_admin_management(self):
        bank = self.import_ready(); attempt = self.start(bank)
        self.as_user(self.other)
        paths = [f'/api/qtests/banks/{bank["id"]}', f'/api/qtests/attempts/{attempt["id"]}']
        for path in paths:
            self.assertEqual(self.client.get(path).status_code, 404)
            self.assertEqual(self.client.delete(path).status_code, 404)
        self.assertEqual(self.client.get("/api/qtests/overview").json()["banks"], [])
        self.assertEqual(self.client.get("/api/admin/qtests/overview").status_code, 403)
        self.as_user(self.admin)
        self.assertEqual(self.client.get(paths[0]).status_code, 200)
        overview = self.client.get("/api/admin/qtests/overview").json()
        self.assertEqual(overview["banks"][0]["owner"]["email"], "owner@example.com")
        self.assertEqual(self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": attempt["questions"][0]["id"], "answer_index": 0}).status_code, 403)

    def test_bank_edit_and_delete_never_changes_saved_attempt(self):
        bank = self.import_ready(); attempt = self.start(bank)
        source = bank["questions"][0]
        updated = self.client.patch(f'/api/qtests/banks/{bank["id"]}/questions/{source["id"]}', json={"question": "Новый вопрос", "options": ["Да", "Нет"], "correct_index": 1, "explanation": "Новый разбор"})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(self.client.delete(f'/api/qtests/banks/{bank["id"]}').status_code, 200)
        loaded = self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()
        self.assertIsNone(loaded["bank_id"])
        self.assertEqual(loaded["questions"], attempt["questions"])
        self.assertEqual(loaded["bank_title"], "Банк вопросов")

    def test_import_survives_lease_expiry_and_does_not_duplicate(self):
        result = self.upload(300)
        claimed = background._claim_next()
        self.assertIsNotNone(claimed)
        with self.sessions() as db:
            job = db.get(AIJob, result["job_id"]); job.lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
        background.recover_expired_jobs()
        self.assertTrue(asyncio.run(background.process_one_job()))
        with self.sessions() as db:
            bank = db.get(QTestsBank, result["bank"]["id"])
            self.assertEqual((bank.status, len(bank.questions)), ("ready", 300))
            self.assertEqual(db.get(AIJob, result["job_id"]).status, "done")
        self.assertFalse(asyncio.run(background.process_one_job()))

    def test_missing_key_never_assumes_a_without_explicit_mode(self):
        result = self.upload(mode="marked")
        asyncio.run(background.process_one_job())
        with self.sessions() as db:
            self.assertEqual(db.get(AIJob, result["job_id"]).status, "error")
            bank = db.get(QTestsBank, result["bank"]["id"])
            self.assertEqual(bank.status, "error")
            self.assertEqual(len(bank.questions), 0)
        retry = self.client.post(f'/api/qtests/banks/{result["bank"]["id"]}/retry')
        self.assertEqual(retry.status_code, 202, retry.text)

    def test_marked_key_and_invalid_uploads(self):
        self.assertEqual(self.import_ready(3, mode="marked", marked=True)["question_count"], 3)
        for filename, content in (("test.doc", document()), ("test.docx", b"not office"), ("evil.docm", document())):
            response = self.client.post("/api/qtests/banks", files={"file": (filename, content)}, data={"answer_mode": "first"})
            self.assertEqual(response.status_code, 422, response.text)

    def test_manual_crud_validates_key_and_disallows_duplicates(self):
        result = self.client.post("/api/qtests/banks/manual", json={"title": "Ручной банк"})
        self.assertEqual(result.status_code, 201, result.text)
        bank = result.json()
        path = f'/api/qtests/banks/{bank["id"]}/questions'
        invalid = [{"question": "Вопрос", "options": ["Да", "Нет"], "correct_index": 5},
                   {"question": "Вопрос", "options": ["Да", "Да"], "correct_index": 0},
                   {"question": "Вопрос", "options": ["Да", "Нет"], "correct_index": True}]
        for item in invalid:
            self.assertEqual(self.client.post(path, json=item).status_code, 422)
        good = self.client.post(path, json={"question": "Вопрос", "options": ["Да", "Нет"], "correct_index": 1})
        self.assertEqual(good.status_code, 201, good.text)
        self.assertEqual(self.start(bank)["question_count"], 1)

    def test_deleting_queued_bank_cancels_job_and_cannot_resurrect(self):
        result = self.upload()
        self.assertEqual(self.client.delete(f'/api/qtests/banks/{result["bank"]["id"]}').status_code, 200)
        self.assertFalse(asyncio.run(background.process_one_job()))
        with self.sessions() as db:
            self.assertIsNone(db.get(QTestsBank, result["bank"]["id"]))
            self.assertEqual(db.get(AIJob, result["job_id"]).status, "error")

    def test_config_can_be_disabled_only_by_admin_without_losing_attempts(self):
        attempt = self.start(self.import_ready())
        payload = {"enabled": False, "title": "QTests", "description": "Тренажёр"}
        self.assertEqual(self.client.patch("/api/admin/qtests/settings", json=payload).status_code, 403)
        self.as_user(self.admin)
        response = self.client.patch("/api/admin/qtests/settings", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.as_user(None)
        self.assertFalse(self.client.get("/api/qtests/config").json()["enabled"])
        self.assertEqual(self.client.get("/api/qtests/overview").status_code, 401)
        self.as_user(self.owner)
        self.assertEqual(self.client.get("/api/qtests/overview").status_code, 503)
        self.assertEqual(self.client.get(f'/api/qtests/attempts/{attempt["id"]}').status_code, 200)

    def test_wrong_answer_queues_real_ai_and_keeps_explanation_after_restart(self):
        bank = self.import_ready(3); attempt = self.start(bank)
        row = attempt["questions"][0]
        with self.sessions() as db:
            correct = db.get(QTestsAttemptQuestion, row["id"]).correct_index
        with patch.object(settings, "GEMINI_API_KEY", "test-not-real"), patch.object(qtests, "generate_content", AsyncMock(return_value=json.dumps({"explanation": "При сложении единицы получается следующее натуральное число."}))) as provider:
            response = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": row["id"], "answer_index": (correct + 1) % len(row["options"])})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["questions"][0]["explanation_status"], "pending")
            self.assertTrue(response.json()["job_id"])
            asyncio.run(background.process_one_job())
            provider.assert_awaited_once()
        result = self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()["questions"][0]
        self.assertEqual(result["explanation_status"], "ai")
        self.assertIn("натуральное", result["explanation"])

    def test_no_ai_uses_honest_source_key_not_fake_explanation(self):
        attempt = self.start(self.import_ready())
        row = attempt["questions"][0]
        response = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": row["id"], "answer_index": 0}).json()
        self.assertIsNone(response["job_id"])
        self.assertIn("В документе нет подробного объяснения", response["questions"][0]["explanation"])
        self.assertEqual(response["questions"][0]["explanation_status"], "source")

    def test_multiple_wrong_answers_share_durable_job_without_stuck_pending(self):
        attempt = self.start(self.import_ready(5))
        with patch.object(settings, "GEMINI_API_KEY", "test-not-real"), patch.object(qtests, "generate_content", AsyncMock(return_value='{"explanation":"Подробный разбор ошибки"}')) as provider:
            jobs = []
            for row in attempt["questions"][:3]:
                with self.sessions() as db:
                    correct = db.get(QTestsAttemptQuestion, row["id"]).correct_index
                response = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": row["id"], "answer_index": (correct + 1) % 4})
                self.assertEqual(response.status_code, 200, response.text); jobs.append(response.json()["job_id"])
            self.assertEqual(len(set(jobs)), 1)
            asyncio.run(background.process_one_job())
            self.assertEqual(provider.await_count, 3)
            row = attempt["questions"][3]
            with self.sessions() as db:
                correct = db.get(QTestsAttemptQuestion, row["id"]).correct_index
            response = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": row["id"], "answer_index": (correct + 1) % 4})
            self.assertNotEqual(response.json()["job_id"], jobs[0])
            asyncio.run(background.process_one_job())
        loaded = self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()
        self.assertTrue(all(row["explanation_status"] == "ai" for row in loaded["questions"][:4]))

    def test_ai_fallback_is_source_grounded_and_never_guesses_marked_answer(self):
        class Context:
            state = {}
            def get_checkpoint(self):
                return self.state
            def save_checkpoint(self, value):
                self.state = value
        source = "1. Первый вопрос?\nA) Да\nB) Нет\nОтвет: B\n2. Второй вопрос?\nA) Да\nB) Нет\nОтвет: A"
        output = {"questions": [{"question": "Первый вопрос?", "options": ["Да", "Нет"], "correct_index": 0},
                                {"question": "Второй вопрос?", "options": ["Да", "Нет"], "correct_index": 1},
                                {"question": "Придуманный вопрос?", "options": ["Да", "Нет"]}]}
        with patch.object(qtests, "generate_content", AsyncMock(return_value=json.dumps(output))):
            result = asyncio.run(qtests._ai_parse(source, "marked", Context()))
        self.assertEqual([row["correct_index"] for row in result], [1, 0])
        self.assertEqual(len(result), 2)
        with patch.object(qtests, "generate_content", AsyncMock(return_value=json.dumps(output))):
            result = asyncio.run(qtests._ai_parse(source, "first", Context()))
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["question"], "Второй вопрос?")

    def test_ai_chunks_preserve_question_and_choices_at_boundaries(self):
        first = "1. " + "Текст " * 3000 + "?\nA) Да\nB) Нет"
        second = "2. " + "Другой " * 3000 + "?\nA) Да\nB) Нет"
        chunks = qtests._source_chunks(first + "\n" + second)
        self.assertEqual(len(chunks), 2)
        self.assertEqual(chunks[0], [first]); self.assertEqual(chunks[1], [second])

    def test_admin_account_delete_removes_private_qtests_records_and_jobs(self):
        bank = self.import_ready(4); self.start(bank); self.upload(5)
        self.as_user(self.admin)
        response = self.client.delete(f"/api/admin/users/{self.owner}")
        self.assertEqual(response.status_code, 200, response.text)
        with self.sessions() as db:
            self.assertIsNone(db.get(User, self.owner))
            for model in (QTestsBank, QTestsBankQuestion, QTestsAttempt, QTestsAttemptQuestion, AIJob):
                self.assertEqual(db.query(model).count(), 0)

    def test_concurrent_answers_keep_first_and_finished_attempt_cannot_change(self):
        attempt = self.start(self.import_ready())
        path = f'/api/qtests/attempts/{attempt["id"]}/answer'
        question = attempt["questions"][0]
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(self.client.post, path, json={"question_id": question["id"], "answer_index": index}) for index in (0, 1)]
            responses = [future.result() for future in futures]
        self.assertEqual(sorted(response.status_code for response in responses), [200, 409])
        saved = self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()["questions"][0]["user_index"]
        self.client.post(f'/api/qtests/attempts/{attempt["id"]}/finish')
        self.assertEqual(self.client.post(path, json={"question_id": question["id"], "answer_index": (saved + 1) % 4}).status_code, 409)
        self.assertEqual(self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()["questions"][0]["user_index"], saved)

    def test_deleted_attempt_during_ai_never_reappears_or_persists_explanation(self):
        attempt = self.start(self.import_ready())
        question = attempt["questions"][0]
        with self.sessions() as db:
            correct = db.get(QTestsAttemptQuestion, question["id"]).correct_index
        async def response_after_delete(*args, **kwargs):
            response = self.client.delete(f'/api/qtests/attempts/{attempt["id"]}')
            self.assertEqual(response.status_code, 200, response.text)
            return '{"explanation":"Этот ответ не должен сохраниться"}'
        with patch.object(settings, "GEMINI_API_KEY", "test-not-real"), patch.object(qtests, "generate_content", response_after_delete):
            result = self.client.post(f'/api/qtests/attempts/{attempt["id"]}/answer', json={"question_id": question["id"], "answer_index": (correct + 1) % 4}).json()
            asyncio.run(background.process_one_job())
        with self.sessions() as db:
            self.assertIsNone(db.get(QTestsAttempt, attempt["id"]))
            self.assertEqual(db.query(QTestsAttemptQuestion).count(), 0)
            self.assertEqual(db.get(AIJob, result["job_id"]).status, "error")

    def test_ai_cannot_reintroduce_questions_with_ambiguous_source_keys(self):
        result = self.upload()
        parsed = {"questions": [{"question": "Безопасный вопрос", "options": ["Да", "Нет"], "correct_index": 0}],
                  "warnings": ["Противоречивый ключ"], "rejected": 1, "source_text": "Полный текст",
                  "blocked_questions": ["Опасный вопрос"]}
        extracted = [{"question": "Опасный вопрос", "options": ["Да", "Нет"], "correct_index": 0}]
        with patch.object(settings, "GEMINI_API_KEY", "test-not-real"), patch("app.services.qtests_import.extract_docx_questions", return_value=parsed), patch.object(qtests, "_ai_parse", AsyncMock(return_value=extracted)):
            asyncio.run(background.process_one_job())
        bank = self.client.get(f'/api/qtests/banks/{result["bank"]["id"]}').json()
        self.assertEqual(bank["question_count"], 1)
        self.assertEqual(bank["questions"][0]["question"], "Безопасный вопрос")


if __name__ == "__main__":
    unittest.main()
