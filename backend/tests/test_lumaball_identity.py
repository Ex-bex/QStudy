"""Shared identity, guest permissions, moderation, logos and backup regressions."""
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth import create_access_token
from app.config import settings
from app.database import Base, get_db
from app.lumaball_models import (LumaBallGuestCredential, LumaBallProfile,
                                 LumaBallSettings, LumaBallTicket)
from app.models import AcademicSetting, BrandingAsset, User
from app.operational_models import AuditLog
from app.routers import lumaball_identity
from app.services.backups import BackupService, verify_backup
from app.services.lumaball_identity import (consume_ticket, get_config,
    resolve_identity, upgrade_default_brand, validate_identity)
from starlette.requests import Request


def png():
    image = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    image.putpixel((20, 20), (180, 100, 255, 255))
    output = io.BytesIO()
    info = PngImagePlugin.PngInfo()
    info.add_text("private", "PRIVATE_METADATA")
    image.save(output, format="PNG", pnginfo=info)
    return output.getvalue() + b"PRIVATE_TRAILING_BYTES"


def request(*, auth=None, guest=None):
    headers = []
    if auth:
        headers.append((b"authorization", ("Bearer " + auth).encode()))
    if guest:
        headers.append((b"x-lumaball-session", guest.encode()))
    return Request({"type": "http", "headers": headers, "client": ("127.0.0.1", 1234)})


class LumaBallIdentityTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.database = self.root / "shared.sqlite3"
        self.engine = create_engine("sqlite:///" + self.database.as_posix(), connect_args={"check_same_thread": False, "timeout": 15})
        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        with self.sessions() as db:
            admin = User(email="private-admin@example.com", name="Администратор", role="admin", hashed_password="PRIVATE_HASH")
            student = User(email="private-student@example.com", name="Студент", role="student", hashed_password="PRIVATE_HASH")
            db.add_all([admin, student]); db.commit()
            self.admin_id, self.student_id = admin.id, student.id
        self.admin_token = create_access_token(self.admin_id)
        self.student_token = create_access_token(self.student_id)
        self.app = FastAPI()
        self.app.include_router(lumaball_identity.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_db] = database
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.limits = patch.object(settings, "RATE_LIMIT_ENABLED", False)
        self.limits.start()

    def tearDown(self):
        self.client.close()
        self.limits.stop()
        self.engine.dispose()
        self.temporary.cleanup()

    def as_user(self, admin=False):
        self.client.headers.clear()
        self.client.headers["Authorization"] = "Bearer " + (self.admin_token if admin else self.student_token)

    def create_guest(self):
        self.client.headers.clear()
        response = self.client.post("/api/lumaball/session")
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def test_public_config_does_not_create_profiles_or_expose_private_records(self):
        response = self.client.get("/api/lumaball/config")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["title"], "QBall")
        self.assertIsNone(response.json()["logo_url"])
        self.assertNotIn("ice_servers", response.json())
        self.assertNotIn("private", response.text)
        self.assertEqual(self.client.get("/api/lumaball/me").status_code, 401)
        with self.sessions() as db:
            self.assertEqual(db.query(LumaBallProfile).count(), 0)
            self.assertEqual(db.query(User).count(), 2)

    def test_guest_identity_number_is_server_assigned_and_reused_after_new_session(self):
        first = self.create_guest()
        self.assertRegex(first["identity"]["name"], r"^guest#[1-9][0-9]{5}$")
        self.assertRegex(first["identity"]["id"], r"^[a-f0-9]{32}$")
        self.assertEqual(first["identity"]["kind"], "guest")
        self.assertFalse(first["identity"]["is_admin"])
        token = first["guest_token"]
        self.client.headers["X-LumaBall-Session"] = token
        second = self.client.post("/api/lumaball/session").json()
        self.assertEqual(first["identity"], second["identity"])
        self.assertNotEqual(first["ws_ticket"], second["ws_ticket"])
        self.assertNotIn("guest_token", second)
        with self.sessions() as db:
            self.assertEqual(db.query(LumaBallProfile).count(), 1)
            record = db.query(LumaBallGuestCredential).one()
            self.assertEqual(record.digest, hashlib.sha256(token.encode()).hexdigest())
            self.assertNotIn(token, str(record.__dict__))
            self.assertEqual(db.query(User).count(), 2)

    def test_invite_address_comes_from_active_launcher_not_request_host_or_editable_settings(self):
        address = "http://94.125.99.135:8080"
        with patch.object(settings, "PUBLIC_BASE_URL", address + "/"):
            response = self.client.get("/api/lumaball/config", headers={"Host": "untrusted.example"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["public_base_url"], address)
            self.assertEqual(self.create_guest()["config"]["public_base_url"], address)
        self.as_user(admin=True)
        self.assertEqual(self.client.patch("/api/admin/lumaball/settings", json={"public_base_url": "https://untrusted.example"}).status_code, 422)

    def test_independent_guests_receive_unique_random_numbers_without_qstudy_accounts(self):
        guests = [self.create_guest() for _ in range(8)]
        names = [guest["identity"]["name"] for guest in guests]
        self.assertEqual(len(set(names)), 8)
        self.assertEqual(len({guest["identity"]["id"] for guest in guests}), 8)
        for name in names:
            self.assertRegex(name, r"^guest#[1-9][0-9]{5}$")
        with self.sessions() as db:
            self.assertEqual(db.query(User).count(), 2)
            self.assertEqual({profile.name for profile in db.query(LumaBallProfile)}, set(names))
            for profile in db.query(LumaBallProfile):
                self.assertEqual(profile.name, f"guest#{profile.guest_number}")

    def test_default_brand_upgrade_preserves_existing_settings_and_accounts(self):
        stored = {"title": "LumaBall", "announcement": "Keep this announcement",
                  "guests_enabled": False, "score_limit": 7}
        with self.sessions() as db:
            db.add(LumaBallSettings(key="site", value_json=json.dumps(stored)))
            db.commit()
            self.assertTrue(upgrade_default_brand(db))
            db.commit()
            self.assertFalse(upgrade_default_brand(db))
            upgraded = json.loads(db.get(LumaBallSettings, "site").value_json)
            self.assertEqual(upgraded, {**stored, "title": "QBall"})
            self.assertEqual(get_config(db)["title"], "QBall")
            self.assertEqual(db.query(User).count(), 2)

    def test_default_brand_upgrade_preserves_custom_names_and_invalid_settings(self):
        with self.sessions() as db:
            self.assertFalse(upgrade_default_brand(db))
            row = LumaBallSettings(key="site", value_json='{"title":"Our football club"}')
            db.add(row)
            db.commit()
            self.assertFalse(upgrade_default_brand(db))
            self.assertEqual(get_config(db)["title"], "Our football club")
            row.value_json = "malformed saved settings"
            db.commit()
            self.assertFalse(upgrade_default_brand(db))
            self.assertEqual(row.value_json, "malformed saved settings")

    def test_guest_number_collision_is_retried_without_overwriting_another_guest(self):
        with patch("app.services.lumaball_identity.secrets.randbelow", side_effect=[17, 17, 18]):
            first = self.create_guest()
            second = self.create_guest()
        self.assertEqual(first["identity"]["name"], "guest#100017")
        self.assertEqual(second["identity"]["name"], "guest#100018")
        self.assertNotEqual(first["identity"]["id"], second["identity"]["id"])

    def test_registered_identity_uses_existing_account_and_can_set_only_game_nickname(self):
        self.as_user()
        response = self.client.post("/api/lumaball/session")
        self.assertEqual(response.status_code, 200, response.text)
        identity = response.json()["identity"]
        self.assertEqual(identity["user_id"], self.student_id)
        self.assertEqual(identity["kind"], "user")
        self.assertNotIn("guest_token", response.json())
        edited = self.client.patch("/api/lumaball/me", json={"name": "  Поле  7 "})
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertEqual(edited.json()["identity"]["name"], "Поле 7")
        with self.sessions() as db:
            student = db.get(User, self.student_id)
            self.assertEqual(student.name, "Студент")
            self.assertEqual(student.hashed_password, "PRIVATE_HASH")
            self.assertEqual(db.query(User).count(), 2)
        for name in ["guest#123456", "a", "Игрок\u202eдругой"]:
            self.assertEqual(self.client.patch("/api/lumaball/me", json={"name": name}).status_code, 422)

    def test_guest_cannot_choose_name_or_upgrade_identity_and_invalid_account_does_not_fall_back(self):
        guest = self.create_guest()
        self.client.headers["X-LumaBall-Session"] = guest["guest_token"]
        self.assertEqual(self.client.patch("/api/lumaball/me", json={"name": "Admin"}).status_code, 403)
        self.client.headers["Authorization"] = "Bearer invalid-token"
        self.assertEqual(self.client.post("/api/lumaball/session").status_code, 401)
        self.client.headers.pop("Authorization")
        self.client.headers["X-LumaBall-Session"] = "x" * 43
        self.assertEqual(self.client.post("/api/lumaball/session").status_code, 401)

    def test_every_admin_endpoint_requires_current_active_admin(self):
        guest = self.create_guest()
        mutations = [
            ("patch", "/api/admin/lumaball/settings", {"json": {"title": "Changed"}}),
            ("patch", "/api/admin/lumaball/players/" + guest["identity"]["id"], {"json": {"banned": True}}),
            ("delete", "/api/admin/lumaball/players/" + guest["identity"]["id"], {}),
            ("put", "/api/admin/lumaball/logo", {"content": png(), "headers": {"Content-Type": "image/png"}}),
            ("delete", "/api/admin/lumaball/logo", {}),
            ("get", "/api/admin/lumaball/players", {}),
            ("get", "/api/admin/lumaball/settings", {}),
        ]
        for user, expected in ((None, 401), ("student", 403)):
            self.client.headers.clear()
            if user:
                self.as_user()
            for method, path, kwargs in mutations:
                self.assertEqual(getattr(self.client, method)(path, **kwargs).status_code, expected, path)
        self.as_user(admin=True)
        with self.sessions() as db:
            db.get(User, self.admin_id).role = "student"; db.commit()
        self.assertEqual(self.client.patch("/api/admin/lumaball/settings", json={"enabled": False}).status_code, 403)
        with self.sessions() as db:
            self.assertEqual(db.query(AuditLog).count(), 0)

    def test_settings_partial_update_validates_complete_document_and_audits_names_only(self):
        self.as_user(admin=True)
        response = self.client.patch("/api/admin/lumaball/settings", json={"title": "Purple pitch", "max_players": 6})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["default_players"], 2)
        for values in [{"default_players": 7}, {"max_players": 1}, {"enabled": None}, {"enabled": "false"},
                       {"surprise": True}, {"ice_servers": [{"urls": ["https://example.com"]}]},
                       {"ice_servers": [{"urls": ["turn:user:password@example.com:3478"]}]}]:
            failed = self.client.patch("/api/admin/lumaball/settings", json=values)
            self.assertEqual(failed.status_code, 422, failed.text)
        with self.sessions() as db:
            self.assertEqual(get_config(db)["title"], "Purple pitch")
            audit = db.query(AuditLog).one()
            self.assertEqual(json.loads(audit.fields_json), ["max_players", "title"])
            self.assertNotIn("Purple pitch", audit.fields_json + audit.metadata_json)

    def test_original_free_play_defaults_and_saved_administrator_limits_are_preserved(self):
        defaults = self.client.get("/api/lumaball/config").json()
        self.assertEqual((defaults["max_players"], defaults["default_players"],
                          defaults["score_limit"], defaults["time_limit"]), (20, 2, 0, 0))
        stored = {"max_players": 8, "default_players": 4, "score_limit": 5,
                  "time_limit": 5, "announcement": "Saved custom rules"}
        with self.sessions() as db:
            raw = json.dumps(stored)
            db.add(LumaBallSettings(key="site", value_json=raw))
            db.commit()
            values = get_config(db)
            self.assertEqual({key: values[key] for key in stored}, stored)
            self.assertEqual(db.get(LumaBallSettings, "site").value_json, raw)
        self.as_user(admin=True)
        response = self.client.patch("/api/admin/lumaball/settings", json={"max_players": 20,
                       "default_players": 20, "score_limit": 0, "time_limit": 0})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["announcement"], stored["announcement"])
        for invalid in ({"max_players": 21}, {"default_players": 21}, {"score_limit": -1},
                        {"time_limit": -1}, {"score_limit": False}, {"time_limit": "0"}):
            self.assertEqual(self.client.patch("/api/admin/lumaball/settings", json=invalid).status_code, 422)

    def test_maintenance_and_guest_settings_take_effect_for_existing_identities(self):
        guest = self.create_guest()
        self.as_user(admin=True)
        self.assertEqual(self.client.patch("/api/admin/lumaball/settings", json={"guests_enabled": False}).status_code, 200)
        self.client.headers.clear()
        self.client.headers["X-LumaBall-Session"] = guest["guest_token"]
        self.assertEqual(self.client.get("/api/lumaball/me").status_code, 403)
        self.as_user(admin=True)
        self.assertEqual(self.client.patch("/api/admin/lumaball/settings", json={"enabled": False}).status_code, 200)
        self.assertEqual(self.client.post("/api/lumaball/session").status_code, 200)
        self.as_user()
        self.assertEqual(self.client.post("/api/lumaball/session").status_code, 503)

    def test_tickets_are_short_lived_single_use_and_stored_hashed(self):
        guest = self.create_guest()
        ticket = guest["ws_ticket"]
        with self.sessions() as db:
            record = db.query(LumaBallTicket).one()
            self.assertEqual(record.digest, hashlib.sha256(ticket.encode()).hexdigest())
            self.assertLessEqual((record.expires_at - record.created_at).total_seconds(), 60)
            identity = consume_ticket(ticket, db)
            self.assertEqual(identity.public(), guest["identity"])
            with self.assertRaises(HTTPException) as replay:
                consume_ticket(ticket, db)
            self.assertEqual(replay.exception.status_code, 401)
        self.client.headers["X-LumaBall-Session"] = guest["guest_token"]
        expired = self.client.post("/api/lumaball/session").json()["ws_ticket"]
        with self.sessions() as db:
            db.query(LumaBallTicket).update({"expires_at": datetime.utcnow() - timedelta(seconds=1)}); db.commit()
            with self.assertRaises(HTTPException):
                consume_ticket(expired, db)

    def test_concurrent_ticket_consumption_allows_exactly_one_connection(self):
        ticket = self.create_guest()["ws_ticket"]
        def consume():
            with self.sessions() as db:
                try:
                    consume_ticket(ticket, db)
                    return 200
                except HTTPException as error:
                    return error.status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            self.assertEqual(sorted(executor.map(lambda _: consume(), range(2))), [200, 401])

    def test_password_logout_revocation_and_bans_invalidate_pending_and_live_game_access(self):
        self.as_user()
        started = self.client.post("/api/lumaball/session").json()
        with self.sessions() as db:
            identity = resolve_identity(request(auth=self.student_token), db)
            student = db.get(User, self.student_id)
            student.token_version += 1; db.commit()
            with self.assertRaises(HTTPException):
                consume_ticket(started["ws_ticket"], db)
            with self.assertRaises(HTTPException):
                validate_identity(identity, db)
        self.assertEqual(self.client.get("/api/lumaball/me").status_code, 401)
        guest = self.create_guest()
        with self.sessions() as db:
            live = consume_ticket(guest["ws_ticket"], db)
        self.as_user(admin=True)
        response = self.client.patch("/api/admin/lumaball/players/" + guest["identity"]["id"],
                                     json={"banned": True, "ban_reason": "PRIVATE_REASON"})
        self.assertEqual(response.status_code, 200, response.text)
        self.client.headers.clear(); self.client.headers["X-LumaBall-Session"] = guest["guest_token"]
        response = self.client.get("/api/lumaball/me")
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("PRIVATE_REASON", response.text)
        with self.sessions() as db:
            with self.assertRaises(HTTPException) as banned:
                validate_identity(live, db)
            self.assertEqual(banned.exception.status_code, 403)

    def test_admin_cannot_be_banned_and_game_delete_preserves_account(self):
        self.as_user(admin=True)
        admin_profile = self.client.post("/api/lumaball/session").json()["identity"]["id"]
        self.assertEqual(self.client.patch("/api/admin/lumaball/players/" + admin_profile, json={"banned": True}).status_code, 409)
        self.assertEqual(self.client.delete("/api/admin/lumaball/players/" + admin_profile).status_code, 409)
        self.as_user()
        member = self.client.post("/api/lumaball/session").json()["identity"]["id"]
        self.as_user(admin=True)
        response = self.client.delete("/api/admin/lumaball/players/" + member)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["account_preserved"])
        with self.sessions() as db:
            self.assertIsNotNone(db.get(User, self.student_id))
            self.assertIsNone(db.get(LumaBallProfile, member))
            self.assertEqual(db.query(LumaBallTicket).filter(LumaBallTicket.profile_id == member).count(), 0)
        self.as_user()
        self.assertEqual(self.client.post("/api/lumaball/session").status_code, 200)

    def test_deleted_qstudy_account_does_not_become_guest_or_keep_ticket_access(self):
        self.as_user()
        started = self.client.post("/api/lumaball/session").json()
        with self.sessions() as db:
            db.delete(db.get(User, self.student_id)); db.commit()
            profile = db.get(LumaBallProfile, started["identity"]["id"])
            self.assertIsNone(profile.user_id)
            with self.assertRaises(HTTPException):
                consume_ticket(started["ws_ticket"], db)

    def test_backup_restore_cutoff_invalidates_old_guest_credentials_and_tickets(self):
        guest = self.create_guest()
        with self.sessions() as db:
            db.add(AcademicSetting(key="auth_min_iat", value=str(time.time() + 1))); db.commit()
            with self.assertRaises(HTTPException):
                consume_ticket(guest["ws_ticket"], db)
        self.client.headers["X-LumaBall-Session"] = guest["guest_token"]
        self.assertEqual(self.client.post("/api/lumaball/session").status_code, 401)

    def test_logo_upload_accepts_transparent_png_sanitizes_and_can_reset(self):
        self.as_user(admin=True)
        response = self.client.put("/api/admin/lumaball/logo", files={"file": ("PRIVATE_NAME.png", png(), "image/png")})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertRegex(response.json()["logo_url"], r"^/api/lumaball/logo\?v=[a-f0-9]{64}$")
        self.client.headers.clear()
        response = self.client.get(response.json()["logo_url"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertNotIn(b"PRIVATE", response.content)
        image = Image.open(io.BytesIO(response.content))
        self.assertEqual(image.mode, "RGBA")
        self.assertEqual(image.getpixel((0, 0))[3], 0)
        self.assertEqual(image.info, {})
        self.as_user(admin=True)
        self.assertEqual(self.client.put("/api/admin/lumaball/logo", content=b"<svg/>").status_code, 422)
        self.assertEqual(self.client.put("/api/admin/lumaball/logo", content=png(), headers={"Content-Type": "image/png"}).status_code, 200)
        self.assertIsNone(self.client.delete("/api/admin/lumaball/logo").json()["logo_url"])
        self.assertEqual(self.client.get("/api/lumaball/logo").status_code, 404)

    def test_players_search_pagination_and_audits_never_expose_passwords_or_email(self):
        guest = self.create_guest()
        self.as_user()
        self.client.post("/api/lumaball/session")
        self.as_user(admin=True)
        response = self.client.get("/api/admin/lumaball/players", params={"kind": "guest", "limit": 1})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total"], 1)
        self.assertEqual(response.json()["items"][0]["id"], guest["identity"]["id"])
        self.assertNotIn("PRIVATE_HASH", response.text)
        self.assertNotIn("@example.com", response.text)
        self.assertEqual(self.client.get("/api/admin/lumaball/players", params={"q": "%"}).json()["total"], 0)

    def test_additive_database_creation_and_backups_preserve_game_and_study_records(self):
        guest = self.create_guest()
        self.as_user(admin=True)
        self.client.patch("/api/admin/lumaball/settings", json={"announcement": "Saved setting"})
        self.client.put("/api/admin/lumaball/logo", content=png())
        Base.metadata.create_all(self.engine)
        uploads = self.root / "uploads"; uploads.mkdir()
        service = BackupService(self.database, uploads, self.root / "backups", enabled=False)
        archive = service.archive_path(service.create("manual")["name"])
        verify_backup(archive, extract_to=self.root / "verified")
        copied = create_engine("sqlite:///" + (self.root / "verified" / "database.sqlite3").as_posix())
        try:
            with copied.connect() as connection:
                from sqlalchemy import text
                self.assertEqual(connection.execute(text("SELECT COUNT(*) FROM users")).scalar(), 2)
                self.assertEqual(connection.execute(text("SELECT name FROM lumaball_profiles WHERE id=:id"), {"id": guest["identity"]["id"]}).scalar(), guest["identity"]["name"])
                self.assertEqual(connection.execute(text("SELECT COUNT(*) FROM branding_assets WHERE key='lumaball'")).scalar(), 1)
                self.assertIn("Saved setting", connection.execute(text("SELECT value_json FROM lumaball_settings")).scalar())
        finally:
            copied.dispose()


if __name__ == "__main__":
    unittest.main()
