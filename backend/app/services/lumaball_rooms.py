"""Server-owned rooms and results; real-time simulation stays in the host browser."""
from datetime import datetime, timedelta
import json
import re
import threading
import uuid
from fastapi import HTTPException
from sqlalchemy import func
from app.auth import hash_password, verify_password
from app.lumaball_models import LumaBallProfile
from app.lumaball_room_models import LumaBallRoom, LumaBallRoomMember, LumaBallMatch, LumaBallChatMessage
from app.services.lumaball_identity import get_config

ACTIVE = ("lobby", "playing", "paused", "finished")
TEAMS = ("red", "blue", "spectator")
_lock = threading.RLock()
_ID = re.compile(r"^[a-f0-9]{32}$")
# Keep unlimited casual matches within the integer storage/wire range. These
# are validation bounds, not gameplay limits or automatic finish conditions.
MAX_MATCH_VALUE = 2**31 - 1


def clean_text(value, limit, *, empty=False):
    if not isinstance(value, str):
        raise HTTPException(422, "Ожидается текст")
    value = value.strip()
    if (not empty and not value) or len(value) > limit or any(ord(c) < 32 or ord(c) == 127 for c in value):
        raise HTTPException(422, "Проверьте длину текста и уберите управляющие символы")
    return value


def room_by_id(db, room_id, *, include_closed=False):
    if not isinstance(room_id, str) or not _ID.fullmatch(room_id):
        raise HTTPException(404, "Комната не найдена")
    room = db.get(LumaBallRoom, room_id)
    if room is None or (not include_closed and room.status == "closed"):
        raise HTTPException(404, "Комната закрыта или не найдена")
    return room


def active_members(db, room_id):
    return db.query(LumaBallRoomMember, LumaBallProfile).join(
        LumaBallProfile, LumaBallProfile.id == LumaBallRoomMember.profile_id).filter(
        LumaBallRoomMember.room_id == room_id, LumaBallRoomMember.left_at.is_(None)).order_by(LumaBallRoomMember.joined_at, LumaBallRoomMember.id).all()


def member(db, room_id, profile_id):
    return db.query(LumaBallRoomMember).filter_by(room_id=room_id, profile_id=profile_id, left_at=None).first()


def _iso(value):
    return value.isoformat() + "Z" if value else None


def public_room(db, room, viewer=None, *, full=True):
    members = active_members(db, room.id)
    host = db.get(LumaBallProfile, room.host_id) if room.host_id else None
    result = {"id": room.id, "name": room.name, "host_id": room.host_id, "host_name": host.name if host else "Создатель вышел",
              "status": room.status, "players": len(members), "max_players": room.max_players,
              "locked": bool(room.password_hash), "password_required": bool(room.password_hash),
              "score_limit": room.score_limit, "time_limit": room.time_limit,
              "score": {"red": room.red_score, "blue": room.blue_score}, "match_id": room.match_id,
              "created_at": _iso(room.created_at), "is_member": bool(viewer and any(p.id == viewer for _, p in members))}
    if full:
        result["members"] = [{"id": p.id, "name": p.name, "kind": p.kind, "team": m.team,
                              "connected": m.connected, "is_host": p.id == room.host_id} for m, p in members]
        result["chat"] = list(reversed([public_chat(c) for c in db.query(LumaBallChatMessage).filter_by(room_id=room.id).order_by(LumaBallChatMessage.id.desc()).limit(60)]))
    return result


def public_chat(message):
    return {"id": message.id, "profile_id": message.profile_id, "name": message.name,
            "text": message.text, "created_at": _iso(message.created_at)}


def close_room(db, room, reason="closed"):
    room.status = "closed"
    room.closed_reason = reason[:60]
    room.updated_at = datetime.utcnow()
    db.query(LumaBallRoomMember).filter_by(room_id=room.id, left_at=None).update(
        {"left_at": datetime.utcnow(), "connected": False}, synchronize_session=False)


def expire_reservations(db):
    # Deleting a game profile must not leave its room without a simulation host.
    for orphan in db.query(LumaBallRoom).filter(LumaBallRoom.status.in_(ACTIVE), LumaBallRoom.host_id.is_(None)):
        close_room(db, orphan, "host_removed")
    cutoff = datetime.utcnow() - timedelta(minutes=2)
    pending = db.query(LumaBallRoomMember).filter(LumaBallRoomMember.left_at.is_(None),
        LumaBallRoomMember.connected.is_(False), LumaBallRoomMember.joined_at < cutoff).all()
    for pending_member in pending:
        room = db.get(LumaBallRoom, pending_member.room_id)
        if room and room.status != "closed" and room.host_id == pending_member.profile_id:
            close_room(db, room, "host_not_connected")
        else:
            pending_member.left_at = datetime.utcnow()
    db.flush()


