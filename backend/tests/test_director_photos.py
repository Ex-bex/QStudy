"""Persistent public director portraits, isolated from department logos and accounts."""
import hashlib
import io
import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import create_access_token
from app.database import Base, get_db
from app.models import BrandingAsset, DeveloperDepartment, User
from app.operational_models import AuditLog
from app.routers import branding, developers
from app.services.backups import BackupService, verify_backup
from app.services.branding import IMMUTABLE_CACHE, MAX_LOGO_BYTES, normalize_director_photo, put_asset


def portrait(*, image_format="PNG", size=(64, 48), alpha=False, metadata=False, orientation=None):
    image = Image.new("RGBA" if alpha else "RGB", size, (100, 40, 220, 255) if alpha else (100, 40, 220))
    options = {}
    if image_format == "PNG" and metadata:
        info = PngImagePlugin.PngInfo()
        info.add_text("private", "PRIVATE_METADATA")
        options["pnginfo"] = info
    if image_format == "JPEG":
        exif = Image.Exif()
        if metadata:
            exif[0x010E] = "PRIVATE_METADATA"
        if orientation is not None:
            exif[0x0112] = orientation
        options["exif"] = exif
    output = io.BytesIO()
    image.save(output, format=image_format, **options)
    return output.getvalue()


def transparent_logo():
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    image.putpixel((32, 32), (10, 80, 90, 255))
    output = io.BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()


class DirectorPhotoTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)

        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, _record):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            admin = User(email="admin-private@example.com", role="admin", hashed_password="PRIVATE_HASH")
            student = User(email="student-private@example.com", role="student", hashed_password="PRIVATE_HASH")
            department = DeveloperDepartment(name="Coding", director="A Director", logo="coding")
            db.add_all([admin, student, department])
            db.commit()
            self.admin_id, self.student_id, self.department_id = admin.id, student.id, department.id
        self.app = FastAPI()
        self.app.include_router(branding.router, prefix="/api")
        self.app.include_router(developers.router, prefix="/api")

        def database():
            with self.sessions() as db:
                yield db

        self.app.dependency_overrides[get_db] = database
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.path = f"/api/branding/departments/{self.department_id}/director-photo"

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def as_user(self, user_id):
        self.client.headers["Authorization"] = "Bearer " + create_access_token(user_id)

    def upload(self, *, content=None, path=None):
        return self.client.put(path or self.path, files={
            "file": ("../PRIVATE_SOURCE.jpg", portrait() if content is None else content, "application/octet-stream")})

    def test_existing_department_has_no_invented_photo_and_no_private_metadata(self):
        response = self.client.get("/api/developers")
        self.assertEqual(response.status_code, 200)
        row = response.json()["departments"][0]
        self.assertIsNone(row["director_photo_url"])
        self.assertFalse(row["director_photo_custom"])
        self.assertEqual(row["director"], "A Director")
        self.assertEqual(row["logo_url"], "/brand/qforce_logo_coding.jpeg")
        self.assertNotIn("PRIVATE", response.text)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)

    def test_upload_and_reset_require_current_active_admin(self):
        for user_id, expected in ((None, 401), (self.student_id, 403)):
            if user_id is not None:
                self.as_user(user_id)
            self.assertEqual(self.upload().status_code, expected)
            self.assertEqual(self.client.delete(self.path).status_code, expected)
        self.as_user(self.admin_id)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "student"
            db.commit()
        self.assertEqual(self.upload().status_code, 403)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "admin"
            db.get(User, self.admin_id).is_active = False
            db.commit()
        self.assertEqual(self.client.delete(self.path).status_code, 401)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
            self.assertEqual(db.query(AuditLog).count(), 0)

    def test_opaque_png_reencodes_without_metadata_or_source_name_and_is_public(self):
        self.as_user(self.admin_id)
        response = self.upload(content=portrait(metadata=True) + b"PRIVATE_APPENDED<script>")
        self.assertEqual(response.status_code, 200, response.text)
        row = response.json()
        self.assertTrue(row["director_photo_custom"])
        self.assertRegex(row["director_photo_url"], rf"^/api/branding/assets/director-{self.department_id}/[a-f0-9]{{64}}\.png$")
        self.client.headers.pop("Authorization")
        image_response = self.client.get(row["director_photo_url"])
        self.assertEqual(image_response.status_code, 200)
        self.assertEqual(image_response.headers["Content-Type"], "image/png")
        self.assertEqual(image_response.headers["X-Content-Type-Options"], "nosniff")
        self.assertNotIn(b"PRIVATE", image_response.content)
        with Image.open(io.BytesIO(image_response.content)) as image:
            self.assertEqual(image.info, {})
            self.assertEqual(image.size, (64, 48))
            self.assertEqual(image.getpixel((0, 0)), (100, 40, 220, 255))
        self.assertEqual(self.client.get("/api/developers").json()["departments"][0], row)
        with self.sessions() as db:
            stored = db.get(BrandingAsset, f"director-{self.department_id}")
            self.assertEqual(stored.department_id, self.department_id)
            self.assertEqual(stored.uploaded_by, self.admin_id)
            self.assertEqual(stored.digest, hashlib.sha256(image_response.content).hexdigest())
            audit = db.query(AuditLog).one()
            self.assertEqual(audit.action, "branding.director_photo.upload")
            self.assertEqual(audit.object_type, "developer_department")
            self.assertEqual(audit.object_id, str(self.department_id))
            self.assertEqual(json.loads(audit.fields_json), ["director_photo"])
            self.assertEqual(json.loads(audit.metadata_json), {"size_bytes": len(stored.payload)})
            self.assertNotIn("PRIVATE", audit.fields_json + audit.metadata_json)

    def test_jpeg_orientation_is_applied_before_exif_and_gps_metadata_are_removed(self):
        self.as_user(self.admin_id)
        response = self.upload(content=portrait(image_format="JPEG", metadata=True, orientation=6))
        self.assertEqual(response.status_code, 200, response.text)
        content = self.client.get(response.json()["director_photo_url"]).content
        with Image.open(io.BytesIO(content)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.size, (48, 64))
            self.assertEqual(image.info, {})
            self.assertEqual(dict(image.getexif()), {})
        self.assertNotIn(b"PRIVATE", content)

    def test_photo_reset_and_logo_reset_are_independent(self):
        self.as_user(self.admin_id)
        logo_path = f"/api/branding/departments/{self.department_id}/logo"
        logo = self.upload(path=logo_path, content=transparent_logo()).json()["logo_url"]
        photo = self.upload().json()["director_photo_url"]
        response = self.client.delete(self.path)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["director_photo_url"])
        self.assertFalse(response.json()["director_photo_custom"])
        self.assertEqual(response.json()["logo_url"], logo)
        self.assertEqual(self.client.get(photo).status_code, 404)
        self.assertEqual(self.client.get(logo).status_code, 200)
        photo = self.upload().json()["director_photo_url"]
        response = self.client.delete(logo_path)
        self.assertEqual(response.json()["director_photo_url"], photo)
        self.assertEqual(self.client.get(photo).status_code, 200)
        self.assertEqual(self.client.get(logo).status_code, 404)
        self.assertEqual(self.upload(path=logo_path, content=portrait()).status_code, 422)

    def test_cache_replacement_digest_validation_and_missing_department(self):
        self.as_user(self.admin_id)
        first = self.upload().json()["director_photo_url"]
        self.client.headers.pop("Authorization")
        image = self.client.get(first)
        self.assertEqual(image.headers["Cache-Control"], IMMUTABLE_CACHE)
        self.assertEqual(self.client.get(first, headers={"If-None-Match": image.headers["ETag"]}).status_code, 304)
        self.assertEqual(self.client.get(first, headers={"If-None-Match": "*"}).status_code, 304)
        self.as_user(self.admin_id)
        second = self.upload(content=portrait(size=(80, 64))).json()["director_photo_url"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.client.get(first).status_code, 404)
        self.assertEqual(self.client.get(second).status_code, 200)
        digest = "0" * 64
        for key in ("director-0", "director-01", "director--1", "director-x", "director-99999999999999999999"):
            self.assertEqual(self.client.get(f"/api/branding/assets/{key}/{digest}.png").status_code, 422)
        self.assertEqual(self.client.get(f"/api/branding/assets/director-{self.department_id}/{digest}.png").status_code, 404)
        missing = "/api/branding/departments/9999/director-photo"
        self.assertEqual(self.upload(path=missing).status_code, 404)
        self.assertEqual(self.client.delete(missing).status_code, 404)

    def test_invalid_images_preserve_current_photo_without_additional_audit(self):
        self.as_user(self.admin_id)
        initial = self.upload().json()
        animation = io.BytesIO()
        Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(animation, format="PNG", save_all=True,
            append_images=[Image.new("RGBA", (64, 64), (10, 20, 30, 255))], duration=100, loop=0)
        invisible = io.BytesIO()
        Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(invisible, format="PNG")
        cases = [(b"", 422), (b"<svg/>", 422), (portrait()[:50], 422),
                 (portrait(size=(31, 64)), 422), (portrait(size=(4097, 32)), 422),
                 (portrait(size=(2049, 2049)), 422), (animation.getvalue(), 422),
                 (invisible.getvalue(), 422), (portrait() + b"x" * MAX_LOGO_BYTES, 413)]
        for content, expected in cases:
            with self.subTest(length=len(content), expected=expected):
                result = self.upload(content=content)
                self.assertEqual(result.status_code, expected, result.text)
                self.assertEqual(self.client.get("/api/developers").json()["departments"][0], initial)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 1)
            self.assertEqual(db.query(AuditLog).count(), 1)

    def test_audit_failure_rolls_back_new_upload_replacement_and_reset(self):
        self.as_user(self.admin_id)
        with patch("app.routers.branding.record_audit", side_effect=RuntimeError("audit unavailable")):
            self.assertEqual(self.upload().status_code, 500)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
        initial = self.upload().json()
        with patch("app.routers.branding.record_audit", side_effect=RuntimeError("audit unavailable")):
            self.assertEqual(self.upload(content=portrait(size=(80, 80))).status_code, 500)
            self.assertEqual(self.client.delete(self.path).status_code, 500)
        self.assertEqual(self.client.get("/api/developers").json()["departments"][0], initial)
        with self.sessions() as db:
            self.assertEqual(db.query(AuditLog).count(), 1)

    def test_department_deletion_cleans_photo_and_logo_and_audits_department(self):
        self.as_user(self.admin_id)
        logo_path = f"/api/branding/departments/{self.department_id}/logo"
        logo = self.upload(path=logo_path, content=transparent_logo()).json()["logo_url"]
        photo = self.upload().json()["director_photo_url"]
        result = self.client.delete(f"/api/developers/departments/{self.department_id}")
        self.assertEqual(result.status_code, 200, result.text)
        for url in (photo, logo):
            self.assertEqual(self.client.get(url).status_code, 404)
        self.assertEqual(self.upload().status_code, 404)
        self.assertEqual(self.client.get("/api/developers").json(), {"departments": []})
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
            self.assertEqual(db.query(User).count(), 2)
            self.assertEqual(db.query(AuditLog).order_by(AuditLog.id.desc()).first().action, "developer_department.delete")

    def test_photo_survives_verified_sqlite_backup_with_original_department_and_accounts(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / "qstudy.db"
            uploads = root / "uploads"
            uploads.mkdir()
            engine = create_engine("sqlite:///" + database.as_posix())
            Base.metadata.create_all(engine)
            photo = normalize_director_photo(portrait(image_format="JPEG", metadata=True))
            with sessionmaker(bind=engine)() as db:
                admin = User(email="admin@example.com", hashed_password="UNCHANGED_HASH", role="admin")
                department = DeveloperDepartment(name="Coding", director="A Director", logo="coding")
                db.add_all([admin, department])
                db.flush()
                department_id = department.id
                put_asset(db, f"director-{department_id}", photo, admin.id)
                db.commit()
            engine.dispose()
            service = BackupService(database, uploads, root / "backups")
            result = service.create()
            restored = root / "restored"
            restored.mkdir()
            verify_backup(service.archive_path(result["name"]), extract_to=restored)
            with closing(sqlite3.connect(restored / "database.sqlite3")) as db:
                row = db.execute("SELECT digest,payload,department_id FROM branding_assets WHERE key=?", (f"director-{department_id}",)).fetchone()
                self.assertEqual(row, (photo.digest, photo.payload, department_id))
                self.assertEqual(db.execute("SELECT director FROM developer_departments").fetchone()[0], "A Director")
                self.assertEqual(db.execute("SELECT hashed_password FROM users").fetchone()[0], "UNCHANGED_HASH")
                self.assertEqual(db.execute("PRAGMA foreign_key_check").fetchall(), [])


if __name__ == "__main__":
    unittest.main()
