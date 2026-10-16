"""Room access, capacity, administrator controls and durable result regressions."""
import json
import os
from pathlib import Path
import tempfile
import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI, HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import sessionmaker
from starlette.requests import Request

from app.auth import create_access_token
from app.config import settings
from app.database import Base, get_db
from app.lumaball_models import LumaBallProfile
from app.lumaball_room_models import LumaBallChatMessage, LumaBallMatch, LumaBallRoom, LumaBallRoomMember
from app.models import User
from app.operational_models import AuditLog
from app.routers import lumaball_identity, lumaball_rooms
from app.services import lumaball_rooms as service
from app.services.lumaball_identity import resolve_identity


class LumaBallRoomTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.engine = create_engine("sqlite:///" + (Path(self.temporary.name) / "game.sqlite3").as_posix(), connect_args={"check_same_thread": False})
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
        self.admin_headers = {"Authorization": "Bearer " + create_access_token(self.admin_id)}
        self.student_headers = {"Authorization": "Bearer " + create_access_token(self.student_id)}
        self.app = FastAPI()
        self.app.include_router(lumaball_identity.router, prefix="/api")
        self.app.include_router(lumaball_rooms.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_db] = database
        self.client = TestClient(self.app, raise_server_exceptions=False)
        self.hub = AsyncMock()
        self.hub_patch = patch("app.routers.lumaball_rooms._hub", return_value=self.hub)
        self.hub_patch.start()
        self.limits = patch.object(settings, "RATE_LIMIT_ENABLED", False)
        self.limits.start()

    def tearDown(self):
        self.client.close()
        self.hub_patch.stop()
        self.limits.stop()
        self.engine.dispose()
        self.temporary.cleanup()

    def guest(self):
        response = self.client.post("/api/lumaball/session")
        self.assertEqual(response.status_code, 200, response.text)
        values = response.json()
        return {"X-LumaBall-Session": values["guest_token"]}, values["identity"]

    def create(self, headers, **changes):
        response = self.client.post("/api/lumaball/rooms", headers=headers, json={"name": "Матч", **changes})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def join(self, room, headers, password=""):
        return self.client.post("/api/lumaball/rooms/" + room["id"] + "/join", headers=headers, json={"password": password})

    def command(self, room, action, **values):
        return self.client.post("/api/admin/lumaball/rooms/" + room["id"] + "/command",
                                headers=self.admin_headers, json={"action": action, **values})

    def connected_room(self):
        host_headers, host = self.guest()
        other_headers, other = self.guest()
        room = self.create(host_headers, max_players=4, score_limit=5, time_limit=5)
        self.assertEqual(self.join(room, other_headers).status_code, 200)
        with self.sessions() as db:
            db.query(LumaBallRoomMember).filter_by(room_id=room["id"]).update({"connected": True}); db.commit()
        return room, host_headers, host, other_headers, other

    def test_public_room_listing_is_bounded_and_never_exposes_password_chat_or_roster(self):
        headers, host = self.guest()
        room = self.create(headers, password="PRIVATE_ROOM_PASSWORD")
        with self.sessions() as db:
            db.add(LumaBallChatMessage(room_id=room["id"], profile_id=host["id"], name=host["name"], text="PRIVATE_CHAT")); db.commit()
        response = self.client.get("/api/lumaball/rooms")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["total"], 1)
        listed = response.json()["items"][0]
        self.assertTrue(listed["locked"])
        self.assertNotIn("members", listed)
        self.assertNotIn("chat", listed)
        for private in ("PRIVATE_ROOM_PASSWORD", "PRIVATE_CHAT", "private-admin", "PRIVATE_HASH", "pbkdf2"):
            self.assertNotIn(private, response.text)
        self.assertEqual(self.client.get("/api/lumaball/rooms", params={"q": "%"}).json()["total"], 0)

    def test_create_requires_identity_and_valid_server_limits(self):
        self.assertEqual(self.client.post("/api/lumaball/rooms", json={"name": "x"}).status_code, 401)
        headers, _ = self.guest()
        for changes in [{"max_players": 1}, {"max_players": 21}, {"score_limit": -1}, {"time_limit": -1}, {"score_limit": 21}, {"time_limit": 31},
                        {"max_players": "4"}, {"name": " "}, {"host_id": "a" * 32}]:
            response = self.client.post("/api/lumaball/rooms", headers=headers, json={"name": "Поле", **changes})
            self.assertEqual(response.status_code, 422, response.text)
        self.client.patch("/api/admin/lumaball/settings", headers=self.admin_headers, json={"max_players": 4})
        self.assertEqual(self.client.post("/api/lumaball/rooms", headers=headers, json={"name": "Поле", "max_players": 5}).status_code, 422)

    def test_map_presets_and_sizes_are_persisted_and_listed_with_legacy_defaults(self):
        headers, _ = self.guest()
        room = self.create(headers)
        self.assertEqual((room["map_id"], room["map_width"], room["map_height"]), ("classic", 10, 5))
        for map_id in ("hockey", "arena"):
            headers, _ = self.guest()
            room = self.create(headers, map_id=map_id, map_width=30, map_height=15)
            with self.sessions() as db:
                saved = db.get(LumaBallRoom, room["id"])
                self.assertEqual((saved.map_id, saved.map_width, saved.map_height), (map_id, 30, 15))
            listed = next(item for item in self.client.get("/api/lumaball/rooms").json()["items"] if item["id"] == room["id"])
            self.assertEqual((listed["map_id"], listed["map_width"], listed["map_height"]), (map_id, 30, 15))

    def test_invalid_map_settings_are_rejected_before_room_creation(self):
        headers, _ = self.guest()
        for changes in ({"map_id": "custom"}, {"map_id": None}, {"map_width": 9}, {"map_width": 31},
                        {"map_width": "10"}, {"map_width": True}, {"map_height": 4}, {"map_height": 16},
                        {"map_height": 5.5}, {"map_height": None}):
            response = self.client.post("/api/lumaball/rooms", headers=headers, json={"name": "Поле", **changes})
            self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.client.get("/api/lumaball/rooms").json()["total"], 0)

    def test_guest_host_can_edit_own_map_and_rules_and_changes_are_published(self):
        headers, _ = self.guest()
        room = self.create(headers, password="old-secret")
        url = "/api/lumaball/rooms/" + room["id"]
        response = self.client.patch(url, headers=headers, json={"name": "Хоккей", "password": "", "map_id": "hockey",
            "map_width": 18, "map_height": 9, "max_players": 6, "score_limit": 3, "time_limit": 10})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["is_member"])
        self.assertEqual((response.json()["map_id"], response.json()["map_width"], response.json()["map_height"]), ("hockey", 18, 9))
        self.assertFalse(response.json()["locked"])
        self.hub.publish_room.assert_awaited_with(room["id"])
        with self.sessions() as db:
            self.assertEqual(db.get(LumaBallRoom, room["id"]).map_id, "hockey")
            self.assertEqual(db.query(AuditLog).count(), 0)

    def test_nonhost_cannot_edit_maps_and_host_cannot_change_active_map(self):
        room, host_headers, _, other_headers, _ = self.connected_room()
        url = "/api/lumaball/rooms/" + room["id"]
        self.assertEqual(self.client.patch(url, json={"map_id": "arena"}).status_code, 401)
        self.assertEqual(self.client.patch(url, headers=other_headers, json={"map_id": "arena"}).status_code, 403)
        self.assertEqual(self.client.patch(url, headers=self.student_headers, json={"map_id": "arena"}).status_code, 403)
        self.assertEqual(self.command(room, "start").status_code, 200)
        for headers in (host_headers, self.admin_headers):
            for values in ({"map_id": "hockey"}, {"map_width": 20}, {"map_height": 10}, {"score_limit": 2}):
                self.assertEqual(self.client.patch(url, headers=headers, json=values).status_code, 409)
        self.assertEqual(self.command(room, "pause").status_code, 200)
        self.assertEqual(self.client.patch(url, headers=host_headers, json={"map_id": "arena"}).status_code, 409)
        self.assertEqual(self.command(room, "stop").status_code, 200)
        self.assertEqual(self.client.patch(url, headers=host_headers, json={"map_id": "arena"}).status_code, 200)

    def test_admin_and_signed_in_host_share_map_validation_and_safe_audit(self):
        room = self.create(self.student_headers)
        url = "/api/lumaball/rooms/" + room["id"]
        self.assertEqual(self.client.patch(url, headers=self.student_headers, json={"map_id": "hockey", "password": "private-room-secret"}).status_code, 200)
        admin_url = "/api/admin/lumaball/rooms/" + room["id"]
        self.assertEqual(self.client.patch(admin_url, headers=self.admin_headers, json={"map_id": "arena", "map_width": 30, "map_height": 15}).status_code, 200)
        for values in ({"map_id": "forged"}, {"map_width": 9}, {"map_height": None}, {"host_id": "a" * 32}):
            self.assertEqual(self.client.patch(admin_url, headers=self.admin_headers, json=values).status_code, 422)
        with self.sessions() as db:
            events = db.query(AuditLog).filter_by(action="lumaball.room.update").order_by(AuditLog.id).all()
            self.assertEqual([event.actor_id for event in events], [self.student_id, self.admin_id])
            self.assertNotIn("private-room-secret", "".join(event.fields_json + event.metadata_json for event in events))
            self.assertNotIn("password", events[0].fields_json)

    def test_additive_map_schema_upgrade_preserves_existing_room_and_accounts(self):
        from app import main
        headers, _ = self.guest()
        room = self.create(headers, password="legacy-secret")
        with self.sessions() as db:
            before_hash = db.get(LumaBallRoom, room["id"]).password_hash
            profiles_before = db.query(LumaBallProfile).count()
        with self.engine.begin() as connection:
            for name in ("map_id", "map_width", "map_height"):
                connection.execute(text('ALTER TABLE lumaball_rooms DROP COLUMN "' + name + '"'))
        with patch.object(main, "engine", self.engine), patch.object(main, "SessionLocal", self.sessions), \
                patch("app.services.syllabus.seed_academic_defaults"), patch("app.services.reference_curriculum.seed_sourced_curriculum"), \
                patch("app.services.reference_timetable.seed_sourced_timetable"), patch("app.services.developers.seed_developer_departments"):
            main.initialize_database()
            main.initialize_database()
        with self.sessions() as db:
            saved = db.get(LumaBallRoom, room["id"])
            self.assertEqual((saved.map_id, saved.map_width, saved.map_height), ("classic", 10, 5))
            self.assertEqual(saved.password_hash, before_hash)
            self.assertEqual(db.query(LumaBallProfile).count(), profiles_before)
            self.assertEqual(db.query(User).count(), 2)
        self.assertTrue({"map_id", "map_width", "map_height"} <= {column["name"] for column in inspect(self.engine).get_columns("lumaball_rooms")})

    def test_guest_creation_and_max_room_limits_are_applied_by_server(self):
        first, _ = self.guest(); second, _ = self.guest()
        self.client.patch("/api/admin/lumaball/settings", headers=self.admin_headers, json={"guest_create_rooms": False})
        self.assertEqual(self.client.post("/api/lumaball/rooms", headers=first, json={"name": "Поле"}).status_code, 403)
        self.client.patch("/api/admin/lumaball/settings", headers=self.admin_headers, json={"guest_create_rooms": True, "max_rooms": 1})
        self.create(first)
        self.assertEqual(self.client.post("/api/lumaball/rooms", headers=second, json={"name": "Поле"}).status_code, 409)

    def test_locked_room_direct_link_shows_only_summary_until_successful_join(self):
        host_headers, host = self.guest(); other_headers, _ = self.guest()
        room = self.create(host_headers, password="room-secret")
        with self.sessions() as db:
            db.add(LumaBallChatMessage(room_id=room["id"], profile_id=host["id"], name=host["name"], text="PRIVATE_CHAT")); db.commit()
        detail = self.client.get("/api/lumaball/rooms/" + room["id"], headers=other_headers)
        self.assertEqual(detail.status_code, 200)
        self.assertFalse(detail.json()["is_member"])
        self.assertEqual(detail.json()["members"], [])
        self.assertEqual(detail.json()["chat"], [])
        self.assertEqual(self.join(room, other_headers, "wrong").status_code, 403)
        self.assertEqual(self.join(room, other_headers, "room-secret").status_code, 200)
        detail = self.client.get("/api/lumaball/rooms/" + room["id"], headers=other_headers)
        self.assertTrue(detail.json()["is_member"])
        self.assertEqual(len(detail.json()["members"]), 2)
        self.assertEqual(detail.json()["chat"][0]["text"], "PRIVATE_CHAT")
        admin_detail = self.client.get("/api/lumaball/rooms/" + room["id"], headers=self.admin_headers)
        self.assertEqual(len(admin_detail.json()["members"]), 2)
        self.assertNotIn("password_hash", admin_detail.json())

    def test_capacity_repeated_join_and_single_active_room_are_enforced(self):
        host_headers, _ = self.guest(); second_headers, _ = self.guest(); third_headers, _ = self.guest()
        room = self.create(host_headers, max_players=2)
        self.assertEqual(self.join(room, second_headers).status_code, 200)
        self.assertEqual(self.join(room, second_headers).status_code, 200)
        self.assertEqual(self.join(room, third_headers).status_code, 409)
        with self.sessions() as db:
            self.assertEqual(db.query(LumaBallRoomMember).filter_by(room_id=room["id"]).count(), 2)
        other = self.create(third_headers)
        self.assertEqual(self.join(other, second_headers).status_code, 409)
        self.assertEqual(self.client.post("/api/lumaball/rooms", headers=host_headers, json={"name": "Еще"}).status_code, 409)

    def test_nonhost_leaving_keeps_room_and_host_leaving_closes_it(self):
        room, host_headers, host, other_headers, other = self.connected_room()
        response = self.client.post("/api/lumaball/rooms/" + room["id"] + "/leave", headers=other_headers)
        self.assertEqual(response.status_code, 200)
        self.hub.disconnect_profile.assert_awaited_with(other["id"], "left_room")
        self.assertEqual(self.client.get("/api/lumaball/rooms").json()["total"], 1)
        self.assertEqual(self.client.post("/api/lumaball/rooms/" + room["id"] + "/leave", headers=host_headers).status_code, 200)
        self.assertEqual(self.client.get("/api/lumaball/rooms").json()["total"], 0)
        self.assertEqual(self.client.get("/api/lumaball/rooms/" + room["id"], headers=host_headers).status_code, 404)
        self.assertEqual(self.join(room, other_headers).status_code, 404)
        self.hub.close_room.assert_awaited_with(room["id"], "host_left")

    def test_all_admin_routes_reject_guests_and_students(self):
        guest_headers, _ = self.guest()
        room = self.create(guest_headers)
        routes = [("get", "/stats", {}), ("get", "/rooms", {}), ("get", "/matches", {}),
                  ("patch", "/rooms/" + room["id"], {"json": {"name": "Changed"}}),
                  ("delete", "/rooms/" + room["id"], {}),
                  ("post", "/rooms/" + room["id"] + "/command", {"json": {"action": "reset"}}),
                  ("delete", "/rooms/" + room["id"] + "/chat", {}),
                  ("delete", "/matches/" + "a" * 32, {})]
        for headers, expected in ((guest_headers, 401), (self.student_headers, 403)):
            for method, path, kwargs in routes:
                response = getattr(self.client, method)("/api/admin/lumaball" + path, headers=headers, **kwargs)
                self.assertEqual(response.status_code, expected, method + path)
        with self.sessions() as db:
            self.assertEqual(db.query(AuditLog).count(), 0)

    def test_admin_safe_room_edit_can_remove_password_and_audits_without_secrets(self):
        host_headers, _ = self.guest(); other_headers, _ = self.guest()
        room = self.create(host_headers, password="old-password")
        response = self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers,
                                     json={"name": "Новая арена", "password": "", "max_players": 6, "score_limit": 3, "time_limit": 4})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["locked"])
        self.assertEqual(self.join(room, other_headers).status_code, 200)
        with self.sessions() as db:
            event = db.query(AuditLog).filter_by(action="lumaball.room.update").one()
            self.assertNotIn("password", json.loads(event.fields_json))
            self.assertNotIn("Новая арена", event.fields_json + event.metadata_json)
        for values in [{"status": "playing"}, {"max_players": None}, {"score_limit": 21}, {"name": " "}, {}]:
            self.assertEqual(self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers, json=values).status_code, 422)

    def test_admin_cannot_reduce_capacity_below_occupancy_or_change_running_limits(self):
        room, host_headers, host, other_headers, other = self.connected_room()
        third_headers, _ = self.guest()
        self.assertEqual(self.join(room, third_headers).status_code, 200)
        self.assertEqual(self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers,
                                           json={"max_players": 2}).status_code, 409)
        self.assertEqual(self.command(room, "start").status_code, 200)
        for values in [{"time_limit": 2}, {"password": "new"}, {"score_limit": 7}, {"max_players": 4}]:
            self.assertEqual(self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers, json=values).status_code, 409)
        self.assertEqual(self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers,
                                           json={"name": "Переименовано"}).status_code, 200)

    def test_admin_commands_start_pause_resume_teams_kick_and_reset_are_published(self):
        room, host_headers, host, other_headers, other = self.connected_room()
        self.assertEqual(self.command(room, "start").json()["status"], "playing")
        self.assertEqual(self.command(room, "start").status_code, 409)
        self.assertEqual(self.command(room, "pause").json()["status"], "paused")
        self.assertEqual(self.command(room, "resume").json()["status"], "playing")
        self.assertEqual(self.command(room, "reset").json()["status"], "lobby")
        self.assertEqual(self.command(room, "team", target=other["id"], team="spectator").status_code, 200)
        self.assertEqual(self.command(room, "kick", target=host["id"]).status_code, 409)
        self.assertEqual(self.command(room, "kick", target=other["id"]).status_code, 200)
        self.hub.disconnect_profile.assert_awaited_with(other["id"], "kicked")
        self.hub.publish_room.assert_awaited_with(room["id"])
        with self.sessions() as db:
            actions = [event.action for event in db.query(AuditLog)]
            for action in ("start", "pause", "resume", "reset", "team", "kick"):
                self.assertIn("lumaball.room." + action, actions)

    def test_original_training_can_start_without_an_opponent_connection(self):
        room, host_headers, host, other_headers, other = self.connected_room()
        with self.sessions() as db:
            opponent = service.member(db, room["id"], other["id"])
            opponent.connected = False
            db.commit()
        response = self.command(room, "start")
        self.assertEqual(response.status_code, 200, response.text)
        with self.sessions() as db:
            record = db.get(LumaBallRoom, room["id"])
            self.assertEqual(record.status, "playing")
            self.assertIsNotNone(record.match_id)
            service.member(db, room["id"], other["id"]).connected = True
            db.commit()
        self.assertEqual(self.command(room, "start").status_code, 409)

    def test_original_training_can_start_with_connected_host_as_spectator(self):
        headers, host = self.guest()
        room = self.create(headers)
        self.assertEqual(self.command(room, "start").status_code, 409)
        with self.sessions() as db:
            member = service.member(db, room["id"], host["id"])
            member.connected, member.team = True, "spectator"
            db.commit()
        response = self.command(room, "start")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["status"], "playing")

    def test_new_rooms_support_original_twenty_player_capacity_and_unlimited_rules(self):
        headers, _ = self.guest()
        room = self.create(headers, max_players=20, score_limit=0, time_limit=0)
        self.assertEqual((room["max_players"], room["score_limit"], room["time_limit"]), (20, 0, 0))
        response = self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers,
                                     json={"score_limit": 5, "time_limit": 5})
        self.assertEqual(response.status_code, 200, response.text)
        response = self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers,
                                     json={"score_limit": 0, "time_limit": 0})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((response.json()["score_limit"], response.json()["time_limit"]), (0, 0))

    def test_unlimited_result_accepts_long_original_match_and_rejects_invalid_numbers(self):
        room, headers, host, _, _ = self.connected_room()
        response = self.client.patch("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers,
                                     json={"score_limit": 0, "time_limit": 0})
        self.assertEqual(response.status_code, 200, response.text)
        started = self.command(room, "start").json()
        with self.sessions() as db:
            identity = resolve_identity(Request({"type": "http", "headers": [(b"x-lumaball-session", headers["X-LumaBall-Session"].encode())]}), db)
            record = service.room_by_id(db, room["id"])
            payload = {"match_id": started["match_id"], "red": 27, "blue": 22, "duration_seconds": 7200}
            for changes in ({"red": -1}, {"blue": True}, {"red": 2**31}, {"duration_seconds": -1},
                            {"duration_seconds": 2**31}, {"duration_seconds": float("inf")}):
                with self.assertRaises(HTTPException):
                    service.save_result(db, record, identity, {**payload, **changes})
            result = service.save_result(db, record, identity, payload)
            self.assertEqual((result.red_score, result.blue_score, result.duration_seconds), (27, 22, 7200))

    def test_admin_chat_clear_is_scoped_and_logged_without_chat_contents(self):
        headers, host = self.guest(); second_headers, other = self.guest()
        room = self.create(headers); second = self.create(second_headers)
        with self.sessions() as db:
            db.add_all([LumaBallChatMessage(room_id=room["id"], profile_id=host["id"], name=host["name"], text="PRIVATE_FIRST"),
                        LumaBallChatMessage(room_id=second["id"], profile_id=other["id"], name=other["name"], text="PRIVATE_SECOND")]); db.commit()
        response = self.client.delete("/api/admin/lumaball/rooms/" + room["id"] + "/chat", headers=self.admin_headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["deleted"], 1)
        with self.sessions() as db:
            self.assertEqual(db.query(LumaBallChatMessage).one().text, "PRIVATE_SECOND")
            event = db.query(AuditLog).filter_by(action="lumaball.room.chat_clear").one()
            self.assertNotIn("PRIVATE", event.metadata_json)
            self.assertEqual(json.loads(event.metadata_json)["count"], 1)

    def test_results_require_host_valid_match_and_bounds_and_are_idempotent(self):
        room, host_headers, host, other_headers, other = self.connected_room()
        started = self.command(room, "start").json()
        with self.sessions() as db:
            host_identity = resolve_identity(Request({"type": "http", "headers": [(b"x-lumaball-session", host_headers["X-LumaBall-Session"].encode())]}), db)
            other_identity = resolve_identity(Request({"type": "http", "headers": [(b"x-lumaball-session", other_headers["X-LumaBall-Session"].encode())]}), db)
            record = service.room_by_id(db, room["id"])
            payload = {"match_id": started["match_id"], "red": 5, "blue": 2, "duration_seconds": 123}
            with self.assertRaises(HTTPException) as error:
                service.save_result(db, record, other_identity, payload)
            self.assertEqual(error.exception.status_code, 403)
            with self.assertRaises(HTTPException):
                service.save_result(db, record, host_identity, {**payload, "red": 100})
            result = service.save_result(db, record, host_identity, payload)
            self.assertEqual(result.id, service.save_result(db, record, host_identity, payload).id)
            self.assertEqual(db.query(LumaBallMatch).count(), 1)
        response = self.client.get("/api/lumaball/matches")
        self.assertEqual(response.status_code, 200)
        self.assertFalse(response.json()["items"][0]["verified"])
        self.assertEqual(response.json()["items"][0]["red_score"], 5)
        self.assertNotIn("PRIVATE_HASH", response.text)
        self.assertEqual(self.client.get("/api/admin/lumaball/stats", headers=self.admin_headers).json()["matches_total"], 1)
        self.assertEqual(self.client.delete("/api/admin/lumaball/matches/" + started["match_id"], headers=self.admin_headers).status_code, 200)
        self.assertEqual(self.client.get("/api/lumaball/matches").json()["total"], 0)

    def test_restart_closes_browser_owned_rooms_but_preserves_history_and_profiles(self):
        room, host_headers, host, other_headers, other = self.connected_room()
        self.command(room, "start")
        with self.sessions() as db:
            before = db.query(LumaBallProfile).count()
            service.initialize_rooms(db)
            self.assertEqual(db.get(LumaBallRoom, room["id"]).status, "closed")
            self.assertEqual(db.get(LumaBallRoom, room["id"]).closed_reason, "server_restarted")
            self.assertEqual(db.query(LumaBallProfile).count(), before)
            self.assertEqual(db.query(LumaBallRoomMember).filter_by(connected=True).count(), 0)

    def test_abandoned_host_reservation_expires_without_deleting_player(self):
        headers, host = self.guest()
        room = self.create(headers)
        with self.sessions() as db:
            db.query(LumaBallRoomMember).filter_by(room_id=room["id"]).update({"joined_at": datetime.utcnow() - timedelta(minutes=3)})
            service.expire_reservations(db); db.commit()
            self.assertEqual(db.get(LumaBallRoom, room["id"]).status, "closed")
            self.assertIsNotNone(db.get(LumaBallProfile, host["id"]))

    def test_admin_closes_room_idempotently_and_full_admin_list_contains_roster(self):
        headers, host = self.guest()
        room = self.create(headers)
        values = self.client.get("/api/admin/lumaball/rooms", headers=self.admin_headers).json()
        self.assertEqual(values["items"][0]["members"][0]["id"], host["id"])
        for _ in range(2):
            self.assertEqual(self.client.delete("/api/admin/lumaball/rooms/" + room["id"], headers=self.admin_headers).status_code, 200)
        self.assertEqual(self.client.get("/api/admin/lumaball/rooms", headers=self.admin_headers).json()["total"], 0)
        with self.sessions() as db:
            self.assertEqual(db.query(AuditLog).filter_by(action="lumaball.room.close").count(), 1)
            self.assertEqual(db.get(LumaBallRoom, room["id"]).status, "closed")

    def test_deleting_host_game_profile_closes_orphan_room_on_maintenance(self):
        room, host_headers, host, other_headers, other = self.connected_room()
        response = self.client.delete("/api/admin/lumaball/players/" + host["id"], headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        with self.sessions() as db:
            orphan = db.get(LumaBallRoom, room["id"])
            self.assertIsNone(orphan.host_id)
            service.expire_reservations(db); db.commit()
            self.assertEqual(orphan.status, "closed")
            self.assertEqual(db.query(LumaBallRoomMember).filter_by(room_id=room["id"], left_at=None).count(), 0)
            self.assertIsNotNone(db.get(LumaBallProfile, other["id"]))


if __name__ == "__main__":
    unittest.main()
