"""Same-origin signaling and bounded relay for the browser-hosted LumaBall game.

Room membership, moderation and results belong to QStudy. Physics runs in the
room creator's browser; this is a casual game, not an authoritative ranking.
"""
from __future__ import annotations

import asyncio
from collections import defaultdict, deque
from dataclasses import dataclass, field
from datetime import datetime
import json
import math
import re
import secrets
from time import monotonic
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from app.config import settings
from app.database import SessionLocal
from app.lumaball_room_models import LumaBallChatMessage, LumaBallRoom
from app.security import client_key, rate_limit
from app.services import lumaball_rooms as rooms
from app.services.lumaball_identity import consume_ticket, get_config, get_settings, validate_identity

router = APIRouter()
MAX_MESSAGE_BYTES = 24 * 1024
_ID = re.compile(r"^[a-f0-9]{32}$")


def origin_matches(value, expected):
    """Browser Origin omits default ports, even when the setup records :80."""
    try:
        def canonical(raw):
            if not isinstance(raw, str) or not raw or any(ord(char) < 33 for char in raw):
                raise ValueError("Invalid origin")
            item = urlsplit(raw)
            if (item.scheme not in ("http", "https") or not item.hostname or item.username or item.password
                    or item.path not in ("", "/") or item.query or item.fragment):
                raise ValueError("Invalid origin")
            return item.scheme, item.hostname, item.port or (443 if item.scheme == "https" else 80)
        return canonical(value) == canonical(expected)
    except (TypeError, ValueError):
        return False


def finite(value, minimum, maximum):
    return type(value) in (int, float) and math.isfinite(value) and minimum <= value <= maximum


def validate_signal(value):
    if not isinstance(value, dict) or len(value) != 1:
        raise ValueError("Некорректный сигнал соединения")
    if "description" in value:
        item = value["description"]
        if (not isinstance(item, dict) or set(item) != {"type", "sdp"}
                or item["type"] not in ("offer", "answer") or not isinstance(item["sdp"], str)
                or not 1 <= len(item["sdp"]) <= 16000):
            raise ValueError("Некорректное описание соединения")
    elif "candidate" in value:
        item = value["candidate"]
        if item is None:
            return value
        if (not isinstance(item, dict) or set(item) - {"candidate", "sdpMid", "sdpMLineIndex", "usernameFragment"}
                or not isinstance(item.get("candidate"), str) or len(item["candidate"]) > 3000
                or any(item.get(key) is not None and (not isinstance(item[key], str) or len(item[key]) > 256)
                       for key in ("sdpMid", "usernameFragment"))
                or (item.get("sdpMLineIndex") is not None and (type(item["sdpMLineIndex"]) is not int or not 0 <= item["sdpMLineIndex"] <= 100))):
            raise ValueError("Некорректный ICE-кандидат")
    else:
        raise ValueError("Неизвестный сигнал соединения")
    return value


def validate_frame(frame, room, members):
    if (not isinstance(frame, dict) or frame.get("match_id") != room.match_id or not room.match_id
            or type(frame.get("seq")) is not int or not 0 <= frame["seq"] <= 2**53 - 1):
        raise ValueError("Некорректный кадр")
    if frame.get("width") != 1200 or frame.get("height") != 700:
        raise ValueError("Некорректный размер поля")
    players = frame.get("players")
    if not isinstance(players, list) or len(players) > room.max_players:
        raise ValueError("Некорректный состав игроков")
    roster = {profile.id: (member, profile) for member, profile in members}
    seen, safe_players = set(), []
    for player in players:
        if not isinstance(player, dict) or player.get("id") not in roster or player["id"] in seen:
            raise ValueError("Игрок не состоит в комнате")
        seen.add(player["id"])
        member, profile = roster[player["id"]]
        if member.team not in ("red", "blue") or player.get("team") != member.team:
            raise ValueError("Команда игрока изменилась")
        if (not all(finite(player.get(key), -150, maximum) for key, maximum in (("x", 1350), ("y", 850)))
                or not all(finite(player.get(key), -6000, 6000) for key in ("vx", "vy"))
                or type(player.get("kicking")) is not bool):
            raise ValueError("Некорректная позиция игрока")
        safe_players.append({key: player[key] for key in ("id", "team", "x", "y", "vx", "vy", "kicking")} | {"name": profile.name})
    ball = frame.get("ball")
    if (not isinstance(ball, dict) or not finite(ball.get("x"), -150, 1350) or not finite(ball.get("y"), -150, 850)
            or not all(finite(ball.get(key), -10000, 10000) for key in ("vx", "vy"))):
        raise ValueError("Некорректная позиция мяча")
    score = frame.get("score")
    if not isinstance(score, dict) or not all(type(score.get(team)) is int and 0 <= score[team] <= room.score_limit for team in ("red", "blue")):
        raise ValueError("Некорректный счёт")
    if (not finite(frame.get("elapsed"), 0, room.time_limit * 60 + 120)
            or not finite(frame.get("remaining"), 0, room.time_limit * 60)
            or not finite(frame.get("kickoff"), 0, 10)
            or type(frame.get("finished")) is not bool
            or frame.get("winner") not in (None, "red", "blue", "draw")):
        raise ValueError("Некорректное состояние матча")
    return {"seq": frame["seq"], "match_id": room.match_id, "width": 1200, "height": 700, "players": safe_players,
            "ball": {key: ball[key] for key in ("x", "y", "vx", "vy")},
            "score": {team: score[team] for team in ("red", "blue")},
            **{key: frame[key] for key in ("elapsed", "remaining", "kickoff", "finished", "winner")}}


