"""Chat research privacy, persistent provenance and owner-scoped API tests."""
import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_current_user
from app.config import settings
from app.database import Base, get_db
from app.models import ChatMessage, Course, CurriculumWeek, ModuleWork, Note, StudentGroup, User
from app.routers.chat import router


class ChatResearchTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            group, other = StudentGroup(name="ИП-26-3кс"), StudentGroup(name="Another private group")
            db.add_all([group, other]); db.flush()
            self.student = User(name="Private Student", email="private-student@fixture.example",
                hashed_password="unused", role="student", is_active=True, group_id=group.id)
            self.peer = User(name="Peer Student", email="peer@fixture.example",
                hashed_password="unused", role="student", is_active=True, group_id=group.id)
            self.course = Course(group_id=group.id, title="SQL", teacher="PRIVATE_TEACHER_NAME")
            self.other_course = Course(group_id=other.id, title="Foreign course")
            db.add_all([self.student, self.peer, self.course, self.other_course]); db.flush()
            db.add(CurriculumWeek(course_id=self.course.id, week_number=2, title="JOIN statements",
                content="PRIVATE_UPLOADED_SOURCE", tasks="PRIVATE_STUDENT_TASK_REQUIREMENT"))
            db.add(Note(user_id=self.student.id, title="SQL private note", content="SQL PRIVATE_NOTE_CONTENT"))
            db.commit()
        self.actor = self.student
        app = FastAPI(); app.include_router(router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)
        self.addCleanup(self.client.close)
        self.addCleanup(self.engine.dispose)
        self.metadata = {"status": "verified", "checked_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
            "sources": [{"title": "Official SQL source", "url": "https://www.postgresql.org/docs/current/queries-table-expressions.html"}],
            "warnings": [], "search_suggestions_html": '<div><a href="https://www.google.com/search?q=SQL">SQL</a></div>'}

    def test_selected_lesson_search_excludes_private_rag_context_and_metadata_persists(self):
        with patch("app.routers.chat.research_public_topic", AsyncMock(return_value=("Current public SQL details", self.metadata))) as research, \
                patch("app.routers.chat.chat_completion", AsyncMock(return_value="SQL explanation")) as completion:
            response = self.client.post("/api/chat/send", json={"message": "SQL: объясни мой ответ с PRIVATE_STUDENT_ANSWER",
                "use_web": True, "context": {"course_id": self.course.id, "week_number": 2}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(research.call_args.args, ("SQL — JOIN statements",))
        system, history = completion.call_args.args
        for private in ("PRIVATE_TEACHER_NAME", "PRIVATE_UPLOADED_SOURCE", "PRIVATE_STUDENT_TASK_REQUIREMENT", "PRIVATE_NOTE_CONTENT"):
            self.assertIn(private, system)
            self.assertNotIn(private, research.call_args.args[0])
        self.assertIn("PRIVATE_STUDENT_ANSWER", history[-1]["parts"][0]["text"])
        result = response.json()
        assistant = result["assistant_message"]
        self.assertNotIn("source_context_json", assistant)
        self.assertEqual(assistant["source_context"]["research"]["status"], "verified")
        self.assertEqual(assistant["source_context"]["research"]["sources"], self.metadata["sources"])
        messages = self.client.get(f"/api/chat/sessions/{result['session_id']}/messages")
        self.assertEqual(messages.status_code, 200)
        self.assertEqual(messages.json()[-1]["source_context"], assistant["source_context"])
        with self.sessions() as db:
            stored = db.get(ChatMessage, assistant["id"])
            source = json.loads(stored.source_context_json)
            self.assertEqual(source["research"]["status"], "verified")
            self.assertNotIn("PRIVATE_", stored.source_context_json)
        self.actor = self.peer
        self.assertEqual(self.client.get(f"/api/chat/sessions/{result['session_id']}/messages").status_code, 404)

    def test_private_question_uses_local_answer_without_public_search(self):
        with patch("app.services.ai._post_gemini", AsyncMock()) as search_provider, \
                patch("app.routers.chat.chat_completion", AsyncMock(return_value="Local explanation")) as completion:
            response = self.client.post("/api/chat/send", json={"message": "Моя заметка: пароль private-credential",
                "use_web": True})
        self.assertEqual(response.status_code, 200, response.text)
        search_provider.assert_not_called()
        research = response.json()["assistant_message"]["source_context"]["research"]
        self.assertEqual(research["status"], "no_sources")
        self.assertEqual(research["sources"], [])
        self.assertIn("интернет не проверен", completion.call_args.args[0])

    def test_unselected_public_question_never_sends_history_or_user_identity_to_research(self):
        with patch("app.routers.chat.chat_completion", AsyncMock(return_value="Local reply")):
            first = self.client.post("/api/chat/send", json={"message": "PRIVATE_PREVIOUS_CHAT_CONTEXT"}).json()
        with patch("app.routers.chat.research_public_topic", AsyncMock(return_value=("Current public explanation", self.metadata))) as research, \
                patch("app.routers.chat.chat_completion", AsyncMock(return_value="Public answer")):
            response = self.client.post("/api/chat/send", json={"session_id": first["session_id"],
                "message": "Объясни функции Python", "use_web": True,
                "context": {"task": {"question": "PRIVATE_ACTIVE_TASK"}, "lecture": {"content": "PRIVATE_ACTIVE_LECTURE"}}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(research.call_args.args, ("Объясни функции Python",))
        self.assertNotIn("PRIVATE", research.call_args.args[0])
        self.assertNotIn(self.student.email, research.call_args.args[0])

    def test_default_web_setting_preserves_existing_chat_completion_contract(self):
        with patch("app.routers.chat.research_public_topic", AsyncMock()) as research, \
                patch("app.routers.chat.chat_completion", AsyncMock(return_value="Normal answer")) as completion:
            response = self.client.post("/api/chat/send", json={"message": "Объясни SQL"})
        self.assertEqual(response.status_code, 200, response.text)
        research.assert_not_called()
        self.assertEqual(completion.await_count, 1)
        self.assertEqual(response.json()["assistant_message"]["source_context"]["research"]["status"], "disabled")

    def test_foreign_course_rejected_before_search_or_message_mutation(self):
        with patch("app.routers.chat.research_public_topic", AsyncMock()) as research, \
                patch("app.routers.chat.chat_completion", AsyncMock()) as completion:
            response = self.client.post("/api/chat/send", json={"message": "Explain lesson", "use_web": True,
                "context": {"course_id": self.other_course.id}})
        self.assertEqual(response.status_code, 403)
        research.assert_not_called(); completion.assert_not_called()
        with self.sessions() as db:
            self.assertEqual(db.query(ChatMessage).count(), 0)

    def test_flat_selection_limits_answer_context_and_persists_exact_curriculum_provenance(self):
        with self.sessions() as db:
            db.query(CurriculumWeek).filter_by(course_id=self.course.id).one().module = "SQL joins"
            db.add(CurriculumWeek(course_id=self.course.id, week_number=3, title="Unselected topic",
                module="SQL security", content="UNSELECTED_MODULE_CONTENT"))
            selected_work = ModuleWork(course_id=self.course.id, title="JOIN exercise", module="SQL joins",
                week_number=2, description="SELECTED_WORK_REQUIREMENT")
            other_work = ModuleWork(course_id=self.course.id, title="Different exercise", module="SQL joins",
                week_number=2, description="UNSELECTED_WORK_REQUIREMENT")
            db.add_all([selected_work, other_work]); db.commit()
            selected_work_id = selected_work.id
        with patch("app.routers.chat.research_public_topic", AsyncMock(return_value=("Public research", self.metadata))) as research, \
                patch("app.routers.chat.chat_completion", AsyncMock(return_value="Selected work explanation")) as completion:
            response = self.client.post("/api/chat/send", json={"message": "Explain assignment", "use_web": True,
                "course_id": self.course.id, "module": "SQL joins", "week_numbers": [2],
                "work_ids": [selected_work_id], "context": {"page": "chat"}})
        self.assertEqual(response.status_code, 200, response.text)
        system = completion.call_args.args[0]
        self.assertIn("SELECTED_WORK_REQUIREMENT", system)
        for private in ("UNSELECTED_MODULE_CONTENT", "UNSELECTED_WORK_REQUIREMENT", "PRIVATE_NOTE_CONTENT", "PRIVATE_TEACHER_NAME"):
            self.assertNotIn(private, system)
        self.assertEqual(research.call_args.args, ("SQL — JOIN exercise",))
        source = response.json()["assistant_message"]["source_context"]
        self.assertEqual(source["mode"], "course")
        self.assertEqual(source["module"], "SQL joins")
        self.assertEqual(source["week_numbers"], [2])
        self.assertEqual(source["work_ids"], [selected_work_id])
        self.assertEqual(source["weeks"], [])
        self.assertEqual([work["id"] for work in source["works"]], [selected_work_id])

    def test_flat_selection_rejects_incompatible_or_foreign_work_before_search(self):
        with self.sessions() as db:
            foreign = ModuleWork(course_id=self.other_course.id, title="Foreign work")
            db.add(foreign); db.commit(); foreign_id = foreign.id
        with patch("app.routers.chat.research_public_topic", AsyncMock()) as research:
            for body in ({"course_id": self.course.id, "work_ids": [foreign_id]},
                         {"course_id": self.course.id, "week_numbers": [40]},
                         {"course_id": self.course.id, "context": {"course_id": self.other_course.id}}):
                response = self.client.post("/api/chat/send", json={"message": "Explain assignment", "use_web": True, **body})
                self.assertEqual(response.status_code, 422, response.text)
            research.assert_not_called()
        with self.sessions() as db:
            self.assertEqual(db.query(ChatMessage).count(), 0)


if __name__ == "__main__":
    unittest.main()
