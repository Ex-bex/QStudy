"""Real SQLite query budgets and bounded relay under slow-recipient pressure."""
import asyncio
from contextlib import contextmanager
from datetime import datetime
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest

os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")

from fastapi import HTTPException
from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker

from app.database import Base
from app.lumaball_models import LumaBallProfile
from app.lumaball_room_models import LumaBallRoom, LumaBallRoomMember
from app.services.lumaball_identity import Identity
from app.services import lumaball_realtime as realtime


class Socket:
    def __init__(self, blocked=None):
        self.messages = []
        self.blocked = blocked
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.closed = False

    async def send_json(self, value):
        if value.get("type") == self.blocked and not self.release.is_set():
            self.entered.set()
            await self.release.wait()
        self.messages.append(value)

    async def close(self, code):
        self.closed = True


class LumaBallRelayPerformanceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qball-relay-fixture-")
        self.engine = create_engine("sqlite:///" + (Path(self.temporary.name) / "fixture.sqlite3").as_posix())
        Base.metadata.create_all(self.engine)
        self.sessions = sessionmaker(bind=self.engine, expire_on_commit=False)
        self.hub = realtime.GameHub(self.sessions)
        self.room_id, self.match_id = "a" * 32, "b" * 32
        self.host_id, self.peer_id = "1" * 32, "2" * 32
        with self.sessions() as db:
            host = LumaBallProfile(id=self.host_id, kind="guest", name="guest#100001", guest_number=100001)
            peer = LumaBallProfile(id=self.peer_id, kind="guest", name="guest#100002", guest_number=100002)
            db.add_all([host, peer])
            db.add(LumaBallRoom(id=self.room_id, name="Fixture arena", host_id=self.host_id,
                               status="playing", max_players=4, score_limit=5, time_limit=5, match_id=self.match_id))
            db.add_all([LumaBallRoomMember(room_id=self.room_id, profile_id=self.host_id, team="red", connected=True),
                        LumaBallRoomMember(room_id=self.room_id, profile_id=self.peer_id, team="blue", connected=True)])
            db.commit()
        self.host = realtime.Connection(Socket(), Identity(host, False), self.room_id)
        self.peer = realtime.Connection(Socket(), Identity(peer, False), self.room_id)
        self.hub.connections = {self.host_id: self.host, self.peer_id: self.peer}

    async def asyncTearDown(self):
        for connection in list(self.hub.connections.values()):
            await connection.stop_transients()
        self.engine.dispose()
        self.temporary.cleanup()

    @contextmanager
    def select_queries(self):
        queries = []

        def capture(connection, cursor, statement, parameters, context, executemany):
            if statement.lstrip().upper().startswith("SELECT"):
                queries.append(statement)

        event.listen(self.engine, "before_cursor_execute", capture)
        try:
            yield queries
        finally:
            event.remove(self.engine, "before_cursor_execute", capture)

    async def drained(self, connection):
        task = connection._transient_task
        if task is not None:
            await asyncio.wait_for(asyncio.shield(task), timeout=1)

    def frame(self, seq=1):
        return {"seq": seq, "match_id": self.match_id, "width": 800, "height": 400,
                "players": [{"id": self.host_id, "name": "FORGED", "team": "red", "x": 200, "y": 200, "vx": 0, "vy": 0, "kicking": False},
                            {"id": self.peer_id, "name": "FORGED", "team": "blue", "x": 600, "y": 200, "vx": 0, "vy": 0, "kicking": False}],
                "ball": {"x": 400, "y": 200, "vx": 0, "vy": 0}, "score": {"red": 0, "blue": 0},
                "elapsed": 1, "remaining": 299, "kickoff": 0, "finished": False, "winner": None}

    async def test_input_uses_one_current_membership_query_without_caching_or_spoofed_sender(self):
        self.peer.last_validation = realtime.monotonic()
        packet = {"type": "input", "from": self.host_id, "input": {"x": 1, "y": 0, "kick": True}}
        with self.select_queries() as queries:
            await self.hub.receive(self.peer, packet)
        self.assertEqual(len(queries), 1)
        await self.drained(self.host)
        self.assertEqual(self.host.socket.messages[-1]["from"], self.peer_id)
        with self.sessions() as db:
            db.query(LumaBallRoomMember).filter_by(room_id=self.room_id, profile_id=self.peer_id).update({"left_at": datetime.utcnow()})
            db.commit()
        # No cached permission window: a removed player is rejected on its very
        # next packet even before the ordinary account-revalidation heartbeat.
        with self.assertRaises(HTTPException) as failure:
            await self.hub.receive(self.peer, packet)
        self.assertEqual(failure.exception.status_code, 403)

    async def test_frame_uses_two_queries_and_still_validates_host_match_and_canonical_roster(self):
        self.host.last_validation = self.host.last_score_save = realtime.monotonic()
        with self.select_queries() as queries:
            await self.hub.receive(self.host, {"type": "frame", "frame": self.frame()})
        self.assertEqual(len(queries), 2)
        await self.drained(self.peer)
        self.assertEqual(self.peer.socket.messages[-1]["frame"]["players"][0]["name"], "guest#100001")
        self.peer.last_validation = realtime.monotonic()
        with self.assertRaises(HTTPException):
            await self.hub.receive(self.peer, {"type": "frame", "frame": self.frame(2)})
        invalid = self.frame(3); invalid["match_id"] = "c" * 32
        with self.assertRaises(ValueError):
            await self.hub.receive(self.host, {"type": "frame", "frame": invalid})

    async def test_a_slow_recipient_does_not_block_fast_peers_and_receives_only_latest_snapshot(self):
        slow = realtime.Connection(Socket(blocked="frame"), SimpleNamespace(profile=SimpleNamespace(id="slow")), self.room_id)
        self.hub.connections[slow.id] = slow
        await asyncio.wait_for(self.hub.broadcast(self.room_id, {"type": "frame", "frame": self.frame(1)}, exclude=self.host_id), timeout=0.2)
        await asyncio.wait_for(slow.socket.entered.wait(), timeout=1)
        await self.drained(self.peer)
        self.assertEqual(self.peer.socket.messages[-1]["frame"]["seq"], 1)
        for seq in range(2, 201):
            await self.hub.broadcast(self.room_id, {"type": "frame", "frame": self.frame(seq)}, exclude=self.host_id)
        await self.drained(self.peer)
        self.assertEqual(self.peer.socket.messages[-1]["frame"]["seq"], 200)
        self.assertEqual(len(slow._transient), 1)
        slow.socket.release.set()
        await self.drained(slow)
        self.assertEqual([event["frame"]["seq"] for event in slow.socket.messages], [1, 200])

    async def test_slow_host_input_delivery_coalesces_per_authenticated_player_without_blocking_receivers(self):
        self.host.socket = Socket(blocked="input")
        self.peer.last_validation = realtime.monotonic()
        await asyncio.wait_for(self.hub.receive(self.peer, {"type": "input", "input": {"x": 1, "y": 0, "kick": False}}), timeout=0.2)
        await asyncio.wait_for(self.host.socket.entered.wait(), timeout=1)
        for value in range(20):
            await self.hub.receive(self.peer, {"type": "input", "input": {"x": value / 20, "y": 0, "kick": False}})
        self.assertEqual(len(self.host._transient), 1)
        self.host.socket.release.set()
        await self.drained(self.host)
        self.assertEqual(len(self.host.socket.messages), 2)
        self.assertEqual(self.host.socket.messages[-1]["from"], self.peer_id)
        self.assertEqual(self.host.socket.messages[-1]["input"]["x"], 0.95)

    async def test_close_cancels_inflight_transients_and_keeps_reliable_control_order(self):
        self.peer.socket = Socket(blocked="frame")
        self.peer.send_transient("frame", {"type": "frame", "frame": self.frame()})
        await asyncio.wait_for(self.peer.socket.entered.wait(), timeout=1)
        self.peer.send_transient("frame", {"type": "frame", "frame": self.frame(2)})
        await asyncio.wait_for(self.hub.close_room(self.room_id, "administrator"), timeout=0.2)
        self.assertEqual(self.hub.connections, {})
        self.assertTrue(self.peer.socket.closed)
        self.assertEqual(self.peer.socket.messages, [{"type": "closed", "reason": "administrator"}])
        self.assertIsNone(self.peer._transient_task)
        self.assertEqual(self.peer._transient, {})
        self.assertFalse(self.peer.send_transient("frame", {"type": "frame"}))

    async def test_room_boundary_discards_pending_old_frames_but_keeps_inflight_before_reliable_messages(self):
        self.peer.socket = Socket(blocked="frame")
        self.peer.send_transient("frame", {"type": "frame", "frame": self.frame(1)})
        await asyncio.wait_for(self.peer.socket.entered.wait(), timeout=1)
        self.peer.send_transient("frame", {"type": "frame", "frame": self.frame(2)})
        updated = {"type": "room", "room": {"status": "finished", "match_id": self.match_id, "score": {"red": 5, "blue": 0}}}
        publication = asyncio.create_task(self.hub.broadcast(self.room_id, updated))
        await asyncio.sleep(0)
        self.peer.socket.release.set()
        await asyncio.wait_for(publication, timeout=1)
        await self.drained(self.peer)
        await self.peer.send({"type": "chat", "message": {"text": "after result"}})
        self.assertEqual([value["type"] for value in self.peer.socket.messages], ["frame", "room", "chat"])
        self.assertEqual(self.peer.socket.messages[0]["frame"]["seq"], 1)


if __name__ == "__main__":
    unittest.main()
