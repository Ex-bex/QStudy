"""Offline durability, fencing, ownership and idempotency regression checks."""
import os
os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")
import asyncio
import json
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from datetime import datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth import create_access_token
from app.database import Base, get_db
from app.job_models import AIJob
from app.models import User, Subject, Topic, Lecture, Task, Flashcard, Material, ExamSession, ExamQuestion, TestSession as QuizSession, TestQuestion as QuizQuestion
from app.routers import lectures, tests, notifications, tasks, cards, files, exam
from app.config import settings
from app.services import background
from app.services.ai import AIError


class DurableJobTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + str(Path(self.temp.name) / "jobs.db"), connect_args={"check_same_thread": False})
        @event.listens_for(self.engine, "connect")
        def enable_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False, autoflush=False)
        self.session_patch = patch.object(background, "SessionLocal", self.sessions)
        self.session_patch.start()
        with self.sessions() as db:
            users = [User(email=f"{i}@test.local", hashed_password="unused", role="student") for i in range(2)]
            db.add_all(users); db.flush()
            self.owner, self.peer = [user.id for user in users]
            subject = Subject(name="Программирование")
            db.add(subject); db.flush()
            topic = Topic(subject_id=subject.id, title="Python")
            db.add(topic); db.flush()
            self.subject, self.topic = subject.id, topic.id
            db.commit()
        self.original_handlers = dict(background.HANDLERS)
        self.original_failure_handlers = dict(background.FAILURE_HANDLERS)

    async def asyncTearDown(self):
        await background.stop_workers()
        background.HANDLERS.clear(); background.HANDLERS.update(self.original_handlers)
        background.FAILURE_HANDLERS.clear(); background.FAILURE_HANDLERS.update(self.original_failure_handlers)
        self.session_patch.stop()
        self.engine.dispose(); self.temp.cleanup()

    def enqueue(self, kind="offline", payload=None, key=None):
        with self.sessions() as db:
            job = background.enqueue_job(db, self.owner, kind, "Личная задача", payload or {}, key)
            db.commit()
            return job.id

    def fetch(self, job_id):
        with self.sessions() as db:
            return db.get(AIJob, job_id)

    async def test_pending_restart_result_once_and_durable_ack(self):
        calls = []
        @background.register_handler("offline")
        async def handler(context, payload):
            calls.append(payload["text"])
            return {"value": "готово"}
        job_id = self.enqueue(payload={"text": "private input"})
        self.engine.dispose()  # Simulate reopening storage, with no RAM job state.
        await background.start_workers()
        for _ in range(100):
            if self.fetch(job_id).status == "done": break
            await asyncio.sleep(0.01)
        await background.stop_workers()
        await background.start_workers(); await asyncio.sleep(0.03); await background.stop_workers()
        self.assertEqual(calls, ["private input"])
        self.assertEqual(self.fetch(job_id).status, "done")
        app = FastAPI(); app.include_router(notifications.router)
        def db_override():
            with self.sessions() as db: yield db
        app.dependency_overrides[get_db] = db_override
        with TestClient(app) as client:
            client.headers["Authorization"] = "Bearer " + create_access_token(self.owner)
            first = client.get("/notifications").json()
            self.assertEqual(first, client.get("/notifications").json())
            self.assertEqual(first[0]["id"], job_id)
            self.assertNotIn("payload_json", first[0]); self.assertNotIn("private input", json.dumps(first))
            client.headers["Authorization"] = "Bearer " + create_access_token(self.peer)
            self.assertEqual(client.get("/notifications").json(), [])
            self.assertEqual(client.get(f"/notifications/jobs/{job_id}").status_code, 404)
            self.assertEqual(client.post(f"/notifications/{job_id}/ack").status_code, 404)
            client.headers["Authorization"] = "Bearer " + create_access_token(self.owner)
            self.assertEqual(client.post(f"/notifications/{job_id}/ack").status_code, 200)
            self.assertEqual(client.get("/notifications").json(), [])

    async def test_expired_lease_checkpoint_resume_and_fence_old_worker(self):
        calls = []
        @background.register_handler("offline")
        async def handler(context, payload):
            calls.append(context.get_checkpoint()["raw"])
            return {"value": "recovered"}
        job_id = self.enqueue()
        old_context, _ = background._claim_next()
        old_context.save_checkpoint({"raw": "cached AI result"})
        with self.sessions() as db:
            db.get(AIJob, job_id).lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
        self.engine.dispose()
        self.assertTrue(await background.process_one_job())
        self.assertEqual(calls, ["cached AI result"])
        with self.sessions() as db:
            lecture = Lecture(user_id=self.owner, topic_id=self.topic, content="illegal duplicate")
            db.add(lecture)
            with self.assertRaises(background.LeaseLost): old_context.complete(db, {"bad": True})
        with self.sessions() as db:
            self.assertEqual(db.query(Lecture).count(), 0)
        self.assertEqual(self.fetch(job_id).attempts, 2)

    async def test_bounded_retry_then_failure_without_sensitive_error(self):
        calls = []
        @background.register_handler("offline")
        async def handler(context, payload):
            calls.append(1)
            raise RuntimeError("private provider key and source content")
        job_id = self.enqueue()
        for attempt in range(3):
            with self.sessions() as db:
                db.get(AIJob, job_id).available_at = datetime.utcnow(); db.commit()
            self.assertTrue(await background.process_one_job())
        job = self.fetch(job_id)
        self.assertEqual(job.status, "error"); self.assertEqual(job.attempts, 3)
        self.assertNotIn("private", job.error)
        self.assertFalse(await background.process_one_job())
        self.assertEqual(len(calls), 3)

    async def test_max_three_active_jobs_per_user_and_resource_dedup(self):
        @background.register_handler("offline")
        async def handler(context, payload): return {}
        self.enqueue(key="same")
        with self.assertRaises(HTTPException) as duplicate: self.enqueue(key="same")
        self.assertEqual(duplicate.exception.status_code, 409)
        self.enqueue(); self.enqueue()
        with self.assertRaises(HTTPException) as limit: self.enqueue()
        self.assertEqual(limit.exception.status_code, 429)
        with self.sessions() as db:
            peer = background.enqueue_job(db, self.peer, "offline", "Peer", {}); db.commit()
            self.assertEqual(peer.user_id, self.peer)
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).filter(AIJob.user_id == self.owner).count(), 3)

    async def test_lecture_deleted_during_ai_is_not_recreated(self):
        with self.sessions() as db:
            lecture = Lecture(user_id=self.owner, topic_id=self.topic, status="generating", content="preserved")
            db.add(lecture); db.flush()
            lecture_id = lecture.id
            job = background.enqueue_job(db, self.owner, "lecture", "Lecture", {"lecture_id": lecture_id,
                "topic_id": self.topic, "prompt": "private", "materials_hash": "old"}, f"lecture:{lecture_id}")
            db.commit(); job_id = job.id
        async def fake_ai(prompt):
            with self.sessions() as db:
                db.delete(db.get(Lecture, lecture_id)); db.commit()
            return "new text"
        with patch.object(lectures, "generate_content", fake_ai):
            await background.process_one_job()
        self.assertEqual(self.fetch(job_id).status, "error")
        with self.sessions() as db: self.assertEqual(db.query(Lecture).count(), 0)

    async def test_test_checkpoint_recovers_one_session_one_question_set(self):
        with self.sessions() as db:
            session = QuizSession(user_id=self.owner, status="generating")
            db.add(session); db.flush(); session_id = session.id
            job = background.enqueue_job(db, self.owner, "test", "Quiz", {"session_id": session_id,
                "subject_ids": [self.subject], "topic_ids": [self.topic], "count": 1, "prompt": "source"}, f"test:{session_id}")
            db.commit(); job_id = job.id
        old_context, _ = background._claim_next()
        old_context.save_checkpoint({"raw": json.dumps([{"question": "2+2?", "options": ["1", "2", "3", "4"], "correct_index": 3}])})
        with self.sessions() as db:
            db.get(AIJob, job_id).lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
        fake_ai = AsyncMock(side_effect=AssertionError("AI must not be repeated after checkpoint"))
        with patch.object(tests, "generate_content", fake_ai):
            await background.process_one_job(); await background.process_one_job()
        self.assertEqual(fake_ai.await_count, 0)
        with self.sessions() as db:
            self.assertEqual(db.query(QuizSession).count(), 1)
            self.assertEqual(db.query(QuizQuestion).count(), 1)
            self.assertEqual(db.get(QuizSession, session_id).status, "active")
        self.assertEqual(self.fetch(job_id).status, "done")

    async def test_disabled_owner_stops_pending_ai(self):
        fake_ai = AsyncMock(return_value={})
        background.register_handler("offline")(fake_ai)
        job_id = self.enqueue()
        with self.sessions() as db:
            db.get(User, self.owner).is_active = False; db.commit()
        await background.process_one_job()
        self.assertEqual(fake_ai.await_count, 0)
        self.assertEqual(self.fetch(job_id).status, "error")

    async def test_concurrent_requests_cannot_exceed_three_jobs(self):
        @background.register_handler("offline")
        async def handler(context, payload): return {}
        gate = Barrier(5)
        def submit():
            gate.wait(timeout=5)
            try:
                self.enqueue()
                return 201
            except HTTPException as error:
                return error.status_code
        with ThreadPoolExecutor(max_workers=5) as executor:
            outcomes = list(executor.map(lambda _: submit(), range(5)))
        self.assertEqual(sorted(outcomes), [201, 201, 201, 429, 429])
        with self.sessions() as db:
            self.assertEqual(db.query(AIJob).filter(AIJob.user_id == self.owner).count(), 3)

    async def test_graceful_shutdown_requeues_running_job_and_resumes(self):
        started = asyncio.Event()
        calls = []
        @background.register_handler("offline")
        async def handler(context, payload):
            calls.append(1)
            if len(calls) == 1:
                started.set()
                await asyncio.Event().wait()
            return {"ready": True}
        job_id = self.enqueue()
        await background.start_workers()
        await asyncio.wait_for(started.wait(), timeout=2)
        await background.stop_workers()
        self.assertEqual(self.fetch(job_id).status, "queued")
        self.assertIsNone(self.fetch(job_id).lease_owner)
        await background.start_workers()
        for _ in range(100):
            if self.fetch(job_id).status == "done": break
            await asyncio.sleep(0.01)
        await background.stop_workers()
        self.assertEqual(self.fetch(job_id).status, "done")
        self.assertEqual(self.fetch(job_id).attempts, 2)
        self.assertEqual(len(calls), 2)

    async def test_task_and_card_batches_recover_checkpoint_without_duplicates(self):
        kinds = [("tasks", {"question": "What is Python?", "answer": "A language", "hint": "Code"}),
                 ("cards", {"front": "Python", "back": "A language"})]
        for kind, item in kinds:
            payload = {"subject_id": self.subject, "topic_id": self.topic, "count": 1,
                "prompt": "private", "difficulty": "medium", "sources": ["note"]}
            job_id = self.enqueue(kind, payload)
            context, _ = background._claim_next()
            context.save_checkpoint({"raw": json.dumps([item])})
            with self.sessions() as db:
                db.get(AIJob, job_id).lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
            self.engine.dispose()
            fake_ai = AsyncMock(side_effect=AssertionError("checkpoint prevents duplicate provider call"))
            module = tasks if kind == "tasks" else cards
            with patch.object(module, "generate_content", fake_ai):
                self.assertTrue(await background.process_one_job())
                self.assertFalse(await background.process_one_job())
            self.assertEqual(fake_ai.await_count, 0)
            self.assertEqual(self.fetch(job_id).status, "done")
        with self.sessions() as db:
            self.assertEqual(db.query(Task).filter(Task.user_id == self.owner).count(), 1)
            self.assertEqual(db.query(Flashcard).filter(Flashcard.user_id == self.owner).count(), 1)

    async def test_file_processing_checkpoint_survives_restart_with_portable_path(self):
        upload_dir = Path(self.temp.name) / "uploads"; upload_dir.mkdir()
        path = upload_dir / "source.txt"; path.write_text("source content", encoding="utf-8")
        with patch.object(settings, "UPLOAD_DIR", str(upload_dir)):
            with self.sessions() as db:
                material = Material(user_id=self.owner, filename="source.txt", filepath="source.txt",
                    file_type="text", size=path.stat().st_size)
                db.add(material); db.flush(); material_id = material.id
                job = background.enqueue_job(db, self.owner, "file", "Extract", {"material_id": material.id,
                    "size": material.size, "file_type": "text", "sha256": files._file_digest(path)}, f"file:{material.id}")
                db.commit(); job_id = job.id
            context, _ = background._claim_next(); context.save_checkpoint({"text": "stored extraction"})
            with self.sessions() as db:
                db.get(AIJob, job_id).lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
            self.engine.dispose()
            with patch.object(files, "extract_document", Mock(side_effect=AssertionError("No second extraction"))):
                await background.process_one_job()
            with self.sessions() as db:
                material = db.get(Material, material_id)
                self.assertTrue(material.processed)
                self.assertEqual(material.extracted_text, "stored extraction")
            self.assertEqual(self.fetch(job_id).status, "done")

    async def test_request_disconnect_does_not_cancel_persisted_work(self):
        @background.register_handler("offline")
        async def handler(context, payload): return {"ready": True}
        job_id = self.enqueue()
        waiter = asyncio.create_task(background.await_job_result(job_id, self.owner))
        await asyncio.sleep(0.01); waiter.cancel()
        with self.assertRaises(asyncio.CancelledError): await waiter
        self.assertEqual(self.fetch(job_id).status, "queued")
        await background.process_one_job()
        self.assertEqual(self.fetch(job_id).status, "done")
        result = await background.await_job_result(job_id, self.owner)
        self.assertEqual(result, {"ready": True})

    async def test_exam_checkpoint_restart_creates_one_question_set(self):
        with self.sessions() as db:
            session = ExamSession(user_id=self.owner, status="generating",
                subject_ids_json=json.dumps([self.subject]), topic_ids_json=json.dumps([self.topic]))
            db.add(session); db.flush(); session_id = session.id
            job = background.enqueue_job(db, self.owner, "exam", "Exam", {"session_id": session_id,
                "subject_ids": [self.subject], "topic_ids": [self.topic], "count": 1,
                "prompt": "private source"}, f"exam:{session_id}")
            db.commit(); job_id = job.id
        context, _ = background._claim_next()
        context.save_checkpoint({"raw": json.dumps([{"question": "Define Python", "reference": "Language"}])})
        with self.sessions() as db:
            db.get(AIJob, job_id).lease_expires_at = datetime.utcnow() - timedelta(seconds=1); db.commit()
        self.engine.dispose()
        fake_ai = AsyncMock(side_effect=AssertionError("Checkpoint must skip provider"))
        with patch.object(exam, "generate_content", fake_ai):
            self.assertTrue(await background.process_one_job())
            self.assertFalse(await background.process_one_job())
        with self.sessions() as db:
            self.assertEqual(db.query(ExamSession).count(), 1)
            self.assertEqual(db.query(ExamQuestion).count(), 1)
            session = db.get(ExamSession, session_id)
            self.assertEqual(session.status, "active")
            public = exam._full_public(db, session)
            self.assertNotIn("reference", public["questions"][0])
            with self.assertRaises(HTTPException) as other:
                exam.get_exam(session_id, db, db.get(User, self.peer))
            self.assertEqual(other.exception.status_code, 404)
        self.assertEqual(fake_ai.await_count, 0)
        self.assertEqual(json.loads(self.fetch(job_id).result_json), {"exam_id": session_id})

    async def test_exam_deleted_during_generation_is_not_recreated(self):
        with self.sessions() as db:
            session = ExamSession(user_id=self.owner, status="generating")
            db.add(session); db.flush(); session_id = session.id
            job = background.enqueue_job(db, self.owner, "exam", "Exam", {"session_id": session_id,
                "subject_ids": [self.subject], "topic_ids": [], "count": 1, "prompt": "private"})
            db.commit(); job_id = job.id
        async def fake_ai(*args, **kwargs):
            with self.sessions() as db:
                db.delete(db.get(ExamSession, session_id)); db.commit()
            return json.dumps([{"question": "Deleted exam", "reference": "Private"}])
        with patch.object(exam, "generate_content", fake_ai):
            await background.process_one_job()
        with self.sessions() as db:
            self.assertEqual(db.query(ExamSession).count(), 0)
            self.assertEqual(db.query(ExamQuestion).count(), 0)
        self.assertEqual(self.fetch(job_id).status, "error")

    async def test_exam_start_preserves_response_while_job_is_durable(self):
        original_wait = background.await_job_result
        async def process_then_wait(job_id, user_id):
            self.assertEqual(self.fetch(job_id).status, "queued")
            await background.process_one_job()
            return await original_wait(job_id, user_id)
        with self.sessions() as db:
            with patch.object(background, "await_job_result", process_then_wait), patch.object(exam,
                    "generate_content", AsyncMock(return_value='[{"question":"Explain Python","reference":"Language"}]')):
                result = await exam.start_exam(exam.StartRequest(subject_ids=[self.subject],
                    topic_ids=[self.topic], count=1), db, db.get(User, self.owner))
            self.assertEqual(result["status"], "active")
            self.assertEqual(result["subject_ids"], [self.subject])
            self.assertEqual(len(result["questions"]), 1)
            self.assertNotIn("reference", result["questions"][0])
            job = db.query(AIJob).filter(AIJob.kind == "exam").one()
            self.assertEqual(job.status, "done")
            self.assertEqual(json.loads(job.result_json), {"exam_id": result["id"]})


if __name__ == "__main__":
    unittest.main()
