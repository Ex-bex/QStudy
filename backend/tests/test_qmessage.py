"""Real HTTP and isolated SQLite messaging: privacy, retries, recovery and moderation."""
import io
import json
import os
import tempfile
import time
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

os.environ.setdefault("SECRET_KEY", "qmessage-isolated-test-secret-over-thirty-two-characters")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image, PngImagePlugin
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.auth import create_access_token
from app.database import Base, get_db
from app.models import StudentGroup, User
from app.operational_models import AuditLog
from app.qmessage_models import (QMessageAttachment, QMessageConversation, QMessageEvent, QMessageMember,
                                QMessageMessage, QMessageReport)
from app.routers import admin, qmessage
from app.services.qmessage import initialize_qmessage


def image_bytes(image_format="PNG"):
    source = Image.new("RGB", (64, 48), (100, 40, 220))
    metadata = PngImagePlugin.PngInfo(); metadata.add_text("private", "PRIVATE_METADATA")
    output = io.BytesIO()
    source.save(output, image_format, **({"pnginfo": metadata} if image_format == "PNG" else {}))
    return output.getvalue()


class QMessageTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + str(Path(self.temporary.name) / "qmessage.db"),
            connect_args={"check_same_thread": False, "timeout": 15})

        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")

        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False, autoflush=False)
        with self.sessions() as db:
            group = StudentGroup(name="ИП-26-3кс")
            db.add(group); db.flush()
            rows = [User(email=f"PRIVATE-{index}@example.com", name=name, role=role, hashed_password="PRIVATE_HASH", group_id=group.id)
                    for index, (name, role) in enumerate((("Айдана", "student"), ("ӘЛІБЕК", "student"), ("Admin", "admin"), ("Unrelated", "student")))]
            db.add_all(rows); db.commit()
            self.owner, self.other, self.admin, self.stranger = [row.id for row in rows]
            initialize_qmessage(db)
        self.app = FastAPI(); self.app.include_router(qmessage.router, prefix="/api"); self.app.include_router(admin.router, prefix="/api")

        def database():
            with self.sessions() as db:
                yield db

        self.app.dependency_overrides[get_db] = database
        self.client = TestClient(self.app, raise_server_exceptions=False)

    def tearDown(self):
        self.client.close(); self.engine.dispose(); self.temporary.cleanup()

    def request(self, method, path, *, user=None, **kwargs):
        headers = {"Authorization": "Bearer " + create_access_token(user or self.owner)}
        return self.client.request(method, "/api" + path, headers=headers, **kwargs)

    def conversation(self, *, user=None, peer=None):
        result = self.request("POST", "/qmessage/conversations", user=user, json={"user_id": peer or self.other})
        self.assertIn(result.status_code, (200, 201), result.text)
        return result.json()

    def send(self, conversation_id, *, user=None, text="Привет", client_id=None, **fields):
        return self.request("POST", f"/qmessage/conversations/{conversation_id}/messages", user=user,
            json={"client_id": client_id or str(uuid4()), "text": text, **fields})

    def test_only_common_authenticated_active_users_can_chat_and_directory_omits_emails(self):
        self.assertEqual(self.client.get("/api/qmessage/conversations").status_code, 401)
        self.assertEqual(self.request("GET", "/qmessage/users?q=әлі").json()["items"][0]["id"], self.other)
        response = self.request("GET", "/qmessage/users?q=ИП-26")
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("PRIVATE", response.text)
        self.assertNotIn("email", response.text)
        self.assertEqual(self.request("GET", "/qmessage/users?q=а").json(), {"items": []})
        with self.sessions() as db:
            db.get(User, self.other).is_active = False; db.commit()
        self.assertEqual(self.request("GET", "/qmessage/users?q=әлі").json()["items"], [])
        self.assertEqual(self.request("POST", "/qmessage/conversations", json={"user_id": self.other}).status_code, 404)

    def test_conversation_pair_and_message_retry_are_unique_under_concurrent_requests(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _index: self.conversation(), range(2)))
        self.assertEqual(responses[0]["id"], responses[1]["id"])
        conversation_id = responses[0]["id"]
        reverse = self.conversation(user=self.other, peer=self.owner)
        self.assertEqual(reverse["id"], conversation_id)
        identity = str(uuid4())
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _index: self.send(conversation_id, client_id=identity), range(2)))
        self.assertEqual(sorted(result.status_code for result in responses), [200, 201], [result.text for result in responses])
        self.assertEqual(responses[0].json()["id"], responses[1].json()["id"])
        self.assertEqual(self.send(conversation_id, text="different", client_id=identity).status_code, 409)
        with self.sessions() as db:
            self.assertEqual(db.query(QMessageConversation).count(), 1)
            self.assertEqual(db.query(QMessageMember).count(), 2)
            self.assertEqual(db.query(QMessageMessage).count(), 1)
            self.assertEqual(db.query(QMessageEvent).filter_by(type="message.created").count(), 2)

    def test_nonmembers_including_admin_cannot_access_messages_or_mutations(self):
        conversation = self.conversation()
        message = self.send(conversation["id"]).json()
        for user_id in (self.stranger, self.admin):
            for method, path, data in (("GET", f'/qmessage/conversations/{conversation["id"]}/messages', None),
                ("POST", f'/qmessage/conversations/{conversation["id"]}/messages', {"text": "probe", "client_id": str(uuid4())}),
                ("PATCH", f'/qmessage/messages/{message["id"]}', {"text": "probe"}),
                ("DELETE", f'/qmessage/messages/{message["id"]}', None),
                ("PUT", f'/qmessage/messages/{message["id"]}/reaction', {"emoji": "👍"}),
                ("POST", f'/qmessage/messages/{message["id"]}/report', {"reason": "probe"})):
                result = self.request(method, path, user=user_id, **({"json": data} if data is not None else {}))
                self.assertEqual(result.status_code, 404, (user_id, path, result.text))
        self.assertEqual(self.request("PATCH", f'/qmessage/messages/{message["id"]}', user=self.other, json={"text": "not mine"}).status_code, 403)

    def test_history_read_reactions_reply_edit_and_deletion_clear_all_visible_copies(self):
        conversation = self.conversation(); identifier = conversation["id"]
        sent = self.send(identifier, text="PRIVATE_ORIGINAL").json()
        reply = self.send(identifier, user=self.other, text="Reply", reply_to_id=sent["id"]).json()
        self.assertEqual(reply["reply_to"]["text"], "PRIVATE_ORIGINAL")
        before = self.request("GET", "/qmessage/conversations").json()["items"][0]
        self.assertEqual(before["unread_count"], 1)
        self.assertEqual(self.request("POST", f"/qmessage/conversations/{identifier}/read", json={"message_id": reply["id"]}).status_code, 200)
        self.assertEqual(self.request("POST", f"/qmessage/conversations/{identifier}/read", json={"message_id": sent["id"]}).json()["read_message_id"], reply["id"])
        reacted = self.request("PUT", f'/qmessage/messages/{sent["id"]}/reaction', user=self.other, json={"emoji": "👍"})
        self.assertEqual(reacted.json()["reactions"], [{"emoji": "👍", "count": 1, "user_ids": [self.other]}])
        edited = self.request("PATCH", f'/qmessage/messages/{sent["id"]}', json={"text": "PRIVATE_EDITED"})
        self.assertEqual(edited.status_code, 200)
        self.assertTrue(edited.json()["edited_at"])
        self.assertEqual(self.request("DELETE", f'/qmessage/messages/{sent["id"]}').status_code, 200)
        history = self.request("GET", f"/qmessage/conversations/{identifier}/messages").json()["items"]
        self.assertTrue(history[0]["deleted"])
        self.assertEqual(history[0]["text"], "")
        self.assertEqual(history[0]["reactions"], [])
        self.assertTrue(history[1]["reply_to"]["deleted"])
        self.assertEqual(history[1]["reply_to"]["text"], "")
        self.assertNotIn("PRIVATE_", json.dumps(history))
        with self.sessions() as db:
            self.assertEqual(db.get(QMessageMessage, sent["id"]).text, "")
            self.assertEqual(db.get(QMessageMessage, sent["id"]).fingerprint, "")
            self.assertEqual(db.query(QMessageEvent).filter(QMessageEvent.type.contains("PRIVATE")).count(), 0)

    def test_unicode_search_pagination_and_reply_cannot_cross_conversations(self):
        first = self.conversation()["id"]
        second = self.conversation(peer=self.stranger)["id"]
        messages = [self.send(first, text="ӘЛІБЕК " + str(index)).json() for index in range(4)]
        result = self.request("GET", f"/qmessage/conversations/{first}/messages?limit=2&q=әлібек").json()
        self.assertTrue(result["has_more"])
        self.assertEqual([item["id"] for item in result["items"]], [item["id"] for item in messages[2:]])
        older = self.request("GET", f'/qmessage/conversations/{first}/messages?limit=2&before={messages[2]["id"]}').json()
        self.assertFalse(older["has_more"])
        self.assertEqual([item["id"] for item in older["items"]], [item["id"] for item in messages[:2]])
        self.assertEqual(self.send(second, reply_to_id=messages[0]["id"]).status_code, 404)
        self.assertEqual(self.request("POST", f"/qmessage/conversations/{second}/read", json={"message_id": messages[0]["id"]}).status_code, 404)

    def test_blocking_bans_and_disabled_service_prevent_send_but_preserve_history_and_admin_controls(self):
        identifier = self.conversation()["id"]
        sent = self.send(identifier).json()
        self.assertEqual(self.request("PUT", f"/qmessage/users/{self.owner}/block", user=self.other, json={"blocked": True}).status_code, 200)
        self.assertEqual(self.send(identifier).status_code, 403)
        self.assertEqual(self.send(identifier, user=self.other).status_code, 403)
        self.assertEqual(self.request("GET", f"/qmessage/conversations/{identifier}/messages").status_code, 200)
        self.request("PUT", f"/qmessage/users/{self.owner}/block", user=self.other, json={"blocked": False})
        banned = self.request("PATCH", f"/admin/qmessage/users/{self.owner}/ban", user=self.admin, json={"banned": True, "reason": "moderation"})
        self.assertEqual(banned.status_code, 200, banned.text)
        self.assertEqual(self.send(identifier).status_code, 403)
        self.assertTrue(self.request("GET", "/qmessage/conversations").json()["account"]["banned"])
        self.assertEqual(self.request("DELETE", f'/qmessage/messages/{sent["id"]}').status_code, 200)
        self.request("PATCH", f"/admin/qmessage/users/{self.owner}/ban", user=self.admin, json={"banned": False})
        self.assertEqual(self.send(identifier).status_code, 201)
        self.request("PATCH", "/admin/qmessage/settings", user=self.admin, json={"enabled": False})
        self.assertEqual(self.send(identifier).status_code, 503)
        self.assertEqual(self.request("GET", "/admin/qmessage/overview", user=self.admin).status_code, 200)
        self.assertEqual(self.request("PATCH", "/admin/qmessage/settings", user=self.admin, json={"enabled": True}).status_code, 200)

    def test_events_are_private_durable_and_revalidate_revocation_during_long_poll(self):
        identifier = self.conversation()["id"]
        baseline = self.request("GET", "/qmessage/conversations", user=self.other).json()["cursor"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(self.request, "GET", f"/qmessage/events?after={baseline}&wait=3", user=self.other)
            time.sleep(0.15)
            sent = self.send(identifier).json()
            woke = waiting.result(timeout=5)
        self.assertEqual(woke.status_code, 200, woke.text)
        self.assertEqual(woke.json()["items"][0]["message_id"], sent["id"])
        self.assertNotIn("text", woke.json()["items"][0])
        self.assertEqual(self.request("GET", "/qmessage/events?wait=0", user=self.stranger).json()["items"], [])
        self.engine.dispose()
        replay = self.request("GET", f"/qmessage/events?after={baseline}&wait=0", user=self.other)
        self.assertEqual(replay.json()["items"], woke.json()["items"])
        current = replay.json()["cursor"]
        with ThreadPoolExecutor(max_workers=1) as pool:
            waiting = pool.submit(self.request, "GET", f"/qmessage/events?after={current}&wait=3", user=self.other)
            time.sleep(0.15)
            with self.sessions() as db:
                db.get(User, self.other).token_version += 1; db.commit()
            revoked = waiting.result(timeout=5)
        self.assertEqual(revoked.status_code, 401, revoked.text)

    def test_typing_expires_and_block_removes_peer_typing(self):
        identifier = self.conversation()["id"]
        self.assertEqual(self.request("POST", f"/qmessage/conversations/{identifier}/typing", json={"typing": True}).status_code, 200)
        self.assertTrue(self.request("GET", f"/qmessage/conversations/{identifier}/typing", user=self.other).json()["typing"])
        self.request("PUT", f"/qmessage/users/{self.owner}/block", user=self.other, json={"blocked": True})
        self.assertFalse(self.request("GET", f"/qmessage/conversations/{identifier}/typing", user=self.other).json()["typing"])

    def test_private_images_are_normalized_and_only_shared_once_sent_and_deleted_with_message(self):
        identifier = self.conversation()["id"]
        uploaded = self.request("POST", f"/qmessage/conversations/{identifier}/attachments",
            files={"file": ("PRIVATE_NAME.png", image_bytes(), "image/png")})
        self.assertEqual(uploaded.status_code, 201, uploaded.text)
        attachment = uploaded.json()
        path = attachment["url"].removeprefix("/api")
        for outsider in (self.other, self.stranger, self.admin):
            self.assertEqual(self.request("GET", path, user=outsider).status_code, 404)
        sent = self.send(identifier, text="", attachment_id=attachment["id"]).json()
        picture = self.request("GET", path, user=self.other)
        self.assertEqual(picture.status_code, 200)
        self.assertEqual(picture.headers["cache-control"], "private, no-store")
        self.assertNotIn(b"PRIVATE_METADATA", picture.content)
        with Image.open(io.BytesIO(picture.content)) as clean:
            self.assertEqual(clean.info, {})
            self.assertEqual(clean.format, "PNG")
        self.assertEqual(self.send(identifier, attachment_id=attachment["id"]).status_code, 404)
        self.request("DELETE", f'/qmessage/messages/{sent["id"]}')
        self.assertEqual(self.request("GET", path).status_code, 404)
        with self.sessions() as db:
            self.assertIsNone(db.get(QMessageAttachment, attachment["id"]))

    def test_reports_grant_only_reported_content_and_audit_never_copies_private_text(self):
        identifier = self.conversation()["id"]
        original = self.send(identifier, text="PRIVATE_UNREPORTED").json()
        reported = self.send(identifier, text="PRIVATE_REPORTED", reply_to_id=original["id"]).json()
        report = self.request("POST", f'/qmessage/messages/{reported["id"]}/report', user=self.other, json={"reason": "PRIVATE_REASON"})
        self.assertEqual(report.status_code, 201)
        self.assertEqual(self.request("GET", "/admin/qmessage/reports").status_code, 403)
        response = self.request("GET", "/admin/qmessage/reports", user=self.admin)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("PRIVATE_UNREPORTED", response.text)
        self.assertEqual(response.json()["items"][0]["message"]["text"], "PRIVATE_REPORTED")
        self.assertIsNone(response.json()["items"][0]["message"]["reply_to"])
        resolved = self.request("POST", f'/admin/qmessage/reports/{report.json()["id"]}/resolve', user=self.admin, json={"delete_message": True})
        self.assertEqual(resolved.status_code, 200, resolved.text)
        self.assertEqual(self.request("GET", "/admin/qmessage/reports?status=all", user=self.admin).json()["items"][0]["message"]["text"], "")
        with self.sessions() as db:
            audit = db.query(AuditLog).all()
            self.assertTrue(audit)
            self.assertTrue(all("PRIVATE" not in row.metadata_json + row.fields_json for row in audit))

    def test_reported_photo_is_scoped_to_the_report_and_becomes_unavailable_after_deletion(self):
        identifier = self.conversation()["id"]
        uploaded = self.request("POST", f"/qmessage/conversations/{identifier}/attachments",
            files={"file": ("photo.jpg", image_bytes("JPEG"), "image/jpeg")}).json()
        sent = self.send(identifier, text="", attachment_id=uploaded["id"]).json()
        report = self.request("POST", f'/qmessage/messages/{sent["id"]}/report', user=self.other, json={"reason": "reported image"}).json()
        reported = self.request("GET", "/admin/qmessage/reports", user=self.admin).json()["items"][0]
        url = reported["message"]["attachment"]["url"].removeprefix("/api")
        self.assertEqual(url, f'/admin/qmessage/reports/{report["id"]}/attachment')
        self.assertEqual(self.request("GET", url, user=self.admin).status_code, 200)
        self.assertEqual(self.request("GET", url, user=self.other).status_code, 403)
        self.assertEqual(self.request("GET", uploaded["url"].removeprefix("/api"), user=self.admin).status_code, 404)
        self.request("POST", f'/admin/qmessage/reports/{report["id"]}/resolve', user=self.admin, json={"delete_message": True})
        self.assertEqual(self.request("GET", url, user=self.admin).status_code, 404)
        self.assertEqual(self.request("GET", uploaded["url"].removeprefix("/api")).status_code, 404)

    def test_invalid_images_never_persist_and_unused_drafts_can_be_removed(self):
        identifier = self.conversation()["id"]
        for content, expected in ((b"<svg><script/></svg>", 422), (b"x" * (6 * 1024 * 1024 + 1), 413)):
            result = self.request("POST", f"/qmessage/conversations/{identifier}/attachments",
                files={"file": ("image.png", content, "image/png")})
            self.assertEqual(result.status_code, expected, result.text)
        with self.sessions() as db:
            self.assertEqual(db.query(QMessageAttachment).count(), 0)
        draft = self.request("POST", f"/qmessage/conversations/{identifier}/attachments",
            files={"file": ("draft.webp", image_bytes("WEBP"), "image/webp")}).json()
        self.assertEqual(self.request("DELETE", draft["url"].removeprefix("/api"), user=self.other).status_code, 404)
        self.assertEqual(self.request("DELETE", draft["url"].removeprefix("/api")).status_code, 200)
        self.assertEqual(self.request("GET", draft["url"].removeprefix("/api")).status_code, 404)

    def test_admin_audit_failure_rolls_back_ban_and_report_moderation_atomically(self):
        identifier = self.conversation()["id"]
        sent = self.send(identifier, text="KEEP_ME").json()
        report = self.request("POST", f'/qmessage/messages/{sent["id"]}/report', user=self.other, json={"reason": "reason"}).json()
        with patch("app.routers.qmessage.record_audit", side_effect=RuntimeError("audit unavailable")):
            ban = self.request("PATCH", f"/admin/qmessage/users/{self.owner}/ban", user=self.admin, json={"banned": True})
            self.assertEqual(ban.status_code, 500)
            resolve = self.request("POST", f'/admin/qmessage/reports/{report["id"]}/resolve', user=self.admin, json={"delete_message": True})
            self.assertEqual(resolve.status_code, 500)
        self.assertFalse(self.request("GET", "/qmessage/conversations").json()["account"]["banned"])
        history = self.request("GET", f"/qmessage/conversations/{identifier}/messages").json()["items"]
        self.assertEqual(history[0]["text"], "KEEP_ME")
        with self.sessions() as db:
            self.assertEqual(db.get(QMessageReport, report["id"]).status, "open")

    def test_long_poll_releases_connection_before_each_wait_and_handles_restored_cursor(self):
        identifier = self.conversation()["id"]
        current = self.request("GET", "/qmessage/conversations").json()["cursor"]
        original_sleep = qmessage.asyncio.sleep
        waits = []

        async def check_sleep(duration):
            waits.append(self.engine.pool.checkedout())
            await original_sleep(duration)

        with patch.object(qmessage.asyncio, "sleep", new=check_sleep):
            response = self.request("GET", f"/qmessage/events?after={current}&wait=1")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(waits)
        self.assertEqual(waits, [0] * len(waits))
        future = self.request("GET", "/qmessage/events?after=999999&wait=0").json()
        self.assertTrue(future["reset"])
        self.assertTrue(future["items"])

    def test_stickers_are_seeded_once_and_admin_can_disable_without_breaking_old_messages(self):
        self.assertEqual(len(self.request("GET", "/qmessage/stickers").json()["items"]), 8)
        identifier = self.conversation()["id"]
        sent = self.send(identifier, text="", sticker_id="wave")
        self.assertEqual(sent.status_code, 201, sent.text)
        self.assertEqual(sent.json()["sticker"]["image_url"], "/qmessage-stickers/wave.svg")
        self.assertEqual(self.request("DELETE", "/admin/qmessage/stickers/wave", user=self.admin).status_code, 200)
        with self.sessions() as db:
            initialize_qmessage(db)
        self.assertEqual(len(self.request("GET", "/qmessage/stickers").json()["items"]), 7)
        self.assertEqual(self.send(identifier, text="", sticker_id="wave").status_code, 422)
        old = self.request("GET", f"/qmessage/conversations/{identifier}/messages").json()["items"][0]
        self.assertEqual(old["sticker_id"], "wave")
        self.assertFalse(old["sticker"]["active"])

    def test_real_account_deletion_cascades_without_touching_other_accounts_or_leaving_fks(self):
        identifier = self.conversation()["id"]
        first = self.send(identifier).json()
        self.send(identifier, user=self.other, reply_to_id=first["id"])
        self.request("POST", f'/qmessage/messages/{first["id"]}/report', user=self.other, json={"reason": "reason"})
        self.request("PUT", f"/qmessage/users/{self.owner}/block", user=self.other, json={"blocked": True})
        result = self.request("DELETE", f"/admin/users/{self.owner}", user=self.admin)
        self.assertEqual(result.status_code, 200, result.text)
        with self.sessions() as db:
            self.assertEqual(db.query(QMessageConversation).count(), 0)
            self.assertEqual(db.query(QMessageMessage).count(), 0)
            self.assertEqual(db.query(QMessageReport).count(), 0)
            self.assertEqual(db.query(User).count(), 3)
            self.assertEqual(db.execute(__import__("sqlalchemy").text("PRAGMA foreign_key_check")).all(), [])


if __name__ == "__main__":
    unittest.main()