def initialize_rooms(db):
    """A stopped game cannot resume its browser physics after a server restart."""
    for room in db.query(LumaBallRoom).filter(LumaBallRoom.status.in_(ACTIVE)):
        close_room(db, room, "server_restarted")
    db.commit()


def _limits(data, config):
    maximum = data.get("max_players", config.get("default_players", min(2, config["max_players"])))
    score = data.get("score_limit", config["score_limit"])
    minutes = data.get("time_limit", config["time_limit"])
    if type(maximum) is not int or not 2 <= maximum <= config["max_players"]:
        raise HTTPException(422, "Количество игроков превышает разрешённый предел")
    if type(score) is not int or not 0 <= score <= 20 or type(minutes) is not int or not 0 <= minutes <= 30:
        raise HTTPException(422, "Допустимо 0–20 голов и 0–30 минут; 0 — без ограничения")
    return maximum, score, minutes


def match_bounds(room):
    """Shared validation for snapshots/results, including original free play."""
    return (room.score_limit or MAX_MATCH_VALUE,
            room.time_limit * 60 + 120 if room.time_limit else MAX_MATCH_VALUE,
            room.time_limit * 60)


def create_room(db, identity, data):
    with _lock:
        config = get_config(db)
        if not config["enabled"] and not identity.is_admin:
            raise HTTPException(403, "Игра временно выключена администратором")
        if identity.profile.kind == "guest" and not config["guest_create_rooms"]:
            raise HTTPException(403, "Создавать комнаты могут авторизованные игроки")
        expire_reservations(db)
        existing = db.query(LumaBallRoomMember).join(LumaBallRoom).filter(
            LumaBallRoomMember.profile_id == identity.profile.id, LumaBallRoomMember.left_at.is_(None), LumaBallRoom.status.in_(ACTIVE)).first()
        if existing:
            raise HTTPException(409, "Сначала покиньте текущую комнату")
        if db.query(LumaBallRoom).filter(LumaBallRoom.status.in_(ACTIVE)).count() >= config["max_rooms"]:
            raise HTTPException(409, "Все комнаты заняты. Попробуйте позже")
        maximum, score, minutes = _limits(data, config)
        name = clean_text(data.get("name", ""), 80)
        password = clean_text(data.get("password", ""), 64, empty=True)
        room = LumaBallRoom(id=uuid.uuid4().hex, name=name, host_id=identity.profile.id,
                           password_hash=hash_password(password) if password else "", status="lobby",
                           max_players=maximum, score_limit=score, time_limit=minutes)
        db.add(room)
        db.flush()
        db.add(LumaBallRoomMember(room_id=room.id, profile_id=identity.profile.id, team="red", connected=False))
        db.commit()
        return public_room(db, room, identity.profile.id)


def join_room(db, room_id, identity, password=""):
    with _lock:
        expire_reservations(db)
        room = room_by_id(db, room_id)
        current = member(db, room_id, identity.profile.id)
        if current:
            current.joined_at = datetime.utcnow()
            db.commit()
            return public_room(db, room, identity.profile.id)
        other = db.query(LumaBallRoomMember).join(LumaBallRoom).filter(
            LumaBallRoomMember.profile_id == identity.profile.id, LumaBallRoomMember.left_at.is_(None),
            LumaBallRoom.status.in_(ACTIVE), LumaBallRoom.id != room_id).first()
        if other:
            raise HTTPException(409, "Сначала покиньте другую комнату")
        if room.password_hash and not identity.is_admin and not verify_password(clean_text(password, 64, empty=True), room.password_hash):
            raise HTTPException(403, "Неверный пароль комнаты")
        members = active_members(db, room_id)
        if len(members) >= room.max_players:
            raise HTTPException(409, "Комната заполнена")
        old = db.query(LumaBallRoomMember).filter_by(room_id=room_id, profile_id=identity.profile.id).first()
        team = "spectator" if room.status in ("playing", "paused") else ("red" if sum(m.team == "red" for m, _ in members) <= sum(m.team == "blue" for m, _ in members) else "blue")
        if old:
            old.team, old.left_at, old.connected, old.joined_at = team, None, False, datetime.utcnow()
        else:
            db.add(LumaBallRoomMember(room_id=room_id, profile_id=identity.profile.id, team=team, connected=False))
        db.commit()
        return public_room(db, room, identity.profile.id)


def leave_room(db, room_id, profile_id):
    room = room_by_id(db, room_id, include_closed=True)
    row = member(db, room_id, profile_id)
    if row:
        row.left_at, row.connected = datetime.utcnow(), False
    if room.host_id == profile_id and room.status != "closed":
        close_room(db, room, "host_left")
    db.commit()
    return room


