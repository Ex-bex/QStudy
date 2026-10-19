"""Independent QMessage branding: existing Q-ID permissions, PNG hygiene and audit."""
import io
import json
import os
import unittest

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app.auth import create_access_token
from app.database import Base, get_db
from app.models import BrandingAsset, User
from app.operational_models import AuditLog
from app.routers import branding
from app.services.branding import IMMUTABLE_CACHE


def logo(*, metadata=False):
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    image.putpixel((32, 32), (10, 100, 150, 255))
    info = PngImagePlugin.PngInfo()
    if metadata:
        info.add_text("private", "PRIVATE_METADATA")
    output = io.BytesIO()
    image.save(output, format="PNG", pnginfo=info)
    return output.getvalue() + (b"PRIVATE_TRAILING_CONTENT" if metadata else b"")


class QMessageBrandingTests(unittest.TestCase):
    def setUp(self):
        self.engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            admin = User(email="admin@example.test", role="admin", hashed_password="PRIVATE_HASH")
            student = User(email="student@example.test", role="student", hashed_password="PRIVATE_HASH")
            db.add_all([admin, student]); db.commit()
            self.admin_id, self.student_id = admin.id, student.id
        app = FastAPI()
        app.include_router(branding.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        app.dependency_overrides[get_db] = database
        self.client = TestClient(app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close(); self.engine.dispose()

    def authorize(self, user_id):
        self.client.headers["Authorization"] = "Bearer " + create_access_token(user_id)

    def upload(self, content=None, path="/api/branding/message-logo"):
        return self.client.put(path, files={"file": ("PRIVATE_FILENAME.png", logo() if content is None else content, "image/png")})

    def test_public_default_and_active_admin_permission_are_independent_of_login_role_claim(self):
        self.assertEqual(self.client.get("/api/branding/message").json(), {"logo_url": "/brand/qmessage-prototype.svg", "logo_custom": False})
        self.assertEqual(self.upload().status_code, 401)
        self.assertEqual(self.client.delete("/api/branding/message-logo").status_code, 401)
        self.authorize(self.student_id)
        self.assertEqual(self.upload().status_code, 403)
        self.assertEqual(self.client.delete("/api/branding/message-logo").status_code, 403)
        self.authorize(self.admin_id)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "student"; db.commit()
        self.assertEqual(self.upload().status_code, 403)
        with self.sessions() as db:
            account = db.get(User, self.admin_id)
            account.role = "admin"; account.is_active = False; db.commit()
        self.assertEqual(self.client.delete("/api/branding/message-logo").status_code, 401)
        with self.sessions() as db:
            self.assertEqual(db.query(BrandingAsset).count(), 0)
            self.assertEqual(db.query(AuditLog).count(), 0)

    def test_upload_reset_preserve_other_brands_and_audit_only_asset_metadata(self):
        initial = self.client.get("/api/branding/message").json()
        self.authorize(self.admin_id)
        project = self.upload(path="/api/branding/project-logo").json()
        tests = self.upload(path="/api/branding/tests-logo").json()
        ecosystem = self.client.get("/api/branding/ecosystem").json()
        uploaded = self.upload(logo(metadata=True))
        self.assertEqual(uploaded.status_code, 200, uploaded.text)
        value = uploaded.json()
        self.assertEqual(set(value), {"logo_url", "logo_custom"})
        self.assertRegex(value["logo_url"], r"^/api/branding/assets/qmessage/[a-f0-9]{64}\.png$")
        self.assertTrue(value["logo_custom"])
        self.client.headers.clear()
        downloaded = self.client.get(value["logo_url"])
        self.assertEqual(downloaded.status_code, 200)
        self.assertEqual(downloaded.headers["cache-control"], IMMUTABLE_CACHE)
        self.assertNotIn(b"PRIVATE", downloaded.content)
        with Image.open(io.BytesIO(downloaded.content)) as image:
            self.assertEqual(image.info, {})
            self.assertEqual(image.getpixel((0, 0)), (0, 0, 0, 0))
        self.assertEqual(self.client.get(value["logo_url"], headers={"If-None-Match": downloaded.headers["etag"]}).status_code, 304)
        self.assertEqual(self.client.get("/api/branding/message").json(), value)
        self.assertEqual(self.client.get("/api/branding").json(), project)
        self.assertEqual(self.client.get("/api/branding/tests").json(), tests)
        self.assertEqual(self.client.get("/api/branding/ecosystem").json(), ecosystem)
        self.authorize(self.admin_id)
        self.assertEqual(self.client.delete("/api/branding/message-logo").json(), initial)
        self.assertEqual(self.client.get(value["logo_url"]).status_code, 404)
        with self.sessions() as db:
            events = db.query(AuditLog).filter(AuditLog.object_id == "qmessage").order_by(AuditLog.id).all()
            self.assertEqual([event.action for event in events], ["branding.message_logo.upload", "branding.message_logo.reset"])
            for event in events:
                self.assertEqual(json.loads(event.fields_json), ["logo"])
                self.assertNotIn("PRIVATE", event.metadata_json)
            self.assertEqual(db.query(User).count(), 2)

    def test_rejected_file_does_not_replace_the_previous_message_logo(self):
        self.authorize(self.admin_id)
        current = self.upload().json()
        for content, status in ((b"not png", 422), (logo() + b"x" * (2 * 1024 * 1024), 413)):
            self.assertEqual(self.upload(content).status_code, status)
            self.assertEqual(self.client.get("/api/branding/message").json(), current)
        self.assertEqual(self.client.get(current["logo_url"]).status_code, 200)
        self.assertEqual(self.client.get("/api/branding/assets/qmessage/invalid.png").status_code, 422)
        with self.sessions() as db:
            self.assertEqual(db.query(AuditLog).filter(AuditLog.object_id == "qmessage").count(), 1)


if __name__ == "__main__":
    unittest.main()
