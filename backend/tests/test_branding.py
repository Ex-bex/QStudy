"""Branding authorization, PNG sanitation, public caching and backup regressions."""
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
from sqlalchemy import create_engine, inspect
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import create_access_token
from app.database import Base, get_db
from app.models import BrandingAsset, DeveloperDepartment, User
from app.operational_models import AuditLog
from app.routers import branding, developers
from app.services.backups import BackupService, verify_backup
from app.services.branding import (DEFAULT_PROJECT_LOGO, DEFAULT_CAREER_LOGO, DEFAULT_IDENTITY_LOGO,
                                  DEFAULT_CONTROL_LOGO, IMMUTABLE_CACHE, MAX_LOGO_BYTES,
                                  career_branding, ecosystem_branding, normalize_png)
from app.security import BodySizeLimitMiddleware


def png(*, size=(64, 48), mode="RGBA", color=(0, 0, 0, 0), metadata=False, trailing=False):
    image = Image.new(mode, size, color)
    image.putpixel((size[0] // 2, size[1] // 2), (100, 40, 220, 255) if mode == "RGBA" else (100, 40, 220))
    info = PngImagePlugin.PngInfo()
    if metadata:
        info.add_text("private", "PRIVATE_METADATA")
    result = io.BytesIO()
    image.save(result, format="PNG", pnginfo=info)
    return result.getvalue() + (b"PRIVATE_APPENDED<script>" if trailing else b"")


class BrandingTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            admin = User(email="admin-private@example.com", role="admin", hashed_password="PRIVATE_HASH")
            student = User(email="student-private@example.com", role="student", hashed_password="PRIVATE_HASH")
            department = DeveloperDepartment(name="Coding Department", director="A Director", logo="coding")
            db.add_all([admin, student, department]); db.commit()
            self.admin_id, self.student_id, self.department_id = admin.id, student.id, department.id
        self.app = FastAPI()
        self.app.include_router(branding.router, prefix="/api")
        self.app.include_router(developers.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_db] = database
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close()
        self.engine.dispose()

    def as_user(self, user_id):
        self.client.headers["Authorization"] = "Bearer " + create_access_token(user_id)

    def upload(self, path="/api/branding/project-logo", *, content=None, name="private-original.png", media="image/png"):
        return self.client.put(path, files={"file": (name, png() if content is None else content, media)})

    def test_public_defaults_do_not_disclose_any_account_or_storage_metadata(self):
        response = self.client.get("/api/branding")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"project_logo_url": DEFAULT_PROJECT_LOGO, "project_logo_custom": False})
        row = self.client.get("/api/developers").json()["departments"][0]
        self.assertEqual(row["logo_url"], "/brand/qforce_logo_coding.jpeg")
        self.assertFalse(row["logo_custom"])
        self.assertNotIn("PRIVATE", response.text)
        self.assertNotIn("admin-private", response.text)

    def test_every_upload_and_reset_requires_current_active_admin(self):
        paths = ["/api/branding/project-logo", "/api/branding/career-logo", "/api/branding/identity-logo",
                 "/api/branding/control-logo", f"/api/branding/departments/{self.department_id}/logo"]
        for user_id, expected in ((None, 401), (self.student_id, 403)):
            if user_id:
                self.as_user(user_id)
            for path in paths:
                self.assertEqual(self.upload(path).status_code, expected)
                self.assertEqual(self.client.delete(path).status_code, expected)
        self.as_user(self.admin_id)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "student"; db.commit()
        self.assertEqual(self.upload().status_code, 403)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "admin"
            db.get(User, self.admin_id).is_active = False; db.commit()
        self.assertEqual(self.client.delete(paths[0]).status_code, 401)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
            self.assertEqual(db.query(AuditLog).count(), 0)

    def test_upload_reencodes_alpha_without_metadata_names_or_appended_bytes(self):
        self.as_user(self.admin_id)
        original = png(metadata=True, trailing=True)
        response = self.upload(content=original, name="../PRIVATE_FILENAME.png", media="application/octet-stream")
        self.assertEqual(response.status_code, 200, response.text)
        document = response.json()
        self.assertEqual(set(document), {"project_logo_url", "project_logo_custom"})
        self.assertTrue(document["project_logo_custom"])
        self.client.headers.clear()
        image_response = self.client.get(document["project_logo_url"])
        self.assertEqual(image_response.status_code, 200)
        self.assertEqual(image_response.headers["content-type"], "image/png")
        self.assertEqual(image_response.headers["x-content-type-options"], "nosniff")
        with Image.open(io.BytesIO(image_response.content)) as decoded:
            self.assertEqual(decoded.mode, "RGBA")
            self.assertEqual(decoded.getpixel((0, 0)), (0, 0, 0, 0))
            self.assertEqual(decoded.getpixel((32, 24)), (100, 40, 220, 255))
            self.assertEqual(decoded.info, {})
        self.assertNotIn(b"PRIVATE", image_response.content)
        with self.sessions() as db:
            asset = db.get(BrandingAsset, "project")
            self.assertEqual(asset.digest, hashlib.sha256(asset.payload).hexdigest())
            self.assertIn(asset.digest, document["project_logo_url"])
            self.assertEqual((asset.width, asset.height, asset.uploaded_by), (64, 48, self.admin_id))
            event = db.query(AuditLog).one()
            self.assertEqual(event.action, "branding.project_logo.upload")
            self.assertEqual(json.loads(event.fields_json), ["logo"])
            self.assertEqual(json.loads(event.metadata_json), {"size_bytes": len(asset.payload)})
            self.assertNotIn("PRIVATE", event.metadata_json + event.fields_json)

    def test_invalid_pngs_reject_without_changing_current_logo(self):
        self.as_user(self.admin_id)
        initial = self.upload().json()
        output = io.BytesIO(); Image.new("RGB", (64, 64)).save(output, format="JPEG")
        opaque = png(mode="RGB", color=(255, 255, 255))
        invisible = io.BytesIO(); Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(invisible, format="PNG")
        animation = io.BytesIO()
        Image.new("RGBA", (64, 64), (0, 0, 0, 0)).save(animation, format="PNG", save_all=True,
              append_images=[Image.new("RGBA", (64, 64), (10, 20, 30, 255))], duration=100, loop=0)
        cases = [(output.getvalue(), 422), (b"<svg/>" , 422), (b"", 422), (png()[:60], 422),
                 (opaque, 422), (invisible.getvalue(), 422), (animation.getvalue(), 422),
                 (png(size=(31, 64)), 422), (png(size=(4097, 32)), 422), (png(size=(2049, 2049)), 422),
                 (png() + b"x" * MAX_LOGO_BYTES, 413)]
        for content, expected in cases:
            with self.subTest(length=len(content), expected=expected):
                response = self.upload(content=content)
                self.assertEqual(response.status_code, expected, response.text)
                self.assertEqual(self.client.get("/api/branding").json(), initial)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 1)
            self.assertEqual(db.query(AuditLog).count(), 1)

    def test_public_digest_urls_cache_and_old_or_arbitrary_assets_are_not_served(self):
        self.as_user(self.admin_id)
        first = self.upload().json()["project_logo_url"]
        self.client.headers.clear()
        response = self.client.get(first)
        self.assertEqual(response.headers["cache-control"], IMMUTABLE_CACHE)
        self.assertEqual(self.client.get(first, headers={"If-None-Match": response.headers["etag"]}).status_code, 304)
        self.as_user(self.admin_id)
        second = self.upload(content=png(size=(80, 80))).json()["project_logo_url"]
        self.assertNotEqual(first, second)
        self.assertEqual(self.client.get(first).status_code, 404)
        self.assertEqual(self.client.get(second).status_code, 200)
        digest = "0" * 64
        for key in ("uploads", "project-secret", "department-0", "department-01", "department-9999999999999999999999999"):
            self.assertEqual(self.client.get(f"/api/branding/assets/{key}/{digest}.png").status_code, 422)
        self.assertEqual(self.client.get(f"/api/branding/assets/project/{digest}.png").status_code, 404)
        self.assertEqual(self.client.get("/api/branding/assets/project/private.png").status_code, 422)

    def test_department_upload_reset_and_delete_leave_other_logos_unchanged(self):
        self.as_user(self.admin_id)
        project = self.upload().json()
        path = f"/api/branding/departments/{self.department_id}/logo"
        row = self.upload(path, content=png(size=(96, 40))).json()
        self.assertTrue(row["logo_custom"])
        self.assertEqual(row["logo"], "coding")
        self.assertIn(f"/assets/department-{self.department_id}/", row["logo_url"])
        self.assertEqual(self.client.get("/api/developers").json()["departments"][0], row)
        reset = self.client.delete(path)
        self.assertEqual(reset.status_code, 200)
        self.assertFalse(reset.json()["logo_custom"])
        self.assertEqual(reset.json()["logo_url"], "/brand/qforce_logo_coding.jpeg")
        self.assertEqual(self.client.get(row["logo_url"]).status_code, 404)
        uploaded = self.upload(path).json()
        self.assertEqual(self.client.delete(f"/api/developers/departments/{self.department_id}").status_code, 200)
        self.assertEqual(self.client.get(uploaded["logo_url"]).status_code, 404)
        self.assertEqual(self.upload(path).status_code, 404)
        self.assertEqual(self.client.delete(path).status_code, 404)
        self.assertEqual(self.client.get("/api/branding").json(), project)
        with self.sessions() as db:
            self.assertEqual([row.key for row in db.query(BrandingAsset).all()], ["project"])

    def test_project_reset_restores_default_and_is_audited(self):
        self.as_user(self.admin_id)
        custom = self.upload().json()["project_logo_url"]
        response = self.client.delete("/api/branding/project-logo")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"project_logo_url": DEFAULT_PROJECT_LOGO, "project_logo_custom": False})
        self.assertEqual(self.client.get(custom).status_code, 404)
        self.assertEqual(self.client.delete("/api/branding/project-logo").status_code, 200)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
            self.assertEqual([e.action for e in db.query(AuditLog).order_by(AuditLog.id)],
                ["branding.project_logo.upload", "branding.project_logo.reset", "branding.project_logo.reset"])

    def test_career_transparent_logo_uses_same_private_database_public_digest_and_audit(self):
        with self.sessions() as db:
            self.assertEqual(career_branding(db), {"logo_url": DEFAULT_CAREER_LOGO, "logo_custom": False})
        self.as_user(self.admin_id)
        project = self.upload().json()
        career = self.upload("/api/branding/career-logo", content=png(size=(120, 64), metadata=True, trailing=True))
        self.assertEqual(career.status_code, 200, career.text)
        logo = career.json()
        self.assertTrue(logo["logo_custom"])
        self.assertIn("/assets/qcareer/", logo["logo_url"])
        self.client.headers.clear()
        pixels = self.client.get(logo["logo_url"])
        self.assertEqual(pixels.status_code, 200)
        self.assertEqual(pixels.headers["cache-control"], IMMUTABLE_CACHE)
        self.assertNotIn(b"PRIVATE_", pixels.content)
        self.assertEqual(self.client.get(logo["logo_url"], headers={"If-None-Match": pixels.headers["etag"]}).status_code, 304)
        self.assertEqual(self.client.get("/api/branding").json(), project)
        self.as_user(self.admin_id)
        rejected = self.upload("/api/branding/career-logo", content=png(mode="RGB"))
        self.assertEqual(rejected.status_code, 422)
        with self.sessions() as db:
            self.assertEqual(career_branding(db), logo)
        reset = self.client.delete("/api/branding/career-logo")
        self.assertEqual(reset.json(), {"logo_url": DEFAULT_CAREER_LOGO, "logo_custom": False})
        self.assertEqual(self.client.get(logo["logo_url"]).status_code, 404)
        self.assertEqual(self.client.get("/api/branding").json(), project)
        with self.sessions() as db:
            self.assertEqual([r.action for r in db.query(AuditLog).filter(AuditLog.object_id == "qcareer").order_by(AuditLog.id)],
                             ["branding.career_logo.upload", "branding.career_logo.reset"])

    def test_upload_and_reset_audit_failures_roll_back_atomically(self):
        self.as_user(self.admin_id)
        with patch("app.routers.branding.record_audit", side_effect=RuntimeError("audit unavailable")):
            self.assertEqual(self.upload().status_code, 500)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
        initial = self.upload().json()
        with patch("app.routers.branding.record_audit", side_effect=RuntimeError("audit unavailable")):
            self.assertEqual(self.upload(content=png(size=(80, 80))).status_code, 500)
            self.assertEqual(self.client.delete("/api/branding/project-logo").status_code, 500)
        self.assertEqual(self.client.get("/api/branding").json(), initial)
        with self.sessions() as db:
            self.assertEqual(db.query(AuditLog).count(), 1)

    def test_ecosystem_public_defaults_preserve_existing_branding_contract(self):
        response = self.client.get("/api/branding/ecosystem")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"identity_logo_url": DEFAULT_IDENTITY_LOGO,
                                          "identity_logo_custom": False,
                                          "control_logo_url": DEFAULT_CONTROL_LOGO,
                                          "control_logo_custom": False})
        self.assertEqual(self.client.get("/api/branding").json(),
                         {"project_logo_url": DEFAULT_PROJECT_LOGO, "project_logo_custom": False})
        with self.sessions() as db:
            self.assertEqual(career_branding(db), {"logo_url": DEFAULT_CAREER_LOGO, "logo_custom": False})
            self.assertEqual(db.query(BrandingAsset).count(), 0)
        self.assertNotIn("PRIVATE", response.text)
        self.assertNotIn("admin-private", response.text)

    def test_ecosystem_logos_sanitize_cache_audit_and_reset_independently(self):
        self.as_user(self.admin_id)
        project = self.upload().json()
        career = self.upload("/api/branding/career-logo").json()
        identity = self.upload("/api/branding/identity-logo", content=png(metadata=True, trailing=True)).json()
        self.assertTrue(identity["identity_logo_custom"])
        self.assertFalse(identity["control_logo_custom"])
        control = self.upload("/api/branding/control-logo", content=png(size=(96, 64))).json()
        self.assertTrue(control["control_logo_custom"])
        self.assertEqual(control["identity_logo_url"], identity["identity_logo_url"])
        self.client.headers.clear()
        self.assertEqual(self.client.get("/api/branding/ecosystem").json(), control)
        for key, url in (("qid", control["identity_logo_url"]), ("qcontrol", control["control_logo_url"])):
            with self.subTest(key=key):
                self.assertIn(f"/assets/{key}/", url)
                response = self.client.get(url)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.headers["cache-control"], IMMUTABLE_CACHE)
                self.assertEqual(response.headers["x-content-type-options"], "nosniff")
                self.assertNotIn(b"PRIVATE", response.content)
                with Image.open(io.BytesIO(response.content)) as decoded:
                    self.assertEqual(decoded.mode, "RGBA")
                    self.assertEqual(decoded.info, {})
                self.assertEqual(self.client.get(url, headers={"If-None-Match": response.headers["etag"]}).status_code, 304)
        self.as_user(self.admin_id)
        reset = self.client.delete("/api/branding/identity-logo")
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(reset.json()["identity_logo_url"], DEFAULT_IDENTITY_LOGO)
        self.assertFalse(reset.json()["identity_logo_custom"])
        self.assertEqual(reset.json()["control_logo_url"], control["control_logo_url"])
        self.assertEqual(self.client.get(control["identity_logo_url"]).status_code, 404)
        self.assertEqual(self.client.get(control["control_logo_url"]).status_code, 200)
        reset = self.client.delete("/api/branding/control-logo")
        self.assertEqual(reset.status_code, 200)
        self.assertEqual(reset.json()["control_logo_url"], DEFAULT_CONTROL_LOGO)
        self.assertFalse(reset.json()["control_logo_custom"])
        self.assertEqual(self.client.get(control["control_logo_url"]).status_code, 404)
        self.assertEqual(self.client.get("/api/branding").json(), project)
        with self.sessions() as db:
            self.assertEqual(career_branding(db), career)
            self.assertEqual([row.key for row in db.query(BrandingAsset).order_by(BrandingAsset.key)], ["project", "qcareer"])
            events = db.query(AuditLog).filter(AuditLog.object_id.in_(["qid", "qcontrol"])).order_by(AuditLog.id).all()
            self.assertEqual([event.action for event in events], ["branding.identity_logo.upload", "branding.control_logo.upload",
                                                                 "branding.identity_logo.reset", "branding.control_logo.reset"])
            self.assertTrue(all(json.loads(event.fields_json) == ["logo"] for event in events))

    def test_ecosystem_invalid_png_and_audit_failure_keep_both_logos_unchanged(self):
        self.as_user(self.admin_id)
        self.upload("/api/branding/identity-logo")
        initial = self.upload("/api/branding/control-logo", content=png(size=(96, 64))).json()
        for route in ("identity-logo", "control-logo"):
            with self.subTest(route=route):
                path = f"/api/branding/{route}"
                for content, expected in ((b"<svg/>", 422), (png(mode="RGB"), 422), (png() + b"x" * MAX_LOGO_BYTES, 413)):
                    self.assertEqual(self.upload(path, content=content).status_code, expected)
                    self.assertEqual(self.client.get("/api/branding/ecosystem").json(), initial)
                with patch("app.routers.branding.record_audit", side_effect=RuntimeError("audit unavailable")):
                    self.assertEqual(self.upload(path, content=png(size=(128, 64))).status_code, 500)
                    self.assertEqual(self.client.delete(path).status_code, 500)
                self.assertEqual(self.client.get("/api/branding/ecosystem").json(), initial)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 2)
            self.assertEqual(db.query(AuditLog).count(), 2)
            self.assertEqual(ecosystem_branding(db), initial)

    def test_new_table_additive_upgrade_preserves_users_and_existing_logo(self):
        from app import main
        BrandingAsset.__table__.drop(self.engine)
        with patch.object(main, "engine", self.engine), patch.object(main, "SessionLocal", self.sessions), \
             patch("app.services.syllabus.seed_academic_defaults"), \
             patch("app.services.reference_curriculum.seed_sourced_curriculum"), \
             patch("app.services.reference_timetable.seed_sourced_timetable"), \
             patch("app.services.developers.seed_developer_departments"):
            main.initialize_database()
            self.assertIn("branding_assets", inspect(self.engine).get_table_names())
            self.as_user(self.admin_id)
            custom = self.upload().json()
            main.initialize_database()
            self.assertEqual(self.client.get("/api/branding").json(), custom)
            with self.sessions() as db:
                self.assertEqual(db.query(User).count(), 2)
                self.assertEqual(db.get(User, self.admin_id).hashed_password, "PRIVATE_HASH")
        self.assertIn("/api/branding/project-logo", main.app.openapi()["paths"])

    def test_main_security_middleware_preserves_only_public_asset_cache(self):
        from app import main
        application = FastAPI()
        application.middleware("http")(main.request_security)
        application.include_router(branding.router, prefix="/api")
        application.dependency_overrides[get_db] = self.app.dependency_overrides[get_db]
        self.as_user(self.admin_id)
        url = self.upload().json()["project_logo_url"]
        with TestClient(application) as client, patch("app.main.rate_limit"):
            response = client.get(url)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["cache-control"], IMMUTABLE_CACHE)
            self.assertEqual(client.get(url, headers={"If-None-Match": response.headers["etag"]}).headers["cache-control"], IMMUTABLE_CACHE)
            self.assertEqual(client.get("/api/branding").headers["cache-control"], "no-store")
            self.assertEqual(client.get(url.replace(url.split("/")[-1], "0" * 64 + ".png")).headers["cache-control"], "no-store")

    def test_normalized_logo_survives_verified_sqlite_backup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database, uploads = root / "database.sqlite3", root / "uploads"
            uploads.mkdir()
            engine = create_engine("sqlite:///" + database.as_posix())
            Base.metadata.create_all(engine)
            logo = normalize_png(png(metadata=True, trailing=True))
            with sessionmaker(bind=engine)() as db:
                db.add(BrandingAsset(key="project", digest=logo.digest, payload=logo.payload,
                                    width=logo.width, height=logo.height)); db.commit()
            engine.dispose()
            service = BackupService(database, uploads, root / "backups")
            result = service.create()
            restored = root / "restored"; restored.mkdir()
            verify_backup(service.archive_path(result["name"]), extract_to=restored)
            with closing(sqlite3.connect(restored / "database.sqlite3")) as db:
                digest, payload = db.execute("SELECT digest, payload FROM branding_assets WHERE key='project'").fetchone()
                self.assertEqual(digest, logo.digest)
                self.assertEqual(payload, logo.payload)

    def test_upload_request_limit_includes_streamed_multipart_before_persisting(self):
        from app import main
        application = FastAPI()
        application.add_middleware(BodySizeLimitMiddleware)
        application.middleware("http")(main.request_security)
        application.include_router(branding.router, prefix="/api")
        application.dependency_overrides[get_db] = self.app.dependency_overrides[get_db]
        authorization = "Bearer " + create_access_token(self.admin_id)
        with TestClient(application, raise_server_exceptions=False) as client, patch("app.main.rate_limit"):
            response = client.put("/api/branding/project-logo", files={"file": ("large.png", b"x" * (MAX_LOGO_BYTES + 65537), "image/png")},
                                  headers={"Authorization": authorization})
            self.assertEqual(response.status_code, 413, response.text)
            chunks = [b'--logo\r\nContent-Disposition: form-data; name="file"; filename="logo.png"\r\nContent-Type: image/png\r\n\r\n',
                      b"x" * (MAX_LOGO_BYTES + 65537), b"\r\n--logo--\r\n"]
            response = client.put("/api/branding/project-logo", content=iter(chunks),
                headers={"Authorization": authorization, "Content-Type": "multipart/form-data; boundary=logo"})
            self.assertEqual(response.status_code, 413, response.text)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
            self.assertEqual(db.query(AuditLog).count(), 0)


if __name__ == "__main__":
    unittest.main()
