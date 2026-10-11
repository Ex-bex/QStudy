"""Copy/move safety checks use temporary files and isolated databases only."""
import hashlib
import importlib.util
import io
import os
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from docx import Document
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import get_current_user
from app.config import BACKEND_DIR, Settings, settings
from app.database import Base, get_db
from app.models import Course, Material, StudentGroup, SyllabusDocument, User
from app.routers import academic, files
from app.services import background
from app.services.syllabus import safe_syllabus_path
from app.storage import relative_upload_path, resolve_upload_path

_spec = importlib.util.spec_from_file_location("qstudy_data", Path(__file__).resolve().parents[2] / "scripts/qstudy_data.py")
data = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(data)


class PortablePreflightTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.project = Path(self.temp.name) / "Новый компьютер с пробелами"
        self.backend = self.project / "backend"
        self.uploads = self.backend / "uploads"
        (self.uploads / "syllabi").mkdir(parents=True)
        self.database = self.backend / "studyhub.db"
        self.old = "C:/Прежний компьютер/QStudy"
        self.env = self.backend / ".env"
        self.env.write_text('SECRET_KEY="do-not-change-this-secret-value-12345"\nDATABASE_URL=sqlite:///./studyhub.db\nUPLOAD_DIR=./uploads\n', encoding="utf-8")
        with data._connect(self.database) as connection:
            connection.execute("CREATE TABLE materials(id INTEGER PRIMARY KEY, filepath TEXT, size INTEGER)")
            connection.execute("CREATE TABLE syllabus_documents(id INTEGER PRIMARY KEY, filepath TEXT, size INTEGER, source_sha256 TEXT)")
            connection.execute("CREATE TABLE users(id INTEGER PRIMARY KEY, role TEXT, hashed_password TEXT)")
            connection.execute("INSERT INTO users VALUES(1, 'admin', 'private-password-hash')")

    def tearDown(self):
        self.temp.cleanup()

    def add_material(self, reference, content=b"private notes", record_id=1):
        (self.uploads / "material.txt").write_bytes(content)
        with data._connect(self.database) as connection:
            connection.execute("INSERT INTO materials VALUES(?,?,?)", (record_id, reference, len(content)))

    def test_relocation_backup_preserves_accounts_and_is_idempotent(self):
        original = self.old + "/backend/uploads/material.txt"
        self.add_material(original)
        syllabus = b"original-source-document"
        (self.uploads / "syllabi/source.docx").write_bytes(syllabus)
        with data._connect(self.database) as connection:
            connection.execute("INSERT INTO syllabus_documents VALUES(1,?,?,?)",
                               (self.old + "/backend/uploads/syllabi/source.docx", len(syllabus), hashlib.sha256(syllabus).hexdigest()))
        dry = data.preflight(self.project, self.old)
        self.assertEqual(dry["planned_updates"], 2)
        self.assertFalse(dry["migration_applied"])
        with data._connect(self.database) as connection:
            self.assertEqual(connection.execute("SELECT filepath FROM materials").fetchone()[0], original)
        result = data.preflight(self.project, self.old, apply=True)
        self.assertEqual(result["updated"], 2)
        with data._connect(result["backup"]) as backup:
            self.assertEqual(backup.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(backup.execute("SELECT filepath FROM materials").fetchone()[0], original)
        with data._connect(self.database) as connection:
            self.assertEqual(connection.execute("SELECT filepath FROM materials").fetchone()[0], "material.txt")
            self.assertEqual(connection.execute("SELECT filepath FROM syllabus_documents").fetchone()[0], "syllabi/source.docx")
            self.assertEqual(connection.execute("SELECT role,hashed_password FROM users").fetchone(), ("admin", "private-password-hash"))
        second = data.preflight(self.project, self.old, apply=True)
        self.assertEqual(second["updated"], 0)
        self.assertIsNone(second["backup"])

    def test_current_absolute_paths_become_relative_without_previous_marker(self):
        self.add_material(str(self.uploads / "material.txt"))
        result = data.preflight(self.project, apply=True)
        self.assertEqual(result["updated"], 1)

    def test_current_directory_alias_is_canonicalized_without_previous_marker(self):
        self.add_material(str(self.uploads / "material.txt"))
        alias = Path(self.temp.name) / "Current project alias"
        if os.name == "nt":
            import _winapi
            _winapi.CreateJunction(str(self.project.resolve()), str(alias))
        else:
            alias.symlink_to(self.project.resolve(), target_is_directory=True)
        alias_reference = alias / "backend" / "uploads" / "material.txt"
        self.assertEqual(resolve_upload_path(str(alias_reference), self.uploads),
                         (self.uploads / "material.txt").resolve())
        with data._connect(self.database) as connection:
            connection.execute("UPDATE materials SET filepath=? WHERE id=1", (str(alias_reference),))
        result = data.preflight(alias, apply=True)
        self.assertEqual(result["updated"], 1)
        self.assertEqual(result["unresolved_files"], 0)
        with data._connect(self.database) as connection:
            self.assertEqual(connection.execute("SELECT filepath FROM materials").fetchone()[0], "material.txt")
        self.assertEqual(data.preflight(self.project, apply=True)["updated"], 0)

    def test_original_uploads_directory_prefix_is_normalized(self):
        self.add_material("uploads/material.txt")
        self.assertEqual(resolve_upload_path("uploads/material.txt", self.uploads), (self.uploads / "material.txt").resolve())
        result = data.preflight(self.project, apply=True)
        self.assertEqual(result["updated"], 1)
        with data._connect(self.database) as connection:
            self.assertEqual(connection.execute("SELECT filepath FROM materials").fetchone()[0], "material.txt")

    def test_existing_canonical_file_takes_precedence_over_legacy_prefix(self):
        self.add_material("uploads/material.txt")
        (self.uploads / "uploads").mkdir()
        (self.uploads / "uploads/material.txt").write_bytes(b"private notes")
        self.assertEqual(resolve_upload_path("uploads/material.txt", self.uploads), (self.uploads / "uploads/material.txt").resolve())
        result = data.preflight(self.project, apply=True)
        self.assertEqual(result["updated"], 0)

    def test_unrelated_absolute_path_is_not_guessed_from_filename(self):
        self.add_material("C:/Other/private/uploads/material.txt")
        result = data.preflight(self.project, self.old, apply=True)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["unresolved_files"], 1)

    def test_missing_or_different_files_are_not_rebound(self):
        self.add_material(self.old + "/backend/uploads/material.txt")
        (self.uploads / "material.txt").write_bytes(b"wrong")
        with data._connect(self.database) as connection:
            connection.execute("INSERT INTO materials VALUES(2,?,15)", (self.old + "/backend/uploads/missing.txt",))
            connection.execute("INSERT INTO syllabus_documents VALUES(1,?,4,?)", (self.old + "/backend/uploads/syllabi/source.docx", "0" * 64))
        (self.uploads / "syllabi/source.docx").write_bytes(b"test")
        result = data.preflight(self.project, self.old, apply=True)
        self.assertEqual(result["updated"], 0)
        self.assertEqual(result["missing_files"], 1)
        self.assertEqual(result["unresolved_files"], 2)

    def test_project_owned_absolute_env_paths_are_repaired_with_private_backup(self):
        original = ('SECRET_KEY="do-not-change-this-secret-value-12345"\r\n'
                    + 'DATABASE_URL="sqlite:///' + self.old + '/backend/studyhub.db" # local\r\n'
                    + 'UPLOAD_DIR="' + self.old + '/backend/uploads"\r\n')
        self.env.write_text(original, encoding="utf-8", newline="")
        result = data.preflight(self.project, self.old, apply=True)
        updated = self.env.read_text(encoding="utf-8")
        self.assertEqual(set(result["env_repaired"]), {"DATABASE_URL", "UPLOAD_DIR"})
        self.assertIn('SECRET_KEY="do-not-change-this-secret-value-12345"', updated)
        self.assertIn("DATABASE_URL=sqlite:///./studyhub.db", updated)
        self.assertIn("UPLOAD_DIR=./uploads", updated)
        backups = list((self.project / ".backups").glob("*/.env"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(backups[0].read_bytes(), original.encode("utf-8"))

    def test_missing_copied_database_does_not_create_empty_database(self):
        self.database.unlink()
        self.env.write_text('DATABASE_URL=sqlite:///' + self.old + '/backend/studyhub.db\n', encoding="utf-8")
        with self.assertRaises(data.PreflightError):
            data.preflight(self.project, self.old, apply=True)
        self.assertFalse(self.database.exists())

    def test_unknown_stale_environment_path_requires_matching_previous_marker(self):
        self.env.write_text('DATABASE_URL=sqlite:///C:/Definitely-missing-QStudy/backend/studyhub.db\n', encoding="utf-8")
        with self.assertRaises(data.PreflightError):
            data.preflight(self.project, apply=True)

    def test_location_marker_supplies_previous_workspace_after_copy(self):
        self.add_material(self.old + "/backend/uploads/material.txt")
        (self.backend / ".qstudy-location.json").write_text('{"version":1,"project_root":"C:/Прежний компьютер/QStudy"}', encoding="utf-8")
        result = data.preflight(self.project, apply=True)
        self.assertEqual(result["updated"], 1)
        self.assertTrue(result["location_recorded"])

    def test_corrupt_database_is_not_modified(self):
        self.database.write_bytes(b"not a database")
        with self.assertRaises(sqlite3.DatabaseError):
            data.preflight(self.project, self.old, apply=True)
        self.assertEqual(self.database.read_bytes(), b"not a database")

    def test_explicit_online_backup_preserves_wal_records(self):
        with data._connect(self.database) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("INSERT INTO users VALUES(2,'student','preserved')")
            connection.commit()
            destination = self.project / "transfer" / "studyhub.db"
            result = data.preflight(self.project, backup_to=destination)
        self.assertEqual(result["updated"], 0)
        with data._connect(destination) as backup:
            self.assertEqual(backup.execute("SELECT COUNT(*) FROM users").fetchone()[0], 2)

    def test_traversal_reference_is_not_repaired(self):
        self.add_material("../outside.txt")
        result = data.preflight(self.project, self.old, apply=True)
        self.assertEqual(result["unresolved_files"], 1)
        self.assertEqual(result["updated"], 0)


class PortableUploadApiTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = settings.UPLOAD_DIR
        self.original = Path(self.temp.name) / "Прежние файлы"
        self.copied = Path(self.temp.name) / "Новые файлы с пробелами"
        self.original.mkdir()
        settings.UPLOAD_DIR = str(self.original)
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as database:
            self.actor = User(email="admin@example.test", role="admin", hashed_password="unused")
            group = StudentGroup(name="ИП-26-3кс")
            database.add_all([self.actor, group])
            database.flush()
            self.course = Course(group_id=group.id, title="Учебная дисциплина")
            database.add(self.course)
            database.commit()
        app = FastAPI()
        app.include_router(files.router, prefix="/api")
        app.include_router(academic.router, prefix="/api")
        def get_database():
            with self.sessions() as database:
                yield database
        app.dependency_overrides[get_db] = get_database
        app.dependency_overrides[get_current_user] = lambda: self.actor
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()
        settings.UPLOAD_DIR = self.previous
        self.temp.cleanup()

    def test_material_download_processing_and_deletion_after_copy(self):
        content = "Материал на новом компьютере".encode("utf-8")
        uploaded = self.client.post("/api/files/upload", files={"file": ("notes.txt", content)})
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        identifier = uploaded.json()["id"]
        with self.sessions() as database:
            reference = database.get(Material, identifier).filepath
            self.assertFalse(Path(reference).is_absolute())
        shutil.copytree(self.original, self.copied)
        settings.UPLOAD_DIR = str(self.copied)
        self.assertEqual(self.client.get(f"/api/files/{identifier}/download").content, content)
        original_wait = background.await_job_result
        async def process_then_wait(job_id, user_id):
            await background.process_one_job()
            return await original_wait(job_id, user_id)
        with patch.object(background, "SessionLocal", self.sessions), patch.object(background,
                "await_job_result", process_then_wait):
            processed = self.client.post(f"/api/files/{identifier}/process")
        self.assertEqual(processed.status_code, 200, processed.text)
        self.assertEqual(self.client.get(f"/api/files/{identifier}/text").json()["text"], content.decode("utf-8"))
        self.assertEqual(self.client.delete(f"/api/files/{identifier}").status_code, 200)
        self.assertFalse((self.copied / reference).exists())
        self.assertTrue((self.original / reference).is_file())

    def test_syllabus_download_after_copy(self):
        document = Document()
        document.add_paragraph("Учебный план. Неделя 1: знакомство с дисциплиной и практическое задание.")
        output = io.BytesIO()
        document.save(output)
        uploaded = self.client.post("/api/syllabi/upload", data={"course_id": str(self.course.id)}, files={"file": ("syllabus.docx", output.getvalue())})
        self.assertEqual(uploaded.status_code, 201, uploaded.text)
        identifier = uploaded.json()["id"]
        with self.sessions() as database:
            reference = database.get(SyllabusDocument, identifier).filepath
            self.assertTrue(reference.startswith("syllabi/"))
        shutil.copytree(self.original, self.copied)
        settings.UPLOAD_DIR = str(self.copied)
        self.assertEqual(self.client.get(f"/api/syllabi/{identifier}/download").content, output.getvalue())

    def test_safe_paths_reject_escape_and_preserve_legacy_absolute_compatibility(self):
        path = self.original / "file.txt"
        self.assertEqual(resolve_upload_path(str(path), self.original), path.resolve())
        self.assertEqual(relative_upload_path(path, self.original), "file.txt")
        for invalid in ("../outside.txt", str(self.original.parent / "outside.txt"), "C:relative.txt", "\x00invalid"):
            with self.assertRaises(ValueError):
                resolve_upload_path(invalid, self.original)
        with self.assertRaises(ValueError):
            safe_syllabus_path("file.txt", str(self.original))
        self.assertEqual(safe_syllabus_path("syllabi/file.docx", str(self.original)), (self.original / "syllabi/file.docx").resolve())

    def test_configuration_paths_are_independent_of_shell_working_directory(self):
        previous = Path.cwd()
        try:
            os.chdir(self.temp.name)
            config = Settings(_env_file=None, SECRET_KEY="local-test-secret-must-have-32-characters", DATABASE_URL="sqlite:///./studyhub.db", UPLOAD_DIR="./uploads")
        finally:
            os.chdir(previous)
        self.assertEqual(Path(config.UPLOAD_DIR), BACKEND_DIR / "uploads")
        self.assertTrue(config.DATABASE_URL.endswith(str(BACKEND_DIR / "studyhub.db")))


if __name__ == "__main__":
    unittest.main()
