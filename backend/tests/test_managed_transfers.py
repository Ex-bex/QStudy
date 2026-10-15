"""Isolated transfer/settings/control tests; no application data or network."""
import asyncio
import hashlib
import hmac
import json
import os
import sqlite3
import stat
import tempfile
import unittest
import zipfile
from contextlib import closing
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from app.auth import get_current_user
from app.config import settings
from app.database import Base, get_db
from app.operational_models import AuditLog
from app.routers import system
from app.security import BodySizeLimitMiddleware
from app.services import managed, transfers
from app.services.backups import BackupService


class TransferFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.backend = self.root / "backend"
        self.uploads = self.backend / "uploads"
        self.uploads.mkdir(parents=True)
        self.database = self.backend / "studyhub.db"
        self.env = self.backend / ".env"
        self.env.write_text('# keep comment\nSECRET_KEY="keep-current-auth-secret-123456789012"\nBFF_PROXY_SECRET="keep-current-proxy-secret-12345678"\nDATABASE_URL="sqlite:///./studyhub.db"\nSMTP_HOST="old.example.test"\nSMTP_PASSWORD="fixture-smtp-secret"\nGEMINI_API_KEY="fixture-gemini-secret"\nCUSTOM_UNRELATED="keep-me"\n', encoding="utf-8")
        (self.backend / "app").mkdir()
        (self.backend / "app" / "example.py").write_text("original_source = True\n", encoding="utf-8")
        (self.backend / "requirements.txt").write_text("fastapi\n", encoding="utf-8")
        for name in ("Install-QStudy.cmd", "Start-QStudy.cmd", "Start-QStudy-LAN.cmd", "Start-QStudy-Internet.cmd", "Stop-QStudy.cmd"):
            (self.root / name).write_text("@echo fixture\n", encoding="utf-8")
        for path in (self.root / ".local" / "private.txt", self.root / "frontend" / "node_modules" / "private.txt", self.root / "frontend" / ".next" / "private.txt", self.root / "output" / "private.txt"):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("do-not-export-runtime-secret", encoding="utf-8")
        self.document = self.uploads / "document.txt"
        self.document.write_bytes(b"original document")
        with closing(sqlite3.connect(self.database)) as db, db:
            db.executescript("""CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,hashed_password TEXT,is_active BOOLEAN);
            INSERT INTO users VALUES(1,'admin','existing-account-hash',1);
            CREATE TABLE materials(id INTEGER PRIMARY KEY,filepath TEXT);
            CREATE TABLE student_groups(id INTEGER PRIMARY KEY); INSERT INTO student_groups VALUES(1);
            CREATE TABLE courses(id INTEGER PRIMARY KEY); INSERT INTO courses VALUES(1);
            CREATE TABLE syllabus_documents(id INTEGER PRIMARY KEY,filepath TEXT);
            CREATE TABLE ai_jobs(id TEXT PRIMARY KEY,status TEXT,lease_owner TEXT,lease_expires_at DATETIME,attempts INTEGER,available_at DATETIME,updated_at DATETIME,error TEXT,payload_json TEXT);
            INSERT INTO ai_jobs VALUES('job1','running','worker','2999-01-01',2,'2020-01-01','2020-01-01','','{"course_id":1}');""")
            db.execute("INSERT INTO materials VALUES(1,?)", (str(self.document),))
        self.environ = patch.dict(os.environ, {"QSTUDY_PROJECT_ROOT": str(self.root), "QSTUDY_MANAGED_RUNTIME": "1", "QSTUDY_ENV_FILE": str(self.env), "QSTUDY_CONTROL_DIR": str(self.root / ".local" / "managed"), "QSTUDY_CONTROL_TOKEN": "fixture-control-token-that-is-never-exported"})
        self.environ.start()
        self.patches = [patch.object(settings, key, value) for key, value in {
            "DATABASE_URL": "sqlite:///" + str(self.database), "UPLOAD_DIR": str(self.uploads), "SECRET_KEY": "fixture-settings-secret-key-123456789012345", "BFF_PROXY_SECRET": "fixture-bff-secret-1234567890123456789",
            "SMTP_HOST": "old.example.test", "SMTP_USERNAME": "fixture@example.test", "SMTP_PASSWORD": "fixture-smtp-secret", "SMTP_FROM": "fixture@example.test", "GEMINI_API_KEY": "fixture-gemini-secret", "MAX_TRANSFER_BYTES": 2 * 1024 ** 3,
        }.items()]
        for item in self.patches:
            item.start()

    def tearDown(self):
        for item in reversed(self.patches):
            item.stop()
        self.environ.stop()
        self.temporary.cleanup()

    def heartbeat(self, **changes):
        value = {"version": 1, "root_owner": str(self.root), "state": "running", "mode": "local", "ports": {"frontend": 3000, "backend": 8000}, "control_ready": True, "generation": 1, "checked_utc": managed.iso_now(), "data_source": "existing"}
        value.update(changes)
        managed.atomic_private(self.root / ".local" / "managed" / "status.json", json.dumps(value).encode())

    def upload(self, archive):
        class Request:
            async def stream(inner):
                with archive.open("rb") as source:
                    while chunk := source.read(65536):
                        yield chunk
        return asyncio.run(transfers.receive_import(Request(), 1))

    def standard_archive(self):
        # Existing format 1 still requires portable references when moving hosts.
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE materials SET filepath='document.txt'")
        service = BackupService(self.database, self.uploads, self.root / "fixture-backups", enabled=False)
        return service.archive_path(service.create()["name"])


