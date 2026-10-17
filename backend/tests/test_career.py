"""QCareer authorization, real curriculum proof, planning and persistence regressions."""
import json
import os
import sqlite3
import tempfile
import unittest
from datetime import datetime, timedelta
from contextlib import closing
from pathlib import Path

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_current_user
from app.career_models import (CareerDirection, CareerLearningLink, CareerOpportunity,
    CareerProfile, CareerSavedOpportunity, CareerSettings, CareerSkill)
from app.database import Base, get_db
from app.models import (Course, CurriculumWeek, ModuleWork, StudentGroup, SyllabusDocument,
    TestSession as StudyTest, User, WeekProgress, WorkSubmission)
from app.operational_models import AuditLog
from app.routers.career import router
from app.services import career
from app.services.audit import initialize_operations
from app.services.backups import BackupService, restore_backup
from app.services.learning_context import build_learning_context, dump_learning_provenance


class CareerApiTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        initialize_operations(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            group = StudentGroup(name="ИП-26-3кс")
            other = StudentGroup(name="Другая группа")
            db.add_all([group, other])
            db.flush()
            self.group_id, self.other_group_id = group.id, other.id
            self.admin = User(email="admin@example.test", name="Администратор", role="admin", hashed_password="original-admin-hash", group_id=group.id)
            self.student = User(email="student@example.test", name="Студент", role="student", hashed_password="original-student-hash", group_id=group.id)
            self.peer = User(email="peer@example.test", name="Другой студент", role="student", hashed_password="original-peer-hash", group_id=group.id)
            self.outsider = User(email="outsider@example.test", name="Чужая группа", role="student", hashed_password="original-outsider-hash", group_id=other.id)
            db.add_all([self.admin, self.student, self.peer, self.outsider])
            course = Course(group_id=group.id, title="Основы программирования")
            foreign = Course(group_id=other.id, title="Основы программирования")
            db.add_all([course, foreign])
            db.flush()
            self.course_id, self.foreign_course_id = course.id, foreign.id
            syllabus = SyllabusDocument(course_id=course.id, title="Программа", filename="program.pdf", filepath="", size=0, status="published")
            db.add(syllabus)
            db.flush()
            self.syllabus_id = syllabus.id
            week = CurriculumWeek(course_id=course.id, week_number=1, title="Алгоритмы", module="Модуль 1", source_syllabus_id=syllabus.id)
            week2 = CurriculumWeek(course_id=course.id, week_number=2, title="Функции", module="Модуль 2")
            work = ModuleWork(course_id=course.id, title="Практическая работа", module="Модуль 1", week_number=1, max_score=20, source_syllabus_id=syllabus.id)
            foreign_week = CurriculumWeek(course_id=foreign.id, week_number=1, title="Алгоритмы", module="Модуль 1")
            db.add_all([week, week2, work, foreign_week])
            db.commit()
            self.week_id, self.work_id = week.id, work.id
            career.initialize_career(db)
            skill = CareerSkill(slug="verified-example", name="Проверяемый навык", category="Практика")
            db.add(skill)
            db.flush()
            direction = CareerDirection(slug="student-path", title="Направление студента",
                requirements_json=json.dumps([{"skill_id": skill.id, "level": 4}]))
            db.add(direction)
            db.commit()
            self.skill_id, self.direction_id = skill.id, direction.id
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

    def link(self, **kwargs):
        payload = {"skill_id": self.skill_id, "course_id": self.course_id, "target_level": 3, **kwargs}
        self.actor = self.admin
        response = self.client.post("/api/admin/career/learning-links", json=payload)
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def finished_test(self, actor=None, score=90, **selection):
        actor = actor or self.student
        with self.sessions() as db:
            context = build_learning_context(db, actor, {"course_id": self.course_id, **selection})
            row = StudyTest(user_id=actor.id, status="finished", score=score, finished_at=datetime.utcnow(),
                source_context_json=dump_learning_provenance(context.provenance))
            db.add(row)
            db.commit()
            return row.id

    def personal(self, actor=None):
        self.actor = actor or self.student
        response = self.client.get("/api/career/me")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def measured_skill(self, actor=None):
        return next(row for row in self.personal(actor)["skills"] if row["id"] == self.skill_id)

    def test_config_is_public_and_existing_identity_and_no_employee_accounts(self):
        response = self.client.get("/api/career/config")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["accent"], "orange")
        self.assertIn("logo_url", response.json())
        with self.sessions() as db:
            self.assertEqual(db.query(User).count(), 4)
            self.assertEqual(db.get(User, self.student.id).hashed_password, "original-student-hash")
            self.assertEqual(db.query(Course).count(), 2)

    def test_all_admin_routes_reject_student_and_anonymous_auth_required(self):
        self.actor = self.student
        requests = [("get", "/overview", None), ("get", "/students", None), ("get", f"/students/{self.peer.id}", None),
            ("get", "/sources", None), ("get", "/skills", None), ("get", "/directions", None),
            ("get", "/learning-links", None), ("get", "/opportunities", None), ("get", "/config", None),
            ("patch", "/config", {"enabled": False}), ("post", "/skills", {"slug": "x", "name": "x"}),
            ("patch", f"/skills/{self.skill_id}", {"name": "X"}), ("delete", f"/skills/{self.skill_id}", None),
            ("post", "/directions", {"slug": "x", "title": "X"}),
            ("post", "/learning-links/suggest", {}), ("post", "/learning-links/apply-suggestions", {"course_ids": [self.course_id]}),
            ("post", "/learning-links", {"course_id": self.course_id, "skill_id": self.skill_id}),
            ("post", "/opportunities", {"title": "X"})]
        for method, suffix, payload in requests:
            response = getattr(self.client, method)("/api/admin/career" + suffix, **({"json": payload} if payload is not None else {}))
            self.assertEqual(response.status_code, 403, suffix)
        self.client.app.dependency_overrides.pop(get_current_user)
        self.assertEqual(self.client.get("/api/career/me").status_code, 401)
        self.assertEqual(self.client.get("/api/career/config").status_code, 200)

    def test_completed_exact_test_awards_max_level_once_without_database_skill_writes(self):
        low = self.link(target_level=2, min_score=60)
        high = self.link(target_level=4, min_score=85)
        test_id = self.finished_test(score=90)
        first = self.measured_skill()
        second = self.measured_skill()
        self.assertEqual(first, second)
        self.assertEqual(first["level"], 4)
        self.assertEqual(len(first["evidence"]), 1)
        self.assertEqual(first["evidence"][0]["source_id"], test_id)
        self.assertEqual(first["evidence"][0]["href"], f"/dashboard/tests?session={test_id}")
        with self.sessions() as db:
            self.assertIsNone(db.get(CareerProfile, self.student.id))
            self.assertEqual(db.query(StudyTest).count(), 1)
        self.actor = self.admin
        self.client.delete(f"/api/admin/career/learning-links/{high['id']}")
        self.assertEqual(self.measured_skill()["level"], 2)
        self.actor = self.admin
        self.client.delete(f"/api/admin/career/learning-links/{low['id']}")
        self.assertEqual(self.measured_skill()["level"], 0)

    def test_personal_title_fake_provenance_active_failed_and_other_students_do_not_award(self):
        self.link()
        self.finished_test(actor=self.peer)
        with self.sessions() as db:
            fake_personal = {"mode": "personal", "course_id": self.course_id, "course_title": "Основы программирования", "group_id": self.group_id}
            rows = [StudyTest(user_id=self.student.id, status="finished", score=100, finished_at=datetime.utcnow(), source_context_json=json.dumps(fake_personal)),
                StudyTest(user_id=self.student.id, status="finished", score=100, finished_at=datetime.utcnow(), source_context_json="bad-json")]
            db.add_all(rows)
            db.commit()
        own = self.finished_test(score=69)
        self.assertEqual(self.measured_skill()["level"], 0)
        with self.sessions() as db:
            db.get(StudyTest, own).score = 90
            db.get(StudyTest, own).status = "active"
            db.commit()
        self.assertEqual(self.measured_skill()["level"], 0)
        self.assertEqual(self.measured_skill(self.peer)["level"], 3)

    def test_course_wide_test_does_not_prove_specific_module_week_or_work(self):
        self.link(module="Модуль 1", week_number=1, work_id=self.work_id, syllabus_id=self.syllabus_id)
        self.finished_test()
        self.assertEqual(self.measured_skill()["level"], 0)
        self.finished_test(module="Модуль 1", week_numbers=[1], work_ids=[self.work_id])
        self.assertEqual(self.measured_skill()["level"], 3)

    def test_unpublished_and_deleted_sources_revoke_evidence(self):
        self.link(module="Модуль 1", syllabus_id=self.syllabus_id)
        self.finished_test(module="Модуль 1")
        self.assertEqual(self.measured_skill()["level"], 3)
        with self.sessions() as db:
            db.get(SyllabusDocument, self.syllabus_id).status = "draft"
            db.commit()
        self.assertEqual(self.measured_skill()["level"], 0)
        with self.sessions() as db:
            db.get(SyllabusDocument, self.syllabus_id).status = "published"
            db.commit()
        self.assertEqual(self.measured_skill()["level"], 3)
        with self.sessions() as db:
            db.delete(db.get(CurriculumWeek, self.week_id))
            db.commit()
        self.assertEqual(self.measured_skill()["level"], 0)

    def test_own_graded_submission_normalizes_max_score_selfchecks_and_drafts_do_not_award(self):
        self.link(work_id=self.work_id, min_score=80)
        with self.sessions() as db:
            db.add(WeekProgress(user_id=self.student.id, week_id=self.week_id, completed=True))
            db.add(WorkSubmission(user_id=self.student.id, work_id=self.work_id, content="Ответ", status="draft", grade=20))
            db.add(WorkSubmission(user_id=self.peer.id, work_id=self.work_id, content="Ответ", status="submitted", grade=20))
            db.commit()
        self.assertEqual(self.measured_skill()["level"], 0)
        self.assertEqual(self.personal()["activity"]["completed_weeks"], 1)
        with self.sessions() as db:
            own = db.query(WorkSubmission).filter_by(user_id=self.student.id).one()
            own.status = "submitted"
            own.grade = 15
            db.commit()
        self.assertEqual(self.measured_skill()["level"], 0)
        with self.sessions() as db:
            db.query(WorkSubmission).filter_by(user_id=self.student.id).one().grade = 16
            db.commit()
        proof = self.measured_skill()
        self.assertEqual(proof["level"], 3)
        self.assertEqual(proof["evidence"][0]["score"], 80)
        self.assertEqual(proof["evidence"][0]["kind"], "submission")

    def test_group_change_revokes_old_proof_and_foreign_curriculum_not_disclosed(self):
        self.link()
        self.finished_test()
        self.assertEqual(self.measured_skill()["level"], 3)
        self.assertEqual(self.measured_skill(self.outsider)["level"], 0)
        self.assertTrue(all(step["course_id"] == self.foreign_course_id for step in self.personal(self.outsider)["recommendations"]["steps"]))
        with self.sessions() as db:
            db.get(User, self.student.id).group_id = self.other_group_id
            db.commit()
        self.student.group_id = self.other_group_id
        self.assertEqual(self.measured_skill()["level"], 0)

    def test_profile_is_personal_validated_and_cannot_write_mastery_or_other_identity(self):
        self.actor = self.student
        result = self.client.patch("/api/career/profile", json={"target_direction_id": self.direction_id, "interests": ["Веб", "Практика"], "about": "Хочу создавать приложения"})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["target_direction_id"], self.direction_id)
        for invalid in ({"user_id": self.peer.id}, {"level": 5}, {"interests": ["x"] * 13}, {"about": None}, {"target_direction_id": True}, {"target_direction_id": 999999}):
            self.assertIn(self.client.patch("/api/career/profile", json=invalid).status_code, (422, 404), invalid)
        self.assertIsNone(self.personal(self.peer)["profile"]["target_direction_id"])
        self.assertEqual(self.personal()["summary"]["readiness"], 0)

    def test_admin_crud_and_immutable_audit_preserve_old_records(self):
        response = self.client.post("/api/admin/career/skills", json={"slug": "new-skill", "name": "Новый навык"})
        self.assertEqual(response.status_code, 201)
        skill_id = response.json()["id"]
        self.assertEqual(self.client.patch(f"/api/admin/career/skills/{skill_id}", json={"name": "Уточнённый навык"}).json()["name"], "Уточнённый навык")
        duplicate = self.client.post("/api/admin/career/skills", json={"slug": "new-skill", "name": "Дубликат"})
        self.assertEqual(duplicate.status_code, 409)
        direction = self.client.post("/api/admin/career/directions", json={"slug": "test-direction", "title": "Новая профессия", "requirements": [{"skill_id": skill_id, "level": 2}], "study_paths": ["Вуз"], "career_paths": ["Стажировка"]}).json()
        self.assertEqual(self.client.patch(f"/api/admin/career/directions/{direction['id']}", json={"title": "Учебное направление"}).json()["title"], "Учебное направление")
        link = self.link(skill_id=skill_id)
        self.actor = self.admin
        self.assertEqual(self.client.patch(f"/api/admin/career/learning-links/{link['id']}", json={"min_score": 85}).json()["min_score"], 85)
        self.assertEqual(self.client.delete(f"/api/admin/career/skills/{skill_id}").status_code, 200)
        self.assertFalse(any(row["id"] == link["id"] for row in self.client.get("/api/admin/career/learning-links").json()["items"]))
        self.assertEqual(self.client.get("/api/admin/career/directions").json()["items"][-1]["requirements"], [])
        self.assertEqual(self.client.delete(f"/api/admin/career/directions/{direction['id']}").status_code, 200)
        with self.sessions() as db:
            self.assertGreaterEqual(db.query(AuditLog).count(), 8)
            self.assertEqual(db.get(User, self.student.id).hashed_password, "original-student-hash")
            self.assertEqual(db.query(CurriculumWeek).count(), 3)

    def test_strict_validation_blocks_cross_course_sources_and_invalid_prerequisites(self):
        cases = [{"course_id": self.foreign_course_id, "work_id": self.work_id},
            {"module": "Другой модуль"}, {"week_number": 52}, {"syllabus_id": 999999},
            {"target_level": 6}, {"target_level": True}, {"min_score": -1},
            {"target_level": 2, "prerequisites": [{"skill_id": self.skill_id, "level": 2}]},
            {"prerequisites": [{"skill_id": 999999, "level": 1}]},
            {"prerequisites": [{"skill_id": self.skill_id, "level": 1}] * 2}, {"unknown": "field"}]
        for case in cases:
            response = self.client.post("/api/admin/career/learning-links", json={"course_id": self.course_id, "skill_id": self.skill_id, **case})
            self.assertIn(response.status_code, (422, 404), case)
        self.assertEqual(self.client.patch(f"/api/admin/career/skills/{self.skill_id}", json={"name": None}).status_code, 422)

    def test_deactivated_required_skill_cannot_silently_improve_readiness(self):
        self.link(target_level=4)
        self.finished_test()
        self.actor = self.student
        self.client.patch("/api/career/profile", json={"target_direction_id": self.direction_id})
        self.assertEqual(self.personal()["summary"]["readiness"], 100)
        self.actor = self.admin
        self.client.patch(f"/api/admin/career/skills/{self.skill_id}", json={"is_active": False})
        own = self.personal()
        self.assertIsNone(own["summary"]["readiness"])
        self.assertFalse(own["recommendations"]["steps"])
        self.assertIn("недоступные навыки", own["recommendations"]["reason"])
        self.actor = self.admin
        stored_direction = next(row for row in self.client.get("/api/admin/career/directions").json()["items"] if row["id"] == self.direction_id)
        self.assertEqual(stored_direction["requirements"][0]["skill_id"], self.skill_id)
        response = self.client.patch(f"/api/admin/career/directions/{self.direction_id}", json={"title": "Уточнённая цель"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["requirements"][0]["level"], 4)
        self.client.patch(f"/api/admin/career/skills/{self.skill_id}", json={"is_active": True})
        self.assertEqual(self.personal()["summary"]["readiness"], 100)

    def test_opportunities_real_dates_safe_urls_and_idempotent_private_saves(self):
        future = (datetime.utcnow() + timedelta(days=2)).isoformat() + "Z"
        expired = (datetime.utcnow() - timedelta(days=1)).isoformat() + "Z"
        past = (datetime.utcnow() - timedelta(days=3)).isoformat() + "Z"
        items = []
        for payload in [{"title": "Вуз", "url": "https://example.test/program", "direction_id": self.direction_id},
                {"title": "Будущая", "published_at": future}, {"title": "Истёкшая", "published_at": past, "expires_at": expired},
                {"title": "Черновик", "is_active": False}]:
            response = self.client.post("/api/admin/career/opportunities", json=payload)
            self.assertEqual(response.status_code, 201, response.text)
            items.append(response.json())
        self.actor = self.student
        public = self.client.get("/api/career/opportunities").json()
        self.assertEqual([row["title"] for row in public["items"]], ["Вуз"])
        self.assertEqual(public["source"], "admin_curated")
        url = f"/api/career/opportunities/{items[0]['id']}/save"
        self.assertEqual(self.client.put(url).json(), {"saved": True})
        self.assertEqual(self.client.put(url).json(), {"saved": True})
        self.assertEqual(len(self.client.get("/api/career/opportunities?saved=true").json()["items"]), 1)
        self.actor = self.peer
        self.assertEqual(self.client.get("/api/career/opportunities?saved=true").json()["items"], [])
        self.actor = self.student
        self.assertEqual(self.client.delete(url).json(), {"saved": False})
        self.assertEqual(self.client.delete(url).json(), {"saved": False})
        self.actor = self.admin
        for invalid in ("javascript:alert(1)", "data:text/html,x", "https://name:password@example.test", "https://example.test\\x", "https://example.test/a b"):
            self.assertEqual(self.client.post("/api/admin/career/opportunities", json={"title": "Invalid", "url": invalid}).status_code, 422)
        self.assertEqual(self.client.patch(f"/api/admin/career/opportunities/{items[0]['id']}", json={"title": "Поступление"}).json()["title"], "Поступление")
        self.assertEqual(self.client.delete(f"/api/admin/career/opportunities/{items[0]['id']}").status_code, 200)

    def test_one_time_seed_and_explicit_automatic_suggestions_do_not_repopulate_deleted_content(self):
        with self.sessions() as db:
            original = db.query(CareerLearningLink).filter_by(course_id=self.course_id).one()
            self.assertEqual(original.target_level, 2)
            self.assertEqual(original.min_score, 70)
            db.delete(original)
            db.commit()
            career.initialize_career(db)
            career.initialize_career(db)
            self.assertEqual(db.query(CareerLearningLink).filter_by(course_id=self.course_id).count(), 0)
        suggestions = self.client.post("/api/admin/career/learning-links/suggest", json={}).json()
        self.assertEqual(suggestions["count"], 1)
        self.assertEqual(suggestions["items"][0]["course_id"], self.course_id)
        with self.sessions() as db:
            self.assertEqual(db.query(CareerLearningLink).filter_by(course_id=self.course_id).count(), 0)
        first = self.client.post("/api/admin/career/learning-links/apply-suggestions", json={"course_ids": [self.course_id]}).json()
        second = self.client.post("/api/admin/career/learning-links/apply-suggestions", json={"course_ids": [self.course_id]}).json()
        self.assertEqual((first["created"], second["created"]), (1, 0))
        self.assertEqual(self.personal()["summary"]["demonstrated_skills"], 0)

    def test_sources_overview_search_and_admin_evidence_use_existing_groups(self):
        self.link()
        self.finished_test()
        self.actor = self.admin
        source = next(item for item in self.client.get("/api/admin/career/sources").json()["courses"] if item["id"] == self.course_id)
        self.assertEqual(source["syllabi"][0]["id"], self.syllabus_id)
        self.assertEqual(source["weeks"][0]["id"], self.week_id)
        overview = self.client.get("/api/admin/career/overview").json()
        self.assertEqual(overview["students_count"], 3)
        group = next(row for row in overview["groups"] if row["id"] == self.group_id)
        self.assertEqual(group["students_count"], 2)
        self.assertEqual(group["evidence_count"], 1)
        found = self.client.get(f"/api/admin/career/students?search=student@&group_id={self.group_id}").json()["items"]
        self.assertEqual([row["id"] for row in found], [self.student.id])
        inspected = self.client.get(f"/api/admin/career/students/{self.student.id}").json()
        self.assertEqual(inspected["summary"]["demonstrated_skills"], 2)
        self.assertEqual(self.client.get(f"/api/admin/career/students/{self.admin.id}").status_code, 404)

    def test_disabled_section_still_public_config_admin_manage_and_existing_records_intact(self):
        result = self.client.patch("/api/admin/career/config", json={"enabled": False, "title": "QCareer студентов"})
        self.assertEqual(result.status_code, 200, result.text)
        self.actor = self.student
        for path in ("/career/me", "/career/directions", "/career/opportunities"):
            self.assertEqual(self.client.get("/api" + path).status_code, 503)
        self.assertFalse(self.client.get("/api/career/config").json()["enabled"])
        self.actor = self.admin
        self.assertEqual(self.client.get("/api/career/me").status_code, 200)
        self.assertEqual(self.client.patch("/api/admin/career/config", json={"enabled": True}).status_code, 200)

    def test_archived_personal_goal_does_not_block_profile_edits_or_allow_new_hidden_target(self):
        self.actor = self.student
        self.assertEqual(self.client.patch("/api/career/profile", json={"target_direction_id": self.direction_id}).status_code, 200)
        self.actor = self.admin
        self.client.patch(f"/api/admin/career/directions/{self.direction_id}", json={"is_active": False})
        self.actor = self.student
        updated = self.client.patch("/api/career/profile", json={"about": "Мой обновлённый план", "target_direction_id": self.direction_id})
        self.assertEqual(updated.status_code, 200, updated.text)
        self.assertEqual(updated.json()["about"], "Мой обновлённый план")
        self.actor = self.peer
        self.assertEqual(self.client.patch("/api/career/profile", json={"target_direction_id": self.direction_id}).status_code, 422)

    def test_withdrawn_mapping_can_be_archived_without_republishing_or_weakening_new_validation(self):
        link = self.link(module="Модуль 1", syllabus_id=self.syllabus_id)
        with self.sessions() as db:
            db.get(SyllabusDocument, self.syllabus_id).status = "draft"
            db.commit()
        self.actor = self.admin
        archived = self.client.patch(f"/api/admin/career/learning-links/{link['id']}", json={"is_active": False, "title": "Архив программы"})
        self.assertEqual(archived.status_code, 200, archived.text)
        self.assertFalse(archived.json()["source_available"])
        self.assertFalse(archived.json()["is_active"])
        self.assertEqual(self.client.patch(f"/api/admin/career/learning-links/{link['id']}", json={"is_active": True}).status_code, 422)
        self.assertEqual(self.client.post("/api/admin/career/learning-links", json={"course_id": self.course_id, "skill_id": self.skill_id,
            "module": "Модуль 1", "syllabus_id": self.syllabus_id, "is_active": False}).status_code, 422)


class CareerPlannerTests(unittest.TestCase):
    def setUp(self):
        self.skills = {index: CareerSkill(id=index, slug=f"skill-{index}", name=f"Навык {index}", is_active=True) for index in range(1, 5)}
        class Sources:
            courses = {1: Course(id=1, group_id=1, title="Программа")}
            def available(self, link):
                return True
        self.curriculum = Sources()

    def link(self, identifier, skill, level, prerequisites=(), module=None):
        return CareerLearningLink(id=identifier, course_id=1, skill_id=skill, target_level=level,
            min_score=70, module=module or f"Шаг {identifier}", title=f"Шаг {identifier}", description="",
            prerequisites_json=json.dumps(list(prerequisites)), is_active=True)

    def direction(self, requirements):
        return {"requirements": requirements, "data_complete": True}

    def test_prerequisite_without_immediate_target_gain_unlocks_real_two_step_plan(self):
        links = [self.link(1, 1, 2), self.link(2, 2, 4, [{"skill_id": 1, "level": 2}]), self.link(3, 2, 1)]
        result = career.plan_steps(links, self.curriculum, self.skills, {}, self.direction([{"skill_id": 2, "level": 4}]))
        self.assertEqual([row["id"] for row in result["steps"]], [1, 2])
        self.assertEqual(result["remaining_gaps"], [])
        self.assertIn("не начисляет", result["assumptions"][0])

    def test_order_cap_and_three_step_limit_are_recomputed_after_each_step(self):
        links = [self.link(1, 1, 2), self.link(2, 1, 4, [{"skill_id": 1, "level": 2}]),
            self.link(3, 2, 3, [{"skill_id": 1, "level": 4}]), self.link(4, 3, 3, [{"skill_id": 2, "level": 3}])]
        levels = {1: 1}
        result = career.plan_steps(links, self.curriculum, self.skills, levels,
            self.direction([{"skill_id": 1, "level": 4}, {"skill_id": 2, "level": 3}, {"skill_id": 3, "level": 3}]))
        self.assertEqual([row["id"] for row in result["steps"]], [1, 2, 3])
        self.assertEqual([(row["from_level"], row["to_level"]) for row in result["steps"][:2]], [(1, 2), (2, 4)])
        self.assertEqual(levels, {1: 1})
        self.assertEqual([row["skill_id"] for row in result["remaining_gaps"]], [3])

    def test_same_activity_combines_skill_effects_and_does_not_repeat(self):
        links = [self.link(1, 1, 2, module="Одна работа"), self.link(2, 2, 2, module="Одна работа")]
        result = career.plan_steps(links, self.curriculum, self.skills, {},
            self.direction([{"skill_id": 1, "level": 2}, {"skill_id": 2, "level": 2}]))
        self.assertEqual(len(result["steps"]), 1)
        self.assertEqual(len(result["steps"][0]["gains"]), 2)
        self.assertEqual(result["remaining_gaps"], [])

    def test_same_activity_thresholds_forecast_highest_skill_once_with_correct_score(self):
        low = self.link(1, 1, 2, module="Один тест")
        low.min_score = 60
        high = self.link(2, 1, 4, module="Один тест")
        high.min_score = 90
        result = career.plan_steps([low, high], self.curriculum, self.skills, {}, self.direction([{"skill_id": 1, "level": 4}]))
        self.assertEqual(len(result["steps"]), 1)
        self.assertEqual(result["steps"][0]["gains"], [{"skill_id": 1, "skill_name": "Навык 1", "from_level": 0, "to_level": 4}])
        self.assertEqual(result["steps"][0]["min_score"], 90)
        self.assertIn("от 90%", result["steps"][0]["reason"])

    def test_impossible_cycle_and_missing_target_data_return_no_fabricated_activity(self):
        links = [self.link(1, 1, 2, [{"skill_id": 2, "level": 2}]), self.link(2, 2, 2, [{"skill_id": 1, "level": 2}])]
        result = career.plan_steps(links, self.curriculum, self.skills, {}, self.direction([{"skill_id": 1, "level": 2}]))
        self.assertEqual(result["steps"], [])
        self.assertEqual(result["remaining_gaps"][0]["gap"], 2)
        self.assertEqual(career.plan_steps(links, self.curriculum, self.skills, {}, None)["steps"], [])

    def test_bounded_search_discloses_truncation_and_is_deterministic(self):
        links = [self.link(index, 1, 2) for index in range(1, 206)]
        direction = self.direction([{"skill_id": 1, "level": 3}])
        first = career.plan_steps(links, self.curriculum, self.skills, {}, direction)
        second = career.plan_steps(links, self.curriculum, self.skills, {}, direction)
        self.assertEqual(first, second)
        self.assertTrue(any("ограничен 200" in message for message in first["assumptions"]))
        self.assertLessEqual(len(first["steps"]), 3)


class CareerBackupTests(unittest.TestCase):
    def test_shared_database_backup_restore_retains_career_and_existing_passwords(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "studyhub.db"
            uploads = root / "uploads"
            uploads.mkdir()
            engine = create_engine("sqlite:///" + database.as_posix())
            Base.metadata.create_all(engine)
            sessions = sessionmaker(bind=engine, expire_on_commit=False)
            with sessions() as db:
                group = StudentGroup(name="ИП-26-3кс")
                db.add(group)
                db.flush()
                user = User(email="existing@example.test", name="До обновления", hashed_password="unchanged-hash", role="student", group_id=group.id)
                course = Course(title="Существующая дисциплина", group_id=group.id)
                db.add_all([user, course])
                db.flush()
                career.initialize_career(db)
                skill = db.query(CareerSkill).first()
                direction = db.query(CareerDirection).first()
                opportunity = CareerOpportunity(title="Реальная запись администратора", kind="study")
                db.add(opportunity)
                db.flush()
                db.add(CareerProfile(user_id=user.id, target_direction_id=direction.id, interests_json='["Разработка"]', about="Мой план"))
                db.add(CareerLearningLink(skill_id=skill.id, course_id=course.id, target_level=2))
                db.add(CareerSavedOpportunity(user_id=user.id, opportunity_id=opportunity.id))
                db.commit()
                ids = user.id, skill.id, direction.id, opportunity.id
            engine.dispose()
            backup = BackupService(database, uploads, root / "backups")
            archive = backup.archive_path(backup.create()["name"])
            with closing(sqlite3.connect(database)) as db:
                db.execute("UPDATE users SET name='Позже'")
                db.execute("UPDATE career_profiles SET about='Позже'")
                db.commit()
            restore_backup(archive, database, uploads, root / "backups")
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT name,hashed_password FROM users WHERE id=?", (ids[0],)).fetchone(), ("До обновления", "unchanged-hash"))
                self.assertEqual(db.execute("SELECT target_direction_id,about FROM career_profiles").fetchone(), (ids[2], "Мой план"))
                self.assertEqual(db.execute("SELECT skill_id FROM career_learning_links").fetchone()[0], ids[1])
                self.assertEqual(db.execute("SELECT opportunity_id FROM career_saved_opportunities").fetchone()[0], ids[3])
                self.assertEqual(db.execute("SELECT COUNT(*) FROM career_opportunities").fetchone()[0], 1)


if __name__ == "__main__":
    unittest.main()