def room_command(db, room_id, identity, data, *, commit=True):
    room = room_by_id(db, room_id)
    own = member(db, room_id, identity.profile.id)
    privileged = identity.is_admin or room.host_id == identity.profile.id
    action = data.get("action")
    if action not in ("start", "pause", "resume", "stop", "reset", "team", "kick"):
        raise HTTPException(422, "Неизвестная команда комнаты")
    if not privileged and not (action == "team" and own and data.get("target", identity.profile.id) == identity.profile.id and room.status in ("lobby", "finished")):
        raise HTTPException(403, "Управлять матчем может создатель комнаты или администратор")
    if action == "start":
        if room.status in ("playing", "paused"):
            raise HTTPException(409, "Матч уже идёт")
        host = member(db, room.id, room.host_id)
        if host is None or not host.connected:
            raise HTTPException(409, "Дождитесь подключения создателя комнаты")
        roster = active_members(db, room.id)
        # The original game permits training with one player, or a host
        # spectating an empty pitch. Only its simulation host must be ready.
        room.match_id = uuid.uuid4().hex
        room.match_started_at = datetime.utcnow()
        room.red_score = room.blue_score = 0
        room.roster_json = json.dumps([{"id": p.id, "name": p.name, "team": m.team} for m, p in roster], ensure_ascii=False)
        room.status = "playing"
    elif action == "pause":
        if room.status != "playing":
            raise HTTPException(409, "Матч не запущен")
        room.status = "paused"
    elif action == "resume":
        if room.status != "paused":
            raise HTTPException(409, "Матч не на паузе")
        room.status = "playing"
    elif action in ("stop", "reset"):
        room.status = "lobby"
        room.match_id = None
        room.match_started_at = None
        if action == "reset":
            room.red_score = room.blue_score = 0
    elif action in ("team", "kick"):
        target_id = data.get("target", identity.profile.id)
        target = member(db, room.id, target_id)
        if target is None:
            raise HTTPException(404, "Игрока нет в комнате")
        if action == "kick":
            if target_id == room.host_id:
                raise HTTPException(409, "Чтобы убрать создателя, закройте комнату")
            target.left_at, target.connected = datetime.utcnow(), False
        else:
            team = data.get("team")
            if team not in TEAMS:
                raise HTTPException(422, "Неизвестная команда")
            target.team = team
    room.updated_at = datetime.utcnow()
    if commit:
        db.commit()
    else:
        db.flush()
    return room


def save_result(db, room, identity, data):
    if room.host_id != identity.profile.id:
        raise HTTPException(403, "Результат отправляет только создатель матча")
    match_id = data.get("match_id")
    if not match_id or match_id != room.match_id:
        raise HTTPException(409, "Этот матч уже завершён или заменён")
    previous = db.get(LumaBallMatch, match_id)
    if previous:
        return previous
    if room.status not in ("playing", "paused"):
        raise HTTPException(409, "Матч не запущен")
    red, blue = data.get("red"), data.get("blue")
    duration = data.get("duration_seconds", 0)
    max_score, max_duration, _ = match_bounds(room)
    if type(red) is not int or type(blue) is not int or not 0 <= red <= max_score or not 0 <= blue <= max_score or type(duration) is not int or not 0 <= duration <= max_duration:
        raise HTTPException(422, "Недопустимый результат")
    room.status, room.red_score, room.blue_score = "finished", red, blue
    result = LumaBallMatch(id=match_id, room_id=room.id, room_name=room.name, host_id=room.host_id,
                          red_score=red, blue_score=blue, duration_seconds=duration,
                          participants_json=room.roster_json, started_at=room.match_started_at or room.updated_at, finished_at=datetime.utcnow())
    db.add(result)
    db.commit()
    return result


def public_match(row):
    return {"id": row.id, "room_id": row.room_id, "room_name": row.room_name,
            "red_score": row.red_score, "blue_score": row.blue_score, "score": {"red": row.red_score, "blue": row.blue_score},
            "duration_seconds": row.duration_seconds, "participants": json.loads(row.participants_json),
            "started_at": _iso(row.started_at), "finished_at": _iso(row.finished_at), "verified": False}


def stats(db):
    return {"rooms_active": db.query(LumaBallRoom).filter(LumaBallRoom.status.in_(ACTIVE)).count(),
            "players_online": db.query(LumaBallRoomMember).filter_by(connected=True, left_at=None).count(),
            "matches_total": db.query(LumaBallMatch).count(), "guests_total": db.query(LumaBallProfile).filter_by(kind="guest").count(),
            "members_total": db.query(LumaBallProfile).filter_by(kind="user").count()}