class ManagedSettingsTests(TransferFixture):
    def test_masked_settings_preserve_secrets_and_unrelated_values(self):
        public = managed.settings_public()
        self.assertTrue(public["has_smtp_password"])
        self.assertTrue(public["has_gemini_api_key"])
        self.assertNotIn("SMTP_PASSWORD", public)
        self.assertNotIn("GEMINI_API_KEY", public)
        result = managed.update_settings({"SMTP_HOST": "new.example.test", "SMTP_PASSWORD": "", "GEMINI_API_KEY": ""})
        self.assertEqual(result["SMTP_HOST"], "new.example.test")
        self.assertTrue(result["restart_required"])
        text = self.env.read_text(encoding="utf-8")
        for untouched in ('# keep comment', 'SECRET_KEY="keep-current-auth-secret-123456789012"', 'BFF_PROXY_SECRET="keep-current-proxy-secret-12345678"', 'CUSTOM_UNRELATED="keep-me"', 'SMTP_PASSWORD="fixture-smtp-secret"', 'GEMINI_API_KEY="fixture-gemini-secret"'):
            self.assertIn(untouched, text)
        self.assertNotIn("fixture-smtp-secret", json.dumps(result))

    def test_settings_reject_private_configuration_and_malformed_values(self):
        original = self.env.read_bytes()
        for values in ({"DATABASE_URL": "sqlite:///other.db"}, {"SECRET_KEY": "bad"}, {"SMTP_HOST": "x\nSECRET_KEY=bad"}, {"SMTP_PORT": 0}, {"BACKUP_RETENTION_COUNT": 0}):
            with self.assertRaises(managed.ManagementError):
                managed.update_settings(values)
            self.assertEqual(self.env.read_bytes(), original)

    def test_settings_preserve_bom_and_crlf_and_show_pending_restart_after_reload(self):
        self.env.write_bytes(b"\xef\xbb\xbf" + self.env.read_bytes().replace(b"\n", b"\r\n"))
        managed.update_settings({"SMTP_HOST": "new.example.test"})
        result = self.env.read_bytes()
        self.assertTrue(result.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\n", result.replace(b"\r\n", b""))
        self.assertTrue(managed.settings_public()["restart_required"])
        unchanged = self.env.read_bytes()
        managed.update_settings({"SMTP_PASSWORD": "", "GEMINI_API_KEY": ""})
        self.assertEqual(self.env.read_bytes(), unchanged)

    def test_stale_heartbeat_cannot_accept_control_and_fresh_request_is_signed_once(self):
        self.heartbeat(checked_utc=(managed.utc_now() - timedelta(minutes=1)).isoformat())
        with self.assertRaises(managed.ManagementError):
            managed.request_control("restart", 1)
        self.heartbeat()
        self.assertEqual(managed.managed_status()["generation"], 1)
        result = managed.request_control("restart", 1)
        self.assertEqual(result["status"], "requested")
        request = json.loads((self.root / ".local" / "managed" / "request.json").read_text())
        signature = request.pop("signature")
        expected = hmac.new(os.environ["QSTUDY_CONTROL_TOKEN"].encode(), json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(), hashlib.sha256).hexdigest()
        self.assertEqual(signature, expected)
        with self.assertRaises(managed.ManagementError):
            managed.request_control("stop", 1)
        self.assertNotIn("TOKEN", json.dumps(managed.managed_status()))

    def test_exclusive_atomic_publication_never_exposes_partial_request_or_overwrites(self):
        path = self.root / ".local" / "managed" / "request.json"
        native = os.rename if os.name == "nt" else os.link
        observed = []
        def publication(source, destination):
            self.assertFalse(Path(destination).exists())
            observed.append(json.loads(Path(source).read_text()))
            return native(source, destination)
        with patch("app.services.managed.os." + ("rename" if os.name == "nt" else "link"), side_effect=publication):
            managed.atomic_private(path, b'{"complete":true}', replace=False)
        self.assertEqual(observed, [{"complete": True}])
        with self.assertRaises(FileExistsError):
            managed.atomic_private(path, b'{"complete":false}', replace=False)
        self.assertEqual(path.read_bytes(), b'{"complete":true}')

    def test_status_only_returns_validated_control_outcome(self):
        self.heartbeat(last_action={"id": "a" * 32, "action": "apply-import", "status": "failed", "code": "explicit_import_failed", "private": "do-not-expose"})
        result = managed.managed_status()
        self.assertEqual(result["last_action"], {"id": "a" * 32, "action": "apply-import", "status": "failed", "code": "explicit_import_failed"})
        self.heartbeat(last_action={"id": "not-an-id", "action": "apply-import", "status": "failed", "code": "do-not-expose"})
        self.assertIsNone(managed.managed_status()["last_action"])


class TransferTests(TransferFixture):
    def test_missing_transfer_store_boot_guard_is_read_only(self):
        store = self.root / ".local" / "transfers"
        self.assertFalse(store.exists())
        with patch("app.services.transfers.directory", side_effect=AssertionError("must not create storage")), patch("app.services.managed.make_private", side_effect=AssertionError("must not change permissions")):
            transfers.assert_no_incomplete_imports()
        self.assertFalse(store.exists())

    def test_existing_prepared_receipt_boot_guard_never_changes_permissions(self):
        preview = self.upload(self.standard_archive())
        with patch("app.services.transfers.directory", side_effect=AssertionError("must not create storage")), patch("app.services.managed.make_private", side_effect=AssertionError("must not change permissions")):
            transfers.assert_no_incomplete_imports()
            self.assertEqual(transfers.read_import_receipt(preview["transfer_id"])["status"], "prepared")

    def test_portable_export_is_consistent_complete_and_excludes_runtime(self):
        archive = transfers.export_project()
        with zipfile.ZipFile(archive) as source:
            names = source.namelist()
            exported_buttons = {name for name in names if name.count("/") == 1 and name.endswith(".cmd")}
            self.assertEqual(exported_buttons, {"QStudy/Install-QStudy.cmd", "QStudy/Start-QStudy.cmd", "QStudy/Start-QStudy-LAN.cmd", "QStudy/Start-QStudy-Internet.cmd", "QStudy/Stop-QStudy.cmd"})
            self.assertIn("QStudy/backend/app/example.py", names)
            self.assertIn("QStudy/backend/requirements.txt", names)
            self.assertNotIn("do-not-export-runtime-secret", b"".join(source.read(name) for name in names).decode("utf-8", errors="ignore"))
            self.assertFalse(any(any(part in name.split("/") for part in ("node_modules", ".next", ".local", ".venv", "output")) for name in names))
            env = source.read("QStudy/backend/.env").decode()
            self.assertIn('DATABASE_URL="sqlite:///./studyhub.db"', env)
            self.assertNotIn(str(self.root), env)
            self.assertNotIn(os.environ["QSTUDY_CONTROL_TOKEN"], env)
            self.assertIn("fixture-smtp-secret", env)
        preview = self.upload(archive)
        self.assertEqual(preview["format"], "portable")
        self.assertEqual(preview["counts"]["accounts"], 1)
        self.assertEqual(preview["counts"]["uploads"], 1)
        self.assertTrue(preview["has_settings"])
        self.assertNotIn("fixture-smtp-secret", json.dumps(preview))
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT filepath FROM materials").fetchone()[0], str(self.document))

    def test_standard_backup_stages_without_replacing_and_explicit_apply_is_once(self):
        archive = self.standard_archive()
        preview = self.upload(archive)
        self.assertFalse(preview["has_settings"])
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE users SET hashed_password='current-later-hash'")
        self.document.write_bytes(b"current later material")
        self.assertEqual(transfers.preview_import(preview["transfer_id"])["status"], "prepared")
        env = self.env.read_bytes()
        result = transfers.apply_prepared_import(preview["transfer_id"])
        self.assertEqual(result["status"], "applied")
        self.assertEqual(self.env.read_bytes(), env)
        self.assertEqual(self.document.read_bytes(), b"original document")
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT hashed_password FROM users").fetchone()[0], "existing-account-hash")
            self.assertEqual(db.execute("SELECT status,attempts,payload_json FROM ai_jobs").fetchone(), ("queued", 0, '{"course_id":1}'))
            self.assertGreater(float(db.execute("SELECT value FROM academic_settings WHERE key='auth_min_iat'").fetchone()[0]), 0)
        with self.assertRaises(transfers.TransferError):
            transfers.apply_prepared_import(preview["transfer_id"])
        self.assertEqual(transfers.read_import_receipt(preview["transfer_id"])["status"], "applied")
        transfers.assert_no_incomplete_imports()

    def test_portable_import_never_applies_source_or_authentication_keys(self):
        archive = transfers.export_project()
        preview = self.upload(archive)
        original_source = (self.backend / "app" / "example.py").read_bytes()
        self.env.write_text(self.env.read_text().replace("old.example.test", "later.example.test"), encoding="utf-8")
        result = transfers.apply_prepared_import(preview["transfer_id"], include_settings=True)
        self.assertTrue(result["settings_applied"])
        env = self.env.read_text()
        self.assertIn("old.example.test", env)
        self.assertIn('SECRET_KEY="keep-current-auth-secret-123456789012"', env)
        self.assertIn('BFF_PROXY_SECRET="keep-current-proxy-secret-12345678"', env)
        self.assertEqual((self.backend / "app" / "example.py").read_bytes(), original_source)

    def test_transaction_failure_preserves_current_database_uploads_and_settings(self):
        preview = self.upload(self.standard_archive())
        with closing(sqlite3.connect(self.database)) as db, db:
            db.execute("UPDATE users SET hashed_password='preserve-current-hash'")
        self.document.write_bytes(b"preserve current document")
        before = self.env.read_bytes()
        replace = os.replace
        def fail_upload(source, destination):
            if Path(destination) == self.uploads and Path(source).name.startswith(".transfer-new-"):
                raise OSError("private simulated failure")
            return replace(source, destination)
        with patch("app.services.transfers.os.replace", side_effect=fail_upload), self.assertRaises(transfers.TransferError):
            transfers.apply_prepared_import(preview["transfer_id"])
        self.assertEqual(self.document.read_bytes(), b"preserve current document")
        self.assertEqual(self.env.read_bytes(), before)
        with closing(sqlite3.connect(self.database)) as db:
            self.assertEqual(db.execute("SELECT hashed_password FROM users").fetchone()[0], "preserve-current-hash")
        with self.assertRaises(transfers.TransferError):
            transfers.apply_prepared_import(preview["transfer_id"])
        self.assertEqual(transfers.read_import_receipt(preview["transfer_id"])["status"], "failed_rolled_back")
        transfers.assert_no_incomplete_imports()

    def test_interrupted_import_guard_never_initializes_replaces_or_restores_data(self):
        preview = self.upload(self.standard_archive())
        stage, state = transfers._read_state(preview["transfer_id"])
        state["status"] = "applying"
        transfers._save_state(stage, state)
        retired = self.database.with_name(".interrupted-existing.db")
        os.replace(self.database, retired)
        original = retired.read_bytes()
        env = self.env.read_bytes()
        with self.assertRaises(transfers.TransferError):
            transfers.assert_no_incomplete_imports()
        self.assertFalse(self.database.exists())
        self.assertEqual(retired.read_bytes(), original)
        self.assertEqual(self.env.read_bytes(), env)
        state["status"] = "corrupted-state"
        transfers._save_state(stage, state)
        with self.assertRaises(transfers.TransferError):
            transfers.assert_no_incomplete_imports()
        self.assertFalse(self.database.exists())

    def test_upload_validation_rejects_traversal_duplicates_tampering_and_zipbomb(self):
        original = self.standard_archive()
        for variant in ("traversal", "duplicate", "case-duplicate", "symlink", "tamper", "oversize"):
            archive = self.root / (variant + ".zip")
            with zipfile.ZipFile(original) as source, zipfile.ZipFile(archive, "w") as target:
                for item in source.infolist():
                    content = source.read(item.filename)
                    if variant == "tamper" and item.filename == "uploads/document.txt":
                        content = b"tampered"
                    target.writestr(item, content)
                if variant in ("traversal", "duplicate", "case-duplicate"):
                    target.writestr({"traversal": "../evil", "duplicate": "uploads/document.txt", "case-duplicate": "Uploads/Document.txt"}[variant], b"hostile")
                if variant == "symlink":
                    info = zipfile.ZipInfo("uploads/link")
                    info.external_attr = (stat.S_IFLNK | 0o777) << 16
                    target.writestr(info, b"../outside")
                if variant == "oversize":
                    target.writestr("manifest-extra.json", b"x" * 100)
            with self.subTest(variant=variant), self.assertRaises(transfers.TransferError):
                self.upload(archive)
        self.assertFalse((self.root.parent / "evil").exists())

    def test_changed_prepared_archive_and_upload_size_limit_fail_without_mutating_data(self):
        original = self.standard_archive()
        preview = self.upload(original)
        path = transfers._stage(preview["transfer_id"]) / "incoming.zip"
        path.write_bytes(b"tampered after preview")
        with self.assertRaises(transfers.TransferError):
            transfers.apply_prepared_import(preview["transfer_id"])
        with patch.object(settings, "MAX_TRANSFER_BYTES", 1024), self.assertRaises(transfers.TransferError):
            self.upload(original)
        self.assertEqual(self.document.read_bytes(), b"original document")


class SystemAuthorizationTests(TransferFixture):
    def setUp(self):
        super().setUp()
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        AuditLog.__table__.create(self.engine)
        sessions = sessionmaker(bind=self.engine)
        app = FastAPI()
        app.add_middleware(BodySizeLimitMiddleware)
        app.include_router(system.router, prefix="/api")
        self.user = SimpleNamespace(id=1, email="fixture@example.test", role="student", is_active=True)
        app.dependency_overrides[get_current_user] = lambda: self.user
        def database():
            with sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()
        super().tearDown()

    def test_student_cannot_read_settings_or_manage_or_download_secrets(self):
        for method, path in (("get", "/status"), ("get", "/settings"), ("patch", "/settings"), ("post", "/imports"), ("get", "/imports/" + "a" * 32), ("post", "/imports/" + "a" * 32 + "/apply"), ("get", "/exports/project/download"), ("post", "/restart"), ("post", "/stop")):
            with self.subTest(path=path):
                response = getattr(self.client, method)("/api/admin/system" + path)
                self.assertEqual(response.status_code, 403)

    def test_admin_preview_requires_explicit_apply_and_zip_mime(self):
        self.user.role = "admin"
        original = self.standard_archive()
        response = self.client.post("/api/admin/system/imports", content=original.read_bytes(), headers={"Content-Type": "application/zip"})
        self.assertEqual(response.status_code, 201, response.text)
        transfer_id = response.json()["transfer_id"]
        response = self.client.get("/api/admin/system/imports/" + transfer_id)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "prepared")
        response = self.client.post("/api/admin/system/imports/" + transfer_id + "/apply", json={"include_settings": True})
        self.assertEqual(response.status_code, 409)  # no managed heartbeat
        self.assertFalse((self.root / ".local" / "managed" / "request.json").exists())
        response = self.client.post("/api/admin/system/imports", content=b"not zip", headers={"Content-Type": "text/plain"})
        self.assertEqual(response.status_code, 415)


if __name__ == "__main__":
    unittest.main()
