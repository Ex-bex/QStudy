"""Saved lessons and atomic Word replacement through HTTP and real SQLite."""
import asyncio
import io
import json
import unittest
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta

import test_qtests as _existing
from app.job_models import AIJob
from app.qtests_models import (QTestsBank, QTestsBankQuestion, QTestsLesson,
                              QTestsBankLesson, QTestsImportRevision)
from app.routers import qtests
from app.services import background


def _document(count=300, *, replacement=False, no_questions=False):
    """A complete DOCX, including a valid non-test document for error recovery."""
    original = _existing.document(count)
    source = io.BytesIO(original); target = io.BytesIO()
    with zipfile.ZipFile(source) as archive, zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as output:
        for item in archive.infolist():
            payload = archive.read(item)
            if item.filename == "word/document.xml":
                content = payload.decode()
                if no_questions:
                    content = ('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
                               '<w:body><w:p><w:r><w:t>Учебное описание без вопросов и вариантов ответа.</w:t>'
                               '</w:r></w:p></w:body></w:document>')
                elif replacement:
                    content = content.replace("Сколько будет", "Вычислите сумму")
                payload = content.encode()
            output.writestr(item.filename, payload)
    return target.getvalue()


class QTestsLessonsTests(unittest.TestCase):
    setUp = _existing.QTestsAPITests.setUp
    tearDown = _existing.QTestsAPITests.tearDown
    as_user = _existing.QTestsAPITests.as_user
    upload = _existing.QTestsAPITests.upload
    import_ready = _existing.QTestsAPITests.import_ready
    start = _existing.QTestsAPITests.start

    def lesson(self, title="Математика", **extra):
        response = self.client.post("/api/qtests/lessons", json={"title": title, **extra})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def replace(self, bank, data=None, filename="Обновлённые вопросы.docx", mode="first"):
        response = self.client.post(f'/api/qtests/banks/{bank["id"]}/document',
            files={"file": (filename, data if data is not None else _document(replacement=True))},
            data={"answer_mode": mode})
        return response

    def bank(self, bank):
        response = self.client.get(f'/api/qtests/banks/{bank["id"]}')
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def source(self, bank):
        return self.client.get(f'/api/qtests/banks/{bank["id"]}/document')

    def test_upload_once_assign_lesson_choose_it_and_resume_after_reopen(self):
        lesson = self.lesson(description="Повторение перед экзаменом")
        original = _document()
        response = self.client.post("/api/qtests/banks", files={"file": ("Математика.docx", original)},
            data={"answer_mode": "first", "title": "300 вопросов", "lesson_id": lesson["id"]})
        self.assertEqual(response.status_code, 202, response.text)
        bank = response.json()["bank"]
        self.assertEqual((bank["lesson_id"], bank["lesson_title"], bank["has_document"]), (lesson["id"], lesson["title"], True))
        self.assertTrue(asyncio.run(background.process_one_job()))
        attempt = self.start(bank)
        self.engine.dispose()  # A new DB connection must retain sources, links and attempts.
        overview = self.client.get("/api/qtests/overview").json()
        self.assertEqual((overview["lessons"][0]["bank_count"], overview["lessons"][0]["question_count"]), (1, 300))
        self.assertEqual(overview["banks"][0]["lesson_id"], lesson["id"])
        self.assertEqual(overview["attempts"][0]["id"], attempt["id"])
        self.assertEqual(self.source(bank).content, original)
        saved = self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()
        self.assertEqual(len({row["question"] for row in saved["questions"]}), 40)
        self.assertEqual(saved["questions"], attempt["questions"])

    def test_lesson_and_bank_metadata_editing_and_unassigning(self):
        first = self.lesson(); second = self.lesson("Физика")
        response = self.client.post("/api/qtests/banks/manual", json={"title": "Лекция", "lesson_id": first["id"]})
        self.assertEqual(response.status_code, 201, response.text); bank = response.json()
        self.assertFalse(bank["has_document"])
        self.assertEqual(self.source(bank).status_code, 404)
        path = f'/api/qtests/lessons/{second["id"]}'
        edited = self.client.patch(path, json={"title": "Физика II", "description": "Механика"})
        self.assertEqual(edited.status_code, 200, edited.text)
        updated = self.client.patch(f'/api/qtests/banks/{bank["id"]}', json={"lesson_id": second["id"]})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["lesson_title"], "Физика II")
        cleared = self.client.patch(f'/api/qtests/banks/{bank["id"]}', json={"title": "Новый банк", "lesson_id": None})
        self.assertEqual((cleared.json()["title"], cleared.json()["lesson_id"]), ("Новый банк", None))
        self.assertEqual(self.client.patch(path, json={"title": None}).status_code, 422)
        self.assertEqual(self.client.patch(path, json={}).status_code, 422)
        self.assertEqual(self.client.patch(f'/api/qtests/banks/{bank["id"]}', json={"title": None}).status_code, 422)

    def test_private_lessons_assignment_and_document_cannot_be_crossed(self):
        lesson = self.lesson(); bank = self.import_ready()
        self.as_user(self.other); other_lesson = self.lesson("Чужой урок")
        self.assertEqual(self.client.get("/api/qtests/lessons").json()[0]["id"], other_lesson["id"])
        for method, path, body in [
                ("patch", f'/api/qtests/lessons/{lesson["id"]}', {"title": "Подмена"}),
                ("delete", f'/api/qtests/lessons/{lesson["id"]}', None),
                ("get", f'/api/qtests/lessons?bank_id={bank["id"]}', None),
                ("get", f'/api/qtests/banks/{bank["id"]}/document', None)]:
            kwargs = {"json": body} if body is not None else {}
            self.assertEqual(getattr(self.client, method)(path, **kwargs).status_code, 404)
        self.assertEqual(self.client.post("/api/qtests/lessons", json={"title": "Подмена владельца", "owner_id": self.owner}).status_code, 403)
        self.as_user(self.owner)
        path = f'/api/qtests/banks/{bank["id"]}'
        self.assertEqual(self.client.patch(path, json={"lesson_id": other_lesson["id"]}).status_code, 404)
        self.as_user(self.admin)
        self.assertEqual(self.client.patch(path, json={"lesson_id": other_lesson["id"]}).status_code, 404)
        self.assertEqual(self.client.patch(path, json={"lesson_id": lesson["id"]}).status_code, 200)
        self.assertEqual([row["id"] for row in self.client.get(f'/api/qtests/lessons?bank_id={bank["id"]}').json()], [lesson["id"]])
        self.assertEqual(self.source(bank).status_code, 200)

    def test_admin_lesson_management_reports_owner_and_preserves_user_ownership(self):
        self.as_user(self.admin)
        lesson = self.lesson("Информатика", owner_id=self.owner)
        updated = self.client.patch(f'/api/qtests/lessons/{lesson["id"]}', json={"description": "Алгоритмы"})
        self.assertEqual(updated.status_code, 200, updated.text)
        overview = self.client.get("/api/admin/qtests/overview").json()
        self.assertEqual(overview["stats"]["lessons"], 1)
        self.assertEqual(overview["lessons"][0]["owner"]["id"], self.owner)
        self.assertEqual(self.client.get("/api/qtests/lessons").json(), [])
        self.as_user(self.owner)
        self.assertEqual(self.client.get("/api/qtests/lessons").json()[0]["description"], "Алгоритмы")

    def test_deleting_lesson_keeps_bank_document_and_attempt_history(self):
        lesson = self.lesson(); bank = self.import_ready(); attempt = self.start(bank)
        self.client.patch(f'/api/qtests/banks/{bank["id"]}', json={"lesson_id": lesson["id"]})
        original = self.source(bank).content
        self.assertEqual(self.client.delete(f'/api/qtests/lessons/{lesson["id"]}').status_code, 200)
        self.assertEqual(self.client.get("/api/qtests/lessons").json(), [])
        self.assertIsNone(self.bank(bank)["lesson_id"])
        self.assertEqual(self.source(bank).content, original)
        self.assertEqual(self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()["questions"], attempt["questions"])

    def test_replacement_is_staged_then_atomically_updates_source_and_questions(self):
        bank = self.import_ready(300); attempt = self.start(bank)
        old_source = self.source(bank).content
        new_source = _document(replacement=True)
        response = self.replace(bank, new_source)
        self.assertEqual(response.status_code, 202, response.text)
        staged = response.json()["bank"]
        self.assertEqual((staged["status"], staged["replacement_status"], staged["question_count"]), ("ready", "importing", 300))
        self.assertEqual(self.source(bank).content, old_source)
        self.assertEqual(self.bank(bank)["questions"], bank["questions"])
        self.start(bank)  # The previous verified bank remains usable while importing.
        self.assertTrue(asyncio.run(background.process_one_job()))
        updated = self.bank(bank)
        self.assertEqual((updated["status"], updated["replacement_status"], updated["question_count"]), ("ready", None, 300))
        self.assertEqual(self.source(bank).content, new_source)
        self.assertTrue(all("Вычислите сумму" in row["question"] for row in updated["questions"]))
        self.assertEqual(self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()["questions"], attempt["questions"])
        refreshed = self.start(updated)
        self.assertEqual(len({row["question"] for row in refreshed["questions"]}), 40)
        with self.sessions() as db:
            from app.qtests_models import QTestsAttempt
            saved = db.get(QTestsAttempt, refreshed["id"])
            for row in saved.questions:
                options = json.loads(row.options_json)
                number = int(row.question.split()[2])
                self.assertEqual(options[row.correct_index], str(number + 1))

    def test_failed_replacement_and_retry_keep_verified_document_and_questions(self):
        bank = self.import_ready(300); old_source = self.source(bank).content
        result = self.replace(bank, _document(no_questions=True))
        self.assertEqual(result.status_code, 202, result.text)
        self.assertTrue(asyncio.run(background.process_one_job()))
        failed = self.bank(bank)
        self.assertEqual((failed["status"], failed["replacement_status"]), ("ready", "error"))
        self.assertTrue(failed["replacement_error"])
        self.assertEqual(failed["questions"], bank["questions"])
        self.assertEqual(self.source(bank).content, old_source)
        self.start(bank)
        retry = self.client.post(f'/api/qtests/banks/{bank["id"]}/retry')
        self.assertEqual(retry.status_code, 202, retry.text)
        self.assertTrue(asyncio.run(background.process_one_job()))
        self.assertEqual(self.bank(bank)["replacement_status"], "error")
        self.assertEqual(self.source(bank).content, old_source)
        # A new replacement supersedes the failed staged file without reset.
        self.assertEqual(self.replace(bank).status_code, 202)
        self.assertTrue(asyncio.run(background.process_one_job()))
        self.assertIsNone(self.bank(bank)["replacement_status"])

    def test_replacement_resumes_after_expired_worker_lease(self):
        bank = self.import_ready(300)
        replacement = self.replace(bank).json()
        context, _ = background._claim_next()
        self.assertEqual(context.job_id, replacement["job_id"])
        with self.sessions() as db:
            job = db.get(AIJob, context.job_id)
            job.lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
        self.engine.dispose()
        background.recover_expired_jobs()
        self.assertTrue(asyncio.run(background.process_one_job()))
        updated = self.bank(bank)
        self.assertEqual((updated["status"], updated["replacement_status"], updated["question_count"]), ("ready", None, 300))
        with self.sessions() as db:
            self.assertEqual(db.get(AIJob, replacement["job_id"]).status, "done")

    def test_pending_replacement_blocks_editor_and_second_replacement(self):
        bank = self.import_ready(); response = self.replace(bank)
        self.assertEqual(response.status_code, 202, response.text)
        path = f'/api/qtests/banks/{bank["id"]}/questions'
        payload = {"question": "Новый вопрос?", "options": ["A", "B"], "correct_index": 0}
        self.assertEqual(self.client.post(path, json=payload).status_code, 409)
        self.assertEqual(self.client.patch(path + f'/{bank["questions"][0]["id"]}', json=payload).status_code, 409)
        self.assertEqual(self.client.delete(path + f'/{bank["questions"][0]["id"]}').status_code, 409)
        self.assertEqual(self.replace(bank).status_code, 409)

    def test_concurrent_replacements_accept_one_and_do_not_overwrite_staging(self):
        bank = self.import_ready()
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.replace(bank), range(2)))
        self.assertEqual(sorted(row.status_code for row in responses), [202, 409], [row.text for row in responses])
        with self.sessions() as db:
            self.assertEqual(db.query(QTestsImportRevision).count(), 1)
            self.assertEqual(db.query(AIJob).filter(AIJob.status.in_(background.ACTIVE)).count(), 1)
        self.assertTrue(asyncio.run(background.process_one_job()))
        self.assertIsNone(self.bank(bank)["replacement_status"])

    def test_delayed_failure_from_previous_revision_cannot_poison_new_revision(self):
        bank = self.import_ready()
        original = self.replace(bank, _document(no_questions=True)).json()
        with self.sessions() as db:
            old_payload = json.loads(db.get(AIJob, original["job_id"]).payload_json)
        asyncio.run(background.process_one_job())
        retry = self.client.post(f'/api/qtests/banks/{bank["id"]}/retry').json()
        with self.sessions() as db:
            qtests._import_failed(db, self.owner, old_payload); db.commit()
            self.assertEqual(db.query(QTestsImportRevision).one().status, "importing")
            self.assertEqual(db.query(QTestsImportRevision).one().job_id, retry["job_id"])
        asyncio.run(background.process_one_job())
        self.replace(bank); asyncio.run(background.process_one_job())
        with self.sessions() as db:
            qtests._import_failed(db, self.owner, old_payload); db.commit()
        self.assertEqual((self.bank(bank)["status"], self.bank(bank)["replacement_status"]), ("ready", None))

    def test_delete_bank_cancels_staged_job_and_keeps_snapshot(self):
        bank = self.import_ready(); attempt = self.start(bank)
        staged = self.replace(bank).json()
        self.assertEqual(self.client.delete(f'/api/qtests/banks/{bank["id"]}').status_code, 200)
        self.assertFalse(asyncio.run(background.process_one_job()))
        with self.sessions() as db:
            self.assertIsNone(db.get(QTestsBank, bank["id"]))
            self.assertEqual(db.query(QTestsImportRevision).count(), 0)
            self.assertEqual(db.get(AIJob, staged["job_id"]).status, "error")
        self.assertEqual(self.client.get(f'/api/qtests/attempts/{attempt["id"]}').json()["questions"], attempt["questions"])

    def test_download_name_is_encoded_and_unauthenticated_access_is_denied(self):
        bank = self.import_ready()
        with self.sessions() as db:
            db.get(QTestsBank, bank["id"]).filename = 'Тест\r\nInjected: yes.docx'; db.commit()
        download = self.source(bank)
        self.assertEqual(download.status_code, 200)
        self.assertIn("attachment", download.headers["content-disposition"])
        self.assertIn("%0D%0A", download.headers["content-disposition"])
        self.assertNotIn("injected", download.headers)
        self.assertIn("wordprocessingml.document", download.headers["content-type"])
        self.assertEqual(download.headers["cache-control"], "private, no-store")
        self.as_user(None)
        self.assertEqual(self.source(bank).status_code, 401)

    def test_user_deletion_removes_private_lessons_links_and_staged_source(self):
        lesson = self.lesson(); bank = self.import_ready()
        self.client.patch(f'/api/qtests/banks/{bank["id"]}', json={"lesson_id": lesson["id"]})
        self.replace(bank)
        self.as_user(self.admin)
        response = self.client.delete(f"/api/admin/users/{self.owner}")
        self.assertEqual(response.status_code, 200, response.text)
        with self.sessions() as db:
            for model in (QTestsLesson, QTestsBankLesson, QTestsBank, QTestsBankQuestion, QTestsImportRevision):
                self.assertEqual(db.query(model).count(), 0, model.__name__)


if __name__ == "__main__":
    unittest.main()