@dataclass(eq=False)
class Connection:
    socket: WebSocket
    identity: object
    room_id: str
    send_lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    counts: dict = field(default_factory=lambda: defaultdict(deque))
    last_validation: float = 0
    last_score_save: float = 0

    @property
    def id(self):
        return self.identity.profile.id

    def allow(self, key, amount, window=1):
        now = monotonic()
        values = self.counts[key]
        while values and values[0] <= now - window:
            values.popleft()
        if len(values) >= amount:
            return False
        values.append(now)
        return True

    async def send(self, value):
        try:
            async with self.send_lock:
                await asyncio.wait_for(self.socket.send_json(value), timeout=3)
            return True
        except (RuntimeError, OSError, WebSocketDisconnect, asyncio.TimeoutError):
            return False


class GameHub:
    def __init__(self, sessions=SessionLocal):
        self.sessions = sessions
        self.connections: dict[str, Connection] = {}
        self._maintenance = None

    async def start(self):
        if self._maintenance is None:
            self._maintenance = asyncio.create_task(self.maintain())

    async def stop(self):
        if self._maintenance is not None:
            self._maintenance.cancel()
            try:
                await self._maintenance
            except asyncio.CancelledError:
                pass
            self._maintenance = None
        await asyncio.gather(*(self.disconnect_profile(key, "server_stopped") for key in list(self.connections)), return_exceptions=True)

    async def maintain(self):
        while True:
            await asyncio.sleep(3)
            for connection in list(self.connections.values()):
                try:
                    self.check(connection)
                except HTTPException:
                    await self.disconnect_profile(connection.id, "access_revoked")
            with self.sessions() as db:
                rooms.expire_reservations(db)
                db.commit()

    def check(self, connection):
        with self.sessions() as db:
            updated = validate_identity(connection.identity, db)
            room = rooms.room_by_id(db, connection.room_id)
            if room.host_id is None:
                raise HTTPException(404, "Создатель комнаты вышел")
            if rooms.member(db, room.id, updated.profile.id) is None:
                raise HTTPException(403, "Вы больше не состоите в комнате")
            # Preserve the original authentication issuance time across checks.
            updated.issued_at = connection.identity.issued_at
            connection.identity = updated
            connection.last_validation = monotonic()

    async def broadcast(self, room_id, message, *, exclude=None):
        peers = [item for item in list(self.connections.values()) if item.room_id == room_id and item.id != exclude]
        if peers:
            await asyncio.gather(*(item.send(message) for item in peers))

    async def close_room(self, room_id, reason="closed"):
        for connection in list(self.connections.values()):
            if connection.room_id == room_id and self.connections.get(connection.id) is connection:
                self.connections.pop(connection.id, None)
                await connection.send({"type": "closed", "reason": reason})
                try:
                    await connection.socket.close(code=1000)
                except (RuntimeError, OSError):
                    pass

    async def disconnect_profile(self, profile_id, reason="removed"):
        connection = self.connections.get(profile_id)
        if connection:
            self.connections.pop(profile_id, None)
            await connection.send({"type": "closed", "reason": reason})
            try:
                await connection.socket.close(code=1000)
            except (RuntimeError, OSError):
                pass
            await self.depart(connection, forced=True)

    async def depart(self, connection, *, forced=False):
        if not forced and self.connections.get(connection.id) is not connection:
            return  # An old tab must not disconnect the tab that replaced it.
        self.connections.pop(connection.id, None)
        with self.sessions() as db:
            room = db.get(LumaBallRoom, connection.room_id)
            if room is None:
                return
            was_host = room.host_id is None or room.host_id == connection.id
            if room.host_id is None and room.status != "closed":
                rooms.close_room(db, room, "host_removed")
            rooms.leave_room(db, room.id, connection.id)
        if was_host:
            await self.close_room(connection.room_id, "host_left")
        else:
            await self.publish_room(connection.room_id)

    async def publish_room(self, room_id):
        with self.sessions() as db:
            room = db.get(LumaBallRoom, room_id)
            if room is None or room.status == "closed":
                closed = True
                payload, valid_ids = None, set()
            else:
                closed = False
                payload = rooms.public_room(db, room)
                payload["is_member"] = True
                valid_ids = {item["id"] for item in payload["members"]}
        if closed:
            await self.close_room(room_id)
            return
        for connection in list(self.connections.values()):
            if connection.room_id == room_id and connection.id not in valid_ids:
                await self.disconnect_profile(connection.id, "removed")
        await self.broadcast(room_id, {"type": "room", "room": payload})

    async def receive(self, connection, data):
        if not isinstance(data, dict) or not isinstance(data.get("type"), str):
            raise ValueError("Некорректное сообщение")
        kind = data["type"]
        if monotonic() - connection.last_validation >= 2:
            self.check(connection)
        if kind == "ping":
            if connection.allow("ping", 3):
                await connection.send({"type": "pong"})
            return
        if kind in ("frame", "input") and not connection.allow(kind, 35 if kind == "frame" else 50):
            return  # Drop excess transient samples instead of buffering them.
        if kind == "signal" and not connection.allow("signaling", 120):
            raise HTTPException(429, "Слишком много сигналов соединения")
        if kind not in ("frame", "input", "signal") and not connection.allow("control", 25):
            raise HTTPException(429, "Слишком много команд")
        with self.sessions() as db:
            room = rooms.room_by_id(db, connection.room_id)
            own = rooms.member(db, room.id, connection.id)
            if own is None:
                raise HTTPException(403, "Вы больше не состоите в комнате")
            if kind == "signal":
                target_id = data.get("target")
                target = self.connections.get(target_id) if isinstance(target_id, str) else None
                if (target is None or target.id == connection.id or target.room_id != room.id
                        or not (room.host_id == connection.id or room.host_id == target.id)):
                    raise HTTPException(403, "Соединение с этим игроком недоступно")
                payload = validate_signal(data.get("payload"))
                await target.send({"type": "signal", "from": connection.id, "payload": payload})
            elif kind == "input":
                value = data.get("input")
                if not isinstance(value, dict) or not all(finite(value.get(key), -1, 1) for key in ("x", "y")) or type(value.get("kick")) is not bool:
                    raise ValueError("Некорректное управление")
                if own.team not in ("red", "blue") or room.status != "playing":
                    return
                host = self.connections.get(room.host_id)
                if host and host.id != connection.id:
                    await host.send({"type": "input", "from": connection.id, "input": {key: value[key] for key in ("x", "y", "kick")}})
            elif kind == "frame":
                if room.host_id != connection.id:
                    raise HTTPException(403, "Кадры отправляет создатель комнаты")
                if room.status not in ("playing", "paused", "finished"):
                    return
                frame = validate_frame(data.get("frame"), room, rooms.active_members(db, room.id))
                if monotonic() - connection.last_score_save > 2:
                    room.red_score, room.blue_score = frame["score"]["red"], frame["score"]["blue"]
                    db.commit()
                    connection.last_score_save = monotonic()
                await self.broadcast(room.id, {"type": "frame", "frame": frame}, exclude=connection.id)
            elif kind == "command":
                # Commands always recheck administrator status and account revocation.
                self.check(connection)
                rooms.room_command(db, room.id, connection.identity, data, commit=False)
                if connection.identity.is_admin:
                    from app.services.audit import record_audit
                    record_audit(db, connection.identity.user, "lumaball.room.command", "lumaball_room", room.id, fields=[data.get("action", "")])
                db.commit()
                await self.publish_room(room.id)
            elif kind == "result":
                rooms.save_result(db, room, connection.identity, data)
                await self.publish_room(room.id)
            elif kind == "chat":
                if not get_config(db)["chat_enabled"]:
                    raise HTTPException(403, "Чат отключён администратором")
                if not connection.allow("chat", 8, 10):
                    raise HTTPException(429, "Отправляйте сообщения реже")
                message = LumaBallChatMessage(room_id=room.id, profile_id=connection.id,
                    name=connection.identity.profile.name, text=rooms.clean_text(data.get("text"), 280))
                db.add(message)
                db.flush()
                payload = rooms.public_chat(message)
                # Bound retained chat for each room.
                old = db.query(LumaBallChatMessage.id).filter_by(room_id=room.id).order_by(LumaBallChatMessage.id.desc()).offset(200).all()
                if old:
                    db.query(LumaBallChatMessage).filter(LumaBallChatMessage.id.in_([row[0] for row in old])).delete(synchronize_session=False)
                db.commit()
                await self.broadcast(room.id, {"type": "chat", "message": payload})
            else:
                raise ValueError("Неизвестный тип сообщения")

    async def connect(self, socket):
        # No JWT, password or guest credential is accepted through the URL.
        # Only an expiring, single-use ticket can cross the WebSocket handshake.
        proof = socket.headers.get("x-qstudy-proxy-key", "")
        if (not origin_matches(socket.headers.get("origin"), settings.PUBLIC_BASE_URL)
                or (settings.BFF_PROXY_SECRET and not secrets.compare_digest(proof.encode(), settings.BFF_PROXY_SECRET.encode()))):
            await socket.close(code=1008)
            return
        connection = None
        try:
            rate_limit("lumaball-ws:" + client_key(socket), 40, 60)
            room_id = socket.query_params.get("room", "")
            if not _ID.fullmatch(room_id):
                raise HTTPException(404, "Комната не найдена")
            with self.sessions() as db:
                identity = consume_ticket(socket.query_params.get("ticket", ""), db)
                room = rooms.room_by_id(db, room_id)
                own = rooms.member(db, room_id, identity.profile.id)
                if own is None:
                    raise HTTPException(403, "Сначала войдите в комнату")
                if (room.host_id == identity.profile.id and room.status in ("playing", "paused")
                        and identity.profile.id in self.connections):
                    # A second browser has no copy of the host's running physics.
                    # Keep the original simulation instead of resetting its score/time.
                    await socket.accept()
                    await socket.send_json({"type": "closed", "reason": "host_already_connected"})
                    await socket.close(code=1000)
                    return
                own.connected = True
                db.commit()
                welcome = {"type": "welcome", "identity": identity.public(), "room": rooms.public_room(db, room, identity.profile.id),
                           "host_id": room.host_id, "ice_servers": get_settings(db).model_dump()["ice_servers"]}
            await socket.accept()
            connection = Connection(socket, identity, room_id)
            previous = self.connections.get(connection.id)
            self.connections[connection.id] = connection
            if previous:
                await previous.send({"type": "closed", "reason": "another_tab"})
                try:
                    await previous.socket.close(code=1000)
                except (RuntimeError, OSError):
                    pass
            await connection.send(welcome)
            await self.publish_room(room_id)
            while self.connections.get(connection.id) is connection:
                try:
                    event = await asyncio.wait_for(socket.receive(), timeout=3)
                except asyncio.TimeoutError:
                    self.check(connection)
                    continue
                if event["type"] == "websocket.disconnect":
                    break
                raw = event.get("text")
                if raw is None or len(raw.encode("utf-8")) > MAX_MESSAGE_BYTES:
                    await socket.close(code=1009)
                    break
                try:
                    data = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError("Некорректное число")))
                    await self.receive(connection, data)
                except (ValueError, TypeError, KeyError, RecursionError, HTTPException) as error:
                    await connection.send({"type": "error", "detail": error.detail if isinstance(error, HTTPException) else str(error)[:180]})
                    if (isinstance(error, HTTPException) and error.status_code in (401, 404, 503)) or not connection.allow("invalid", 8, 10):
                        await socket.close(code=1008)
                        break
        except HTTPException:
            try:
                await socket.close(code=1008)
            except RuntimeError:
                pass
        except (WebSocketDisconnect, RuntimeError, OSError):
            pass
        finally:
            if connection is not None:
                await self.depart(connection)


hub = GameHub()


@router.websocket("/lumaball/ws")
async def game_socket(socket: WebSocket):
    await hub.connect(socket)
