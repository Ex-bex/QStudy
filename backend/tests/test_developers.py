"""Public contact data, administrator changes and one-time seed regression tests."""
import json
import os
import unittest
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import create_access_token
from app.database import Base, get_db
from app.models import AcademicSetting, DeveloperDepartment, User
from app.operational_models import AuditLog
from app.routers import developers
from app.services.developers import DEPARTMENTS, SEED_KEY, seed_developer_departments


class DeveloperDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            admin = User(email="admin-private@example.com", name="PRIVATE_ACCOUNT_NAME",
                         role="admin", hashed_password="PRIVATE_ACCOUNT_HASH")
            student = User(email="student-private@example.com", role="student", hashed_password="PRIVATE_ACCOUNT_HASH")
            db.add_all([admin, student]); db.commit()
            self.admin_id, self.student_id = admin.id, student.id
        app = FastAPI()
        app.include_router(developers.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def as_user(self, user_id):
        self.client.headers["Authorization"] = "Bearer " + create_access_token(user_id)

    def seed(self):
        with self.sessions() as db:
            return seed_developer_departments(db)

    def test_public_directory_has_exact_provided_names_and_no_invented_contacts(self):
        self.assertEqual(self.seed(), 4)
        response = self.client.get("/api/developers")
        self.assertEqual(response.status_code, 200)
        rows = response.json()["departments"]
        self.assertEqual([(row["name"], row["director"], row["logo"]) for row in rows], list(DEPARTMENTS))
        self.assertEqual([row["display_order"] for row in rows], [0, 10, 20, 30])
        for row in rows:
            for field in ("email", "telegram", "website", "description"):
                self.assertEqual(row[field], "")
            self.assertEqual(set(row), {"id", "name", "director", "description", "email", "telegram", "website", "logo", "logo_url", "logo_custom", "director_photo_url", "director_photo_custom", "display_order"})
            self.assertFalse(row["logo_custom"])
            self.assertIsNone(row["director_photo_url"])
            self.assertFalse(row["director_photo_custom"])
            self.assertEqual(row["logo_url"], f'/brand/qforce_logo_{row["logo"]}.jpeg')
        self.assertNotIn("PRIVATE", response.text)
        self.assertNotIn("admin-private", response.text)
        self.assertNotIn("created_at", response.text)

    def test_every_mutation_requires_current_active_administrator(self):
        self.seed()
        paths = [("post", "/api/developers/departments", {"name": "Support"}),
                 ("patch", "/api/developers/departments/1", {"name": "Changed"}),
                 ("delete", "/api/developers/departments/1", None)]
        for role, expected in ((None, 401), (self.student_id, 403)):
            if role:
                self.as_user(role)
            for method, path, data in paths:
                response = self.client.request(method, path, **({"json": data} if data is not None else {}))
                self.assertEqual(response.status_code, expected, response.text)
        self.as_user(self.admin_id)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "student"; db.commit()
        self.assertEqual(self.client.patch(paths[1][1], json={"name": "Denied"}).status_code, 403)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "admin"
            db.get(User, self.admin_id).is_active = False; db.commit()
        self.assertEqual(self.client.delete(paths[2][1]).status_code, 401)
        with self.sessions() as db:
            self.assertEqual(db.query(DeveloperDepartment).count(), 4)
            self.assertEqual(db.query(AuditLog).count(), 1)

    def test_admin_crud_partial_updates_clearing_contacts_order_and_audit(self):
        self.seed(); self.as_user(self.admin_id)
        payload = {"name": "  Support  ", "director": "A Director", "description": "Contact the team",
                   "email": "team@example.com", "telegram": "@qforce_team", "website": "https://example.com/about#team",
                   "logo": "main", "display_order": 5}
        response = self.client.post("/api/developers/departments", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        row = response.json(); department_id = row["id"]
        self.assertEqual(row["name"], "Support")
        self.assertEqual(row["logo_url"], "/brand/qforce_logo_main.png")
        self.assertEqual(row["telegram"], "https://t.me/qforce_team")
        self.assertEqual(row["website"], "https://example.com/about")
        path = f"/api/developers/departments/{department_id}"
        response = self.client.patch(path, json={"director": "Updated Director", "display_order": 0})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["name"], "Support")
        self.assertEqual(response.json()["email"], "team@example.com")
        self.assertEqual(self.client.get("/api/developers").json()["departments"][1]["id"], department_id)
        self.assertEqual(self.client.patch(path, json={"email": "", "telegram": "", "website": ""}).status_code, 200)
        self.assertEqual(self.client.delete(path).status_code, 200)
        self.assertEqual(self.client.patch(path, json={"name": "Gone"}).status_code, 404)
        self.assertEqual(self.client.delete(path).status_code, 404)
        with self.sessions() as db:
            events = db.query(AuditLog).filter(AuditLog.actor_id == self.admin_id).order_by(AuditLog.id).all()
            self.assertEqual([event.action for event in events], ["developer_department.create", "developer_department.update", "developer_department.update", "developer_department.delete"])
            self.assertTrue(all(event.object_id == str(department_id) for event in events))
            self.assertEqual(json.loads(events[1].fields_json), ["director", "display_order"])
            stored = " ".join(event.fields_json + event.metadata_json for event in events)
            for value in ("team@example.com", "qforce_team", "Updated Director", "Contact the team"):
                self.assertNotIn(value, stored)

    def test_contacts_logo_bounds_and_unknown_fields_reject_unsafe_values(self):
        self.as_user(self.admin_id)
        cases = [("website", value) for value in (
            "javascript:alert(1)", "data:text/html,test", "file:///C:/private", "//example.com", "https://localhost",
            "http://127.0.0.1", "http://10.1.2.3", "https://[::1]", "https://service.internal", "https://user:pass@example.com",
            "https://example.com/?token=private", "https://example.com:8080", "https://example.com\\@localhost")]
        cases += [("telegram", value) for value in ("https://evil.example/qforce", "https://t.me/qforce?text=send", "https://t.me/+invite",
                  "https://t.me/qforce/path", "http://t.me/qforce", "@abc", "@user name", "https://user:pass@t.me/qforce")]
        cases += [("logo", "../../private"), ("logo", "busines"), ("logo", "https://example.com/image"),
                  ("email", "not-an-email"), ("name", " "), ("director", "x" * 201), ("description", "x" * 4001),
                  ("display_order", True), ("display_order", "1"), ("display_order", -1), ("display_order", 10001),
                  ("unexpected", "value")]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                response = self.client.post("/api/developers/departments", json={"name": "Test", key: value})
                self.assertEqual(response.status_code, 422, response.text)
        with self.sessions() as db:
            self.assertEqual(db.query(DeveloperDepartment).count(), 0)
            self.assertEqual(db.query(AuditLog).count(), 0)

    def test_telegram_canonical_forms_and_null_patch_rejected(self):
        self.as_user(self.admin_id)
        for value in ("qforce_team", "@qforce_team", "https://t.me/qforce_team"):
            response = self.client.post("/api/developers/departments", json={"name": "Test", "telegram": value})
            self.assertEqual(response.status_code, 201, response.text)
            self.assertEqual(response.json()["telegram"], "https://t.me/qforce_team")
        for key in developers.DepartmentInput.model_fields:
            response = self.client.patch("/api/developers/departments/1", json={key: None})
            self.assertEqual(response.status_code, 422, (key, response.text))
        self.assertEqual(self.client.patch("/api/developers/departments/1", json={"name": ""}).status_code, 422)
        self.assertEqual(self.client.patch("/api/developers/departments/1", json={}).status_code, 200)

    def test_seed_never_recreates_deleted_rows_or_overwrites_edits(self):
        self.assertEqual(self.seed(), 4)
        with self.sessions() as db:
            db.get(DeveloperDepartment, 1).director = "Administrator correction"
            db.get(DeveloperDepartment, 1).email = "new@example.com"
            db.delete(db.get(DeveloperDepartment, 2)); db.commit()
        self.assertEqual(self.seed(), 0)
        with self.sessions() as db:
            self.assertEqual(db.query(DeveloperDepartment).count(), 3)
            self.assertEqual(db.get(DeveloperDepartment, 1).director, "Administrator correction")
            self.assertEqual(db.get(DeveloperDepartment, 1).email, "new@example.com")
            db.query(DeveloperDepartment).delete(); db.commit()
        self.assertEqual(self.seed(), 0)
        self.assertEqual(self.client.get("/api/developers").json(), {"departments": []})

    def test_audit_failure_rolls_back_mutation_and_seed_remains_atomic(self):
        self.as_user(self.admin_id)
        with patch("app.routers.developers.record_audit", side_effect=RuntimeError("audit unavailable")):
            self.assertEqual(self.client.post("/api/developers/departments", json={"name": "Not committed"}).status_code, 500)
        with self.sessions() as db:
            self.assertEqual(db.query(DeveloperDepartment).count(), 0)
        with self.sessions() as db, patch("app.services.developers.record_audit", side_effect=RuntimeError("audit unavailable")):
            with self.assertRaises(RuntimeError):
                seed_developer_departments(db)
        with self.sessions() as db:
            self.assertIsNone(db.get(AcademicSetting, SEED_KEY))
            self.assertEqual(db.query(DeveloperDepartment).count(), 0)
        self.assertEqual(self.seed(), 4)

    def test_upgrade_creates_table_and_seeds_once_without_touching_existing_users(self):
        from app import main
        DeveloperDepartment.__table__.drop(self.engine)
        with patch.object(main, "engine", self.engine), patch.object(main, "SessionLocal", self.sessions), \
             patch("app.services.syllabus.seed_academic_defaults"), \
             patch("app.services.reference_curriculum.seed_sourced_curriculum"), \
             patch("app.services.reference_timetable.seed_sourced_timetable"):
            main.initialize_database()
            self.assertIn("developer_departments", inspect(self.engine).get_table_names())
            with self.sessions() as db:
                self.assertEqual(db.query(DeveloperDepartment).count(), 4)
                self.assertEqual(db.query(User).count(), 2)
                self.assertEqual(db.get(User, self.admin_id).name, "PRIVATE_ACCOUNT_NAME")
                db.delete(db.get(DeveloperDepartment, 1)); db.commit()
            main.initialize_database()
            with self.sessions() as db:
                self.assertEqual(db.query(DeveloperDepartment).count(), 3)
        self.assertIn("/api/developers", main.app.openapi()["paths"])


if __name__ == "__main__":
    unittest.main()
