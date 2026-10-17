"""Group selection connects a real new account to the shared learning program."""
import json
import os
import unittest
from datetime import datetime
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import create_access_token, hash_password
from app.career_models import CareerSettings
from app.config import settings
from app.database import Base, get_db
from app.models import (Course, CurriculumWeek, ModuleWork, Note, ScheduleEntry,
    StudentGroup, SyllabusDocument, TestSession as StudyTest, User, WeekProgress,
    WorkSubmission)
from app.operational_models import AuditLog
from app.routers import academic, admin, auth_routes, career, learning, notes
from app.security import _attempts
from app.services.learning_context import build_learning_context


class RegistrationGroupTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.password = "Registration-pass-2026"
        cls.password_hash = hash_password(cls.password)

    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            first = StudentGroup(name="ИП-26-3кс", curator="Not public", description="Not public")
            second = StudentGroup(name="А-26-1", curator="Also private")
            db.add_all([first, second])
            db.flush()
            self.first_id, self.second_id = first.id, second.id
            admin_user = User(email="admin@example.com", hashed_password=self.password_hash, role="admin")
            legacy = User(email="legacy@example.com", hashed_password=self.password_hash, role="student")
            db.add_all([admin_user, legacy, CareerSettings(id=1)])
            db.commit()
            self.admin_id, self.legacy_id = admin_user.id, legacy.id
        app = FastAPI()
        for module in (auth_routes, admin, academic, career, learning, notes):
            app.include_router(module.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app)
        self.registration = patch.object(settings, "REGISTRATION_ENABLED", True)
        self.registration.start()
        _attempts.clear()

    def tearDown(self):
        self.client.close()
        self.registration.stop()
        self.engine.dispose()
        _attempts.clear()

    def register(self, **changes):
        return self.client.post("/api/auth/register", json={"email": "new@example.com",
            "name": "Новый студент", "password": self.password,
            "group_id": self.second_id, **changes})

    def use_token(self, token):
        self.client.headers["Authorization"] = "Bearer " + token

    def program(self, group_id, label):
        with self.sessions() as db:
            course = Course(group_id=group_id, title=f"Дисциплина {label}")
            db.add(course)
            db.flush()
            document = SyllabusDocument(course_id=course.id, title=f"Силабус {label}",
                filename="program.pdf", filepath="syllabi/not-read.pdf", size=100,
                status="published", summary=f"Программа {label}")
            db.add(document)
            db.flush()
            week = CurriculumWeek(course_id=course.id, week_number=1, title=f"Тема {label}",
                module=f"Модуль {label}", content=f"Материал {label}", source_syllabus_id=document.id)
            work = ModuleWork(course_id=course.id, title=f"Работа {label}", module=f"Модуль {label}",
                week_number=1, source_syllabus_id=document.id)
            schedule = ScheduleEntry(course_id=course.id, day_of_week=1, start_time="09:00", room="203")
            db.add_all([week, work, schedule])
            db.commit()
            return {"course": course.id, "week": week.id, "work": work.id,
                "syllabus": document.id, "schedule": schedule.id}

    def test_public_choices_are_sorted_and_expose_only_id_and_name(self):
        response = self.client.get("/api/auth/registration-groups")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), [{"id": self.second_id, "name": "А-26-1"},
            {"id": self.first_id, "name": "ИП-26-3кс"}])
        self.assertEqual(self.client.get("/api/groups").status_code, 401)

    def test_selected_group_is_saved_and_returned_by_registration_login_and_existing_token(self):
        response = self.register()
        self.assertEqual(response.status_code, 201, response.text)
        account = response.json()
        self.assertEqual(account["group_id"], self.second_id)
        self.assertEqual(account["user"]["group_id"], self.second_id)
        self.assertEqual(account["role"], "student")
        self.use_token(account["access_token"])
        self.assertEqual(self.client.get("/api/auth/me").json()["group_id"], self.second_id)
        login = self.client.post("/api/auth/login", data={"username": "new@example.com", "password": self.password})
        self.assertEqual(login.status_code, 200, login.text)
        self.assertEqual(login.json()["user"]["group_id"], self.second_id)
        with self.sessions() as db:
            self.assertEqual(db.get(User, account["id"]).group_id, self.second_id)
            self.assertIsNone(db.get(User, self.legacy_id).group_id)

    def test_missing_or_cleared_group_cannot_silently_join_a_default_group(self):
        for payload in ({"email": "missing@example.com", "password": self.password},
                        {"email": "null@example.com", "password": self.password, "group_id": None}):
            response = self.client.post("/api/auth/register", json=payload)
            self.assertEqual(response.status_code, 422, response.text)
            self.assertIn("группу", response.json()["detail"])
        with self.sessions() as db:
            self.assertEqual(db.query(User).count(), 2)
            self.assertIsNone(db.get(User, self.legacy_id).group_id)

    def test_invalid_and_deleted_groups_do_not_create_an_account(self):
        with self.sessions() as db:
            db.delete(db.get(StudentGroup, self.second_id))
            db.commit()
        response = self.register()
        self.assertEqual(response.status_code, 422, response.text)
        self.assertIn("недоступна", response.json()["detail"])
        with self.sessions() as db:
            self.assertEqual(db.query(User).count(), 2)

    def test_group_ids_are_strict_positive_integers_and_privilege_fields_are_rejected(self):
        for value in (0, -1, True, 1.5, str(self.second_id), [], {}):
            with self.subTest(group_id=value):
                self.assertEqual(self.register(group_id=value).status_code, 422)
        for field, value in (("role", "admin"), ("is_active", False), ("token_version", 123)):
            with self.subTest(field=field):
                self.assertEqual(self.register(**{field: value}).status_code, 422)
        with self.sessions() as db:
            self.assertEqual(db.query(User).count(), 2)

    def test_disabled_registration_denies_choices_and_creation_without_mutation(self):
        with patch.object(settings, "REGISTRATION_ENABLED", False):
            self.assertEqual(self.client.get("/api/auth/registration-groups").status_code, 403)
            self.assertEqual(self.register().status_code, 403)
        with self.sessions() as db:
            self.assertEqual(db.query(User).count(), 2)

    def test_empty_install_can_register_without_inventing_a_group(self):
        with self.sessions() as db:
            db.query(StudentGroup).delete()
            db.commit()
        self.assertEqual(self.client.get("/api/auth/registration-groups").json(), [])
        response = self.client.post("/api/auth/register", json={"email": "empty@example.com", "password": self.password})
        self.assertEqual(response.status_code, 201, response.text)
        self.assertIsNone(response.json()["group_id"])

    def test_new_student_has_schedule_syllabi_modules_and_group_scoped_learning_tools(self):
        own = self.program(self.second_id, "своей группы")
        other = self.program(self.first_id, "другой группы")
        registered = self.register()
        self.assertEqual(registered.status_code, 201, registered.text)
        self.use_token(registered.json()["access_token"])
        group = self.client.get(f"/api/groups/{self.second_id}").json()
        self.assertEqual([row["id"] for row in group["courses"]], [own["course"]])
        self.assertEqual(group["schedule"][0]["room"], "203")
        course = self.client.get(f"/api/courses/{own['course']}")
        self.assertEqual(course.status_code, 200, course.text)
        self.assertEqual(course.json()["weeks"][0]["id"], own["week"])
        self.assertEqual(course.json()["works"][0]["id"], own["work"])
        self.assertEqual(course.json()["syllabi"][0]["id"], own["syllabus"])
        filtered = self.client.get("/api/syllabi", params={"group_id": self.second_id})
        self.assertEqual(filtered.status_code, 200, filtered.text)
        self.assertEqual([row["id"] for row in filtered.json()], [own["syllabus"]])
        options = self.client.get("/api/learning/options").json()["courses"]
        self.assertEqual([row["id"] for row in options], [own["course"]])
        self.assertEqual(options[0]["modules"], ["Модуль своей группы"])
        self.assertEqual(self.client.put(f"/api/weeks/{own['week']}/progress", json={"completed": True}).status_code, 200)
        self.assertEqual(self.client.put(f"/api/weeks/{other['week']}/progress", json={"completed": True}).status_code, 403)
        submitted = self.client.put(f"/api/works/{own['work']}/submission", json={"content": "Мой ответ", "status": "submitted"})
        self.assertEqual(submitted.status_code, 200, submitted.text)
        self.assertEqual(self.client.put(f"/api/works/{other['work']}/submission", json={"content": "Чужой", "status": "submitted"}).status_code, 403)
        workspace = self.client.get("/api/career/me")
        self.assertEqual(workspace.status_code, 200, workspace.text)
        self.assertEqual(workspace.json()["profile"]["group_id"], self.second_id)
        self.assertEqual(workspace.json()["activity"]["completed_weeks"], 1)
        with self.sessions() as db:
            student = db.get(User, registered.json()["id"])
            context = build_learning_context(db, student, {"course_id": own["course"]})
            self.assertIn("Тема своей группы", context.text)
            with self.assertRaises(HTTPException) as rejected:
                build_learning_context(db, student, {"course_id": other["course"]})
            self.assertEqual(rejected.exception.status_code, 403)

    def test_admin_group_change_updates_existing_session_scope_and_preserves_personal_history(self):
        old = self.program(self.second_id, "прежней группы")
        new = self.program(self.first_id, "новой группы")
        account = self.register().json()
        student_token = account["access_token"]
        self.use_token(student_token)
        note = self.client.post("/api/notes", json={"title": "Моя заметка", "content": "Не потерять"}).json()
        self.assertEqual(self.client.put(f"/api/weeks/{old['week']}/progress", json={"completed": True}).status_code, 200)
        self.assertEqual(self.client.put(f"/api/works/{old['work']}/submission", json={"content": "Мой прежний ответ", "status": "submitted"}).status_code, 200)
        with self.sessions() as db:
            history = StudyTest(user_id=account["id"], status="finished", score=100, finished_at=datetime.utcnow())
            db.add(history)
            db.commit()
            test_id = history.id
        self.assertEqual(self.client.patch("/api/auth/me", json={"name": "Подмена", "group_id": self.first_id}).status_code, 422)
        self.assertEqual(self.client.patch(f"/api/admin/users/{account['id']}", json={"group_id": self.first_id}).status_code, 403)
        self.use_token(create_access_token(self.admin_id))
        changed = self.client.patch(f"/api/admin/users/{account['id']}", json={"group_id": self.first_id})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual(changed.json()["group_id"], self.first_id)
        self.assertEqual(self.client.patch(f"/api/admin/users/{account['id']}", json={"group_id": 99999}).status_code, 404)
        self.use_token(student_token)
        self.assertEqual(self.client.get("/api/auth/me").json()["group_id"], self.first_id)
        self.assertEqual([row["id"] for row in self.client.get("/api/learning/options").json()["courses"]], [new["course"]])
        self.assertEqual(self.client.put(f"/api/weeks/{old['week']}/progress", json={"completed": True}).status_code, 403)
        self.assertEqual(self.client.put(f"/api/weeks/{new['week']}/progress", json={"completed": True}).status_code, 200)
        workspace = self.client.get("/api/career/me").json()
        self.assertEqual(workspace["profile"]["group_id"], self.first_id)
        self.assertEqual(workspace["activity"]["completed_weeks"], 1)
        self.assertEqual(self.client.get("/api/notes").json()[0]["id"], note["id"])
        with self.sessions() as db:
            self.assertEqual(db.get(User, account["id"]).group_id, self.first_id)
            self.assertEqual(db.get(StudyTest, test_id).score, 100)
            self.assertEqual(db.get(Note, note["id"]).content, "Не потерять")
            self.assertEqual(db.query(WeekProgress).filter_by(user_id=account["id"]).count(), 2)
            self.assertEqual(db.query(WorkSubmission).filter_by(user_id=account["id"]).one().content, "Мой прежний ответ")
            event = db.query(AuditLog).filter_by(action="user.update", object_id=str(account["id"])).one()
            self.assertIn("group_id", json.loads(event.fields_json))


if __name__ == "__main__":
    unittest.main()
