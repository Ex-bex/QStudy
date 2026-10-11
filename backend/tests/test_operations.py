"""Backups and append-only audit checks never access the user's live database."""
import asyncio
import hashlib
import json
import os
import sqlite3
import tempfile
import unittest
import zipfile
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.auth import get_current_user
from app.database import Base, get_db
from app.models import User
from app.operational_models import AuditLog
from app.routers import admin
from app.services.audit import initialize_operations, record_audit
from app.services.backups import BackupService, BackupError, verify_backup, restore_backup, create_pre_upgrade_backup, start_backup_scheduler, stop_backup_scheduler


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        # Windows runners can expose TEMP through an 8.3 alias. Match the
        # canonical paths used by BackupService so rename fault injection fires.
        self.root = Path(self.temp.name).resolve()
        self.database = self.root / "backend" / "studyhub.db"
        self.uploads = self.root / "backend" / "uploads"
        self.directory = self.root / ".backups"
        self.uploads.mkdir(parents=True)
        self.env = self.database.parent / ".env"
        self.env.write_text("SECRET_KEY=do-not-archive-this-private-configuration", encoding="utf-8")
        self.content = b"student document contents"
        (self.uploads / "document.txt").write_bytes(self.content)
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript("""CREATE TABLE users(id INTEGER PRIMARY KEY, role TEXT, hashed_password TEXT);
            INSERT INTO users VALUES(1, 'admin', 'private-password-hash');
            CREATE TABLE materials(id INTEGER PRIMARY KEY, filepath TEXT);
            INSERT INTO materials VALUES(1, 'document.txt');
            CREATE TABLE academic_settings(key TEXT PRIMARY KEY,value TEXT);
            CREATE TABLE password_reset_tokens(id INTEGER PRIMARY KEY,used_at DATETIME);
            INSERT INTO password_reset_tokens VALUES(1,NULL);
            CREATE TABLE ai_jobs(id TEXT PRIMARY KEY,status TEXT,lease_owner TEXT,lease_expires_at DATETIME,attempts INTEGER,available_at DATETIME,updated_at DATETIME,error TEXT,payload_json TEXT);
            INSERT INTO ai_jobs VALUES('job1','running','old-worker','2999-01-01',2,'2020-01-01','2020-01-01','','{\"course_id\":1}');""")
        self.service = BackupService(self.database, self.uploads, self.directory, keep=2)

    def tearDown(self):
        self.temp.cleanup()

    def test_verified_archive_contains_consistent_database_and_uploads_without_env(self):
        result = self.service.create()
        archive = self.service.archive_path(result["name"])
        manifest = verify_backup(archive)
        self.assertEqual(manifest["upload_count"], 1)
        with zipfile.ZipFile(archive) as source:
            self.assertEqual(set(source.namelist()), {"manifest.json", "database.sqlite3", "uploads/document.txt"})
            self.assertEqual(source.read("uploads/document.txt"), self.content)
            self.assertNotIn(b"SECRET_KEY", source.read("manifest.json"))
        restored = self.root / "verified"
        restored.mkdir()
        verify_backup(archive, extract_to=restored)
        with closing(sqlite3.connect(restored / "database.sqlite3")) as db:
            self.assertEqual(db.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)

    def test_missing_referenced_upload_never_publishes_a_false_success(self):
        (self.uploads / "document.txt").unlink()
        with self.assertRaises(BackupError):
            self.service.create()
        self.assertEqual(self.service.archives(), [])
        self.assertTrue(self.service.status()["last_error"])

    def test_retention_and_download_path_safety(self):
        for _ in range(3):
            self.service.create()
        self.assertEqual(len(self.service.archives()), 2)
        with self.assertRaises(BackupError):
            self.service.archive_path("../../backend/.env")

    def test_restore_preserves_secret_invalidates_sessions_and_recovers_jobs(self):
        archive = self.service.archive_path(self.service.create()["name"])
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM users")
        (self.uploads / "document.txt").write_bytes(b"later edits")
        secret = self.env.read_bytes()
        restore_backup(archive, self.database, self.uploads, self.directory)
        self.assertEqual(self.env.read_bytes(), secret)
        self.assertEqual((self.uploads / "document.txt").read_bytes(), self.content)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)
            self.assertGreater(float(db.execute("SELECT value FROM academic_settings WHERE key='auth_min_iat'").fetchone()[0]), 0)
            self.assertIsNotNone(db.execute("SELECT used_at FROM password_reset_tokens").fetchone()[0])
            row = db.execute("SELECT status,lease_owner,attempts,payload_json FROM ai_jobs").fetchone()
            self.assertEqual(row[:3], ("queued", None, 0))
            self.assertEqual(json.loads(row[3]), {"course_id": 1})
        self.assertTrue(any(row["reason"] == "pre-restore" for row in self.service.archives()))

    def test_corrupted_archive_and_traversal_cannot_restore(self):
        original = self.service.archive_path(self.service.create()["name"])
        bad = self.root / "bad.zip"
        with zipfile.ZipFile(original) as source, zipfile.ZipFile(bad, "w") as target:
            for name in source.namelist():
                target.writestr(name, b"tampered" if name == "uploads/document.txt" else source.read(name))
        with self.assertRaises(BackupError):
            verify_backup(bad)
        manifest = {"format": 1, "application": "QStudy", "files": {"database.sqlite3": {"size": 0, "sha256": hashlib.sha256(b"").hexdigest()}, "uploads/../../evil": {"size": 0, "sha256": hashlib.sha256(b"").hexdigest()}}}
        with zipfile.ZipFile(bad, "w") as target:
            target.writestr("manifest.json", json.dumps(manifest))
            target.writestr("database.sqlite3", b"")
            target.writestr("uploads/../../evil", b"")
        with self.assertRaises(BackupError):
            verify_backup(bad)

    def test_oldest_archive_can_restore_despite_retention(self):
        oldest = self.service.archive_path(self.service.create()["name"])
        self.service.create()
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("DELETE FROM users")
        restore_backup(oldest, self.database, self.uploads, self.directory)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT COUNT(*) FROM users").fetchone()[0], 1)

    def test_restore_failure_rolls_back_database_and_uploads(self):
        original = self.service.archive_path(self.service.create()["name"])
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE users SET id=99")
        (self.uploads / "document.txt").write_bytes(b"current data")
        replace = os.replace
        def fail_upload(source, destination):
            if Path(destination) == self.uploads:
                raise OSError("simulated final rename failure")
            return replace(source, destination)
        with patch("app.services.backups.os.replace", side_effect=fail_upload), self.assertRaises(OSError):
            restore_backup(original, self.database, self.uploads, self.directory)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT id FROM users").fetchone()[0], 99)
        self.assertEqual((self.uploads / "document.txt").read_bytes(), b"current data")
    def test_pre_upgrade_idempotence_and_first_start_schedule(self):
        with patch("app.services.backups.get_backup_service", return_value=self.service), patch("app.services.backups.BACKEND_DIR", self.database.parent):
            (self.database.parent / "app").mkdir()
            (self.database.parent / "app" / "main.py").write_text("version=1")
            self.assertIsNotNone(create_pre_upgrade_backup())
            self.assertIsNone(create_pre_upgrade_backup())
            (self.database.parent / "app" / "main.py").write_text("version=2")
            self.assertIsNotNone(create_pre_upgrade_backup())
        fresh = BackupService(self.database, self.uploads, self.root / "scheduled")
        async def run():
            with patch("app.services.backups.get_backup_service", return_value=fresh), patch("app.services.backups._service", fresh):
                await start_backup_scheduler()
                await stop_backup_scheduler()
        asyncio.run(run())
        self.assertEqual(fresh.archives()[0]["reason"], "startup")


class AuditTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        initialize_operations(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            self.actor = User(email="admin@example.com", hashed_password="private-password", role="admin")
            db.add(self.actor)
            db.commit()

    def tearDown(self):
        self.engine.dispose()

    def test_transactional_sanitized_append_only_history(self):
        with self.sessions() as db:
            record_audit(db, self.actor, "user.update", "user", 1, fields=["role", "password", "content"], metadata={"role": "student", "password": "private", "content": "private", "count": 2})
            db.rollback()
            self.assertEqual(db.query(AuditLog).count(), 0)
            row = record_audit(db, self.actor, "user.update", "user", 1, fields=["role", "password"], metadata={"count": 2, "secret_key": "private"})
            db.commit()
            self.assertEqual(json.loads(row.fields_json), ["role"])
            self.assertEqual(json.loads(row.metadata_json), {"count": 2})
            with self.assertRaises(Exception):
                db.execute(text("DELETE FROM audit_logs"))
            db.rollback()
            self.assertEqual(db.query(AuditLog).count(), 1)
            row.action = "user.delete"
            with self.assertRaises(ValueError):
                db.commit()

    def test_admin_api_denies_student_and_paginates_without_secrets(self):
        app = FastAPI()
        app.include_router(admin.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        app.dependency_overrides[get_current_user] = lambda: User(id=2, email="student@example.com", role="student")
        with TestClient(app) as client:
            for method, endpoint in (("GET", "/api/admin/audit"), ("GET", "/api/admin/backups"), ("POST", "/api/admin/backups"), ("GET", "/api/admin/backups/anything/download")):
                self.assertEqual(client.request(method, endpoint).status_code, 403)
            app.dependency_overrides[get_current_user] = lambda: self.actor
            with self.sessions() as db:
                for identifier in range(3):
                    record_audit(db, self.actor, "user.password_reset", "user", identifier)
                db.commit()
            response = client.get("/api/admin/audit?limit=2&offset=1")
            self.assertEqual(response.status_code, 200)
            self.assertEqual(len(response.json()["items"]), 2)
            self.assertEqual(response.json()["total"], 3)
            self.assertNotIn("private-password", response.text)


if __name__ == "__main__":
    unittest.main()
