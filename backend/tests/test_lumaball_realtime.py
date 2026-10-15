"""Actual in-process WebSocket handshakes, room isolation and relay regressions.

Every record and socket belongs to a temporary fixture. Never open project data.
"""
from contextlib import ExitStack
import asyncio
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker
from starlette.websockets import WebSocketDisconnect

from app.auth import create_access_token
from app.config import settings
from app.database import Base, get_db
from app.models import User
from app.lumaball_models import LumaBallProfile
from app.lumaball_room_models import LumaBallMatch, LumaBallRoom
from app.routers import lumaball_identity, lumaball_rooms
from app.services import lumaball_realtime as realtime
from app.services import lumaball_rooms as room_service
from app.services.lumaball_identity import Identity


class LumaBallRealtimeTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.folder = self.stack.enter_context(tempfile.TemporaryDirectory())
        self.engine = create_engine("sqlite:///" + (Path(self.folder) / "fixture.sqlite3").as_posix(),
                                    connect_args={"check_same_thread": False, "timeout": 15})
        self.stack.callback(self.engine.dispose)
        @event.listens_for(self.engine, "connect")
        def foreign_keys(connection, record):
            connection.execute("PRAGMA foreign_keys=ON")
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.hub = realtime.GameHub(self.sessions)
        self.stack.enter_context(patch.object(realtime, "hub", self.hub))
        self.stack.enter_context(patch.object(settings, "RATE_LIMIT_ENABLED", False))
        self.stack.enter_context(patch.object(settings, "PUBLIC_BASE_URL", "http://testserver"))
        self.stack.enter_context(patch.object(settings, "BFF_PROXY_SECRET", "fixture-ws-private-proof-0123456789abcdef"))
        self.app = FastAPI()
        self.app.include_router(lumaball_identity.router, prefix="/api")
        self.app.include_router(lumaball_rooms.router, prefix="/api")
        self.app.include_router(realtime.router, prefix="/api")
        def database():
            with self.sessions() as db:
                yield db
        self.app.dependency_overrides[get_db] = database
        self.client = self.stack.enter_context(TestClient(self.app))
        with self.sessions() as db:
            admin = User(email="ws-admin@example.invalid", name="Fixture Admin", role="admin", hashed_password="PRIVATE_FIXTURE")
            student = User(email="ws-student@example.invalid", name="Fixture Student", role="student", hashed_password="PRIVATE_FIXTURE")
            db.add_all([admin, student]); db.commit()
            self.admin_id, self.student_id = admin.id, student.id
        self.admin = {"Authorization": "Bearer " + create_access_token(self.admin_id)}
        self.student = {"Authorization": "Bearer " + create_access_token(self.student_id)}

    def tearDown(self):
        self.stack.close()

    def session(self, headers=None):
        response = self.client.post("/api/lumaball/session", headers=headers or {})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def guest(self):
        session = self.session()
        return {"X-LumaBall-Session": session["guest_token"]}, session["identity"]

    def room(self, headers, **changes):
        response = self.client.post("/api/lumaball/rooms", headers=headers,
                                    json={"name": "Fixture purple arena", "max_players": 4, **changes})
        self.assertEqual(response.status_code, 201, response.text)
        return response.json()

    def join(self, headers, room, password=""):
        response = self.client.post("/api/lumaball/rooms/" + room["id"] + "/join", headers=headers, json={"password": password})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    def websocket(self, headers, room, *, ticket=None, origin="http://testserver", proof=None):
        ticket = ticket or self.session(headers)["ws_ticket"]
        return self.client.websocket_connect("/api/lumaball/ws?ticket=" + ticket + "&room=" + room["id"],
            headers={"Origin": origin, "X-QStudy-Proxy-Key": settings.BFF_PROXY_SECRET if proof is None else proof})

    def receive(self, socket, kind, predicate=lambda data: True):
        for _ in range(20):
            value = socket.receive_json()
            if value.get("type") == kind and predicate(value):
                return value
        self.fail("Expected WebSocket event was not delivered: " + kind)

    def connect_pair(self, stack, host_headers=None):
        host_headers, host_identity = (host_headers, self.session(host_headers)["identity"]) if host_headers else self.guest()
        peer_headers, peer_identity = self.guest()
        room = self.room(host_headers)
        self.join(peer_headers, room)
        host = stack.enter_context(self.websocket(host_headers, room))
        self.receive(host, "welcome")
        peer = stack.enter_context(self.websocket(peer_headers, room))
        self.receive(peer, "welcome")
        return host, peer, room, host_headers, peer_headers, host_identity, peer_identity

    def start(self, host, peer):
        host.send_json({"type": "command", "action": "start"})
        room = self.receive(host, "room", lambda event: event["room"]["status"] == "playing")["room"]
        self.receive(peer, "room", lambda event: event["room"]["status"] == "playing")
        return room

    def frame(self, room):
        return {"seq": 1, "match_id": room["match_id"], "width": 1200, "height": 700,
            "players": [{"id": member["id"], "name": "FORGED_NAME", "team": member["team"],
                         "x": 350 if member["team"] == "red" else 850, "y": 350, "vx": 0, "vy": 0, "kicking": False}
                        for member in room["members"] if member["team"] != "spectator"],
            "ball": {"x": 600, "y": 350, "vx": 0, "vy": 0}, "score": {"red": 0, "blue": 0},
            "elapsed": 0, "remaining": room["time_limit"] * 60, "kickoff": 1, "finished": False, "winner": None}

    def test_origin_and_private_proxy_proof_are_checked_before_accepting_a_ticket(self):
        headers, identity = self.guest()
        room = self.room(headers)
        ticket = self.session(headers)["ws_ticket"]
        for change in ({"origin": "http://evil.invalid"}, {"proof": "forged"}):
            with self.assertRaises(WebSocketDisconnect):
                with self.websocket(headers, room, ticket=ticket, **change):
                    pass
        with self.websocket(headers, room, ticket=ticket) as socket:
            self.assertEqual(self.receive(socket, "welcome")["identity"]["id"], identity["id"])

    def _assert_disconnect_preserves_new_connection(self, *, same_room):
        host_headers, _ = self.guest()
        player_headers, player = self.guest()
        old_room = self.room(host_headers)
        self.join(player_headers, old_room)
        if same_room:
            new_room = old_room
        else:
            other_host, _ = self.guest()
            new_room = self.room(other_host)
        with self.sessions() as db:
            identity = Identity(db.get(LumaBallProfile, player["id"]), False)
            room_service.leave_room(db, old_room["id"], player["id"])

        class Socket:
            def __init__(self, on_send=None):
                self.on_send = on_send

            async def send_json(self, value):
                if self.on_send:
                    self.on_send()

            async def close(self, code):
                pass

        replacement = realtime.Connection(Socket(), identity, new_room["id"])
        def reconnect_during_close():
            with self.sessions() as db:
                room_service.join_room(db, new_room["id"], identity)
                room_service.member(db, new_room["id"], player["id"]).connected = True
                db.commit()
            self.hub.connections[player["id"]] = replacement
        old = realtime.Connection(Socket(reconnect_during_close), identity, old_room["id"])
        self.hub.connections[player["id"]] = old
        # send_json yields while the old socket closes. A new tab/join may win
        # that scheduling gap; the old cleanup must not remove its membership.
        asyncio.run(self.hub.disconnect_profile(player["id"], "left_room"))
        self.assertIs(self.hub.connections[player["id"]], replacement)
        with self.sessions() as db:
            current = room_service.member(db, new_room["id"], player["id"])
            self.assertIsNotNone(current)
            self.assertTrue(current.connected)

    def test_old_departure_preserves_a_new_connection_in_another_room(self):
        self._assert_disconnect_preserves_new_connection(same_room=False)

    def test_old_departure_preserves_rejoined_membership_in_the_same_room(self):
        self._assert_disconnect_preserves_new_connection(same_room=True)

    def test_ticket_requires_membership_and_is_single_use_without_exposing_credentials(self):
        host_headers, _ = self.guest()
        outside_headers, _ = self.guest()
        room = self.room(host_headers, password="private-room")
        with self.assertRaises(WebSocketDisconnect):
            with self.websocket(outside_headers, room):
                pass
        self.join(outside_headers, room, "private-room")
        ticket = self.session(outside_headers)["ws_ticket"]
        with self.websocket(outside_headers, room, ticket=ticket) as socket:
            welcome = self.receive(socket, "welcome")
            self.assertNotIn("guest_token", json.dumps(welcome))
            self.assertNotIn("PRIVATE_FIXTURE", json.dumps(welcome))
            with self.assertRaises(WebSocketDisconnect):
                with self.websocket(outside_headers, room, ticket=ticket):
                    pass

    def test_real_signal_input_frame_chat_and_result_roundtrip(self):
        with ExitStack() as stack:
            host, peer, _, _, _, host_identity, peer_identity = self.connect_pair(stack)
            host.send_json({"type": "signal", "target": peer_identity["id"], "payload": {"description": {"type": "offer", "sdp": "fixture-offer"}}})
            signal = self.receive(peer, "signal")
            self.assertEqual(signal["from"], host_identity["id"])
            peer.send_json({"type": "signal", "target": host_identity["id"], "payload": {"description": {"type": "answer", "sdp": "fixture-answer"}}})
            self.assertEqual(self.receive(host, "signal")["payload"]["description"]["type"], "answer")
            room = self.start(host, peer)
            peer.send_json({"type": "input", "from": host_identity["id"], "input": {"x": 1, "y": 0, "kick": True}})
            delivered = self.receive(host, "input")
            self.assertEqual(delivered["from"], peer_identity["id"], "sender cannot impersonate the host")
            host.send_json({"type": "frame", "frame": self.frame(room)})
            frame = self.receive(peer, "frame")["frame"]
            self.assertEqual(frame["match_id"], room["match_id"])
            self.assertNotIn("FORGED_NAME", json.dumps(frame))
            peer.send_json({"type": "chat", "text": "Good game!"})
            self.assertEqual(self.receive(host, "chat")["message"]["text"], "Good game!")
            self.receive(peer, "chat")
            result = {"type": "result", "match_id": room["match_id"], "red": 5, "blue": 2, "duration_seconds": 70}
            host.send_json(result)
            finished = self.receive(peer, "room", lambda event: event["room"]["status"] == "finished")["room"]
            self.assertEqual(finished["score"], {"red": 5, "blue": 2})
            host.send_json(result)
            self.receive(host, "room", lambda event: event["room"]["status"] == "finished")
            with self.sessions() as db:
                self.assertEqual(db.query(LumaBallMatch).count(), 1)

    def test_non_host_cannot_start_pause_forge_frames_or_report_a_result(self):
        with ExitStack() as stack:
            host, peer, _, _, _, _, _ = self.connect_pair(stack)
            peer.send_json({"type": "command", "action": "start"})
            self.assertIn("создатель", self.receive(peer, "error")["detail"])
            room = self.start(host, peer)
            for payload in ({"type": "command", "action": "pause"}, {"type": "frame", "frame": self.frame(room)},
                            {"type": "result", "match_id": room["match_id"], "red": 5, "blue": 0, "duration_seconds": 5}):
                peer.send_json(payload)
                self.receive(peer, "error")
            with self.sessions() as db:
                self.assertEqual(db.query(LumaBallMatch).count(), 0)
                self.assertEqual(db.get(LumaBallRoom, room["id"]).status, "playing")

    def test_signaling_cannot_escape_a_room_and_invalid_frames_do_not_break_the_host(self):
        with ExitStack() as stack:
            host, peer, _, _, _, _, _ = self.connect_pair(stack)
            foreign_headers, foreign_identity = self.guest()
            foreign_room = self.room(foreign_headers)
            foreign = stack.enter_context(self.websocket(foreign_headers, foreign_room))
            self.receive(foreign, "welcome")
            host.send_json({"type": "signal", "target": foreign_identity["id"], "payload": {"description": {"type": "offer", "sdp": "private"}}})
            self.receive(host, "error")
            room = self.start(host, peer)
            wrong = self.frame(room); wrong["match_id"] = "0" * 32
            host.send_json({"type": "frame", "frame": wrong})
            self.receive(host, "error")
            wrong = self.frame(room); wrong["players"][0]["id"] = foreign_identity["id"]
            host.send_json({"type": "frame", "frame": wrong})
            self.receive(host, "error")
            host.send_json({"type": "frame", "frame": self.frame(room)})
            self.assertEqual(self.receive(peer, "frame")["frame"]["seq"], 1)

    def test_malformed_and_non_finite_json_is_rejected_then_valid_messages_still_work(self):
        headers, _ = self.guest()
        room = self.room(headers)
        with self.websocket(headers, room) as socket:
            self.receive(socket, "welcome")
            for raw in ("{", "null", '{"type":"input","input":{"x":NaN,"y":0,"kick":false}}'):
                socket.send_text(raw)
                self.receive(socket, "error")
            socket.send_json({"type": "ping"})
            self.receive(socket, "pong")

    def test_oversized_game_messages_close_the_socket_without_poisoning_other_rooms(self):
        headers, _ = self.guest()
        room = self.room(headers)
        with self.websocket(headers, room) as socket:
            self.receive(socket, "welcome")
            socket.send_text("x" * (realtime.MAX_MESSAGE_BYTES + 1))
            with self.assertRaises(WebSocketDisconnect) as failure:
                self.receive(socket, "pong")
            self.assertEqual(failure.exception.code, 1009)
        other_headers, _ = self.guest()
        other_room = self.room(other_headers)
        with self.websocket(other_headers, other_room) as socket:
            self.receive(socket, "welcome")
            socket.send_json({"type": "ping"})
            self.receive(socket, "pong")

    def test_ban_and_qstudy_token_revocation_invalidate_already_issued_tickets(self):
        for headers in (self.student, self.guest()[0]):
            identity = self.session(headers)["identity"]
            room = self.room(headers)
            ticket = self.session(headers)["ws_ticket"]
            with self.sessions() as db:
                if "Authorization" in headers:
                    db.get(User, self.student_id).token_version += 1
                else:
                    db.get(LumaBallProfile, identity["id"]).banned = True
                db.commit()
            with self.assertRaises(WebSocketDisconnect):
                with self.websocket(headers, room, ticket=ticket):
                    pass

    def test_host_disconnect_closes_room_and_notifies_remaining_players(self):
        with ExitStack() as stack:
            host, peer, room, _, _, _, _ = self.connect_pair(stack)
            self.start(host, peer)
            host.close()
            event = self.receive(peer, "closed")
            self.assertEqual(event["reason"], "host_left")
            with self.sessions() as db:
                self.assertEqual(db.get(LumaBallRoom, room["id"]).status, "closed")

    def test_a_second_host_tab_cannot_reset_or_disconnect_a_running_match(self):
        with ExitStack() as stack:
            host, peer, room, host_headers, _, host_identity, _ = self.connect_pair(stack)
            started = self.start(host, peer)
            original = self.hub.connections[host_identity["id"]]
            with self.websocket(host_headers, room) as duplicate:
                event = self.receive(duplicate, "closed")
                self.assertEqual(event["reason"], "host_already_connected")
            self.assertIs(self.hub.connections[host_identity["id"]], original)
            host.send_json({"type": "frame", "frame": self.frame(started)})
            self.assertEqual(self.receive(peer, "frame")["frame"]["match_id"], started["match_id"])
            with self.sessions() as db:
                saved = db.get(LumaBallRoom, room["id"])
                self.assertEqual(saved.status, "playing")
                self.assertEqual(saved.match_id, started["match_id"])


if __name__ == "__main__":
    unittest.main()
