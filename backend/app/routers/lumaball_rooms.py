"""Bounded room/result APIs and audited administrator game management."""
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.orm import Session

from app.auth import hash_password, require_admin
from app.database import get_db
from app.lumaball_room_models import LumaBallChatMessage, LumaBallMatch, LumaBallRoom
from app.security import rate_limit
from app.services.audit import record_audit
from app.services.lumaball_identity import get_config, resolve_identity
from app.lumaball_models import utcnow
from app.services import lumaball_rooms as rooms

router = APIRouter(tags=["lumaball"])


def _hub():
    # Real-time uses the same room service, so defer this import until a
    # mutation needs to notify already connected clients.
    from app.services.lumaball_realtime import hub
    return hub


class RoomCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(default="", max_length=64)
    max_players: int | None = Field(default=None, ge=2, le=20)
    score_limit: int | None = Field(default=None, ge=0, le=20)
    time_limit: int | None = Field(default=None, ge=0, le=30)


class RoomJoin(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    password: str = Field(default="", max_length=64)


class RoomUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str | None = Field(default=None, min_length=1, max_length=80)
    password: str | None = Field(default=None, max_length=64)
    max_players: int | None = Field(default=None, ge=2, le=20)
    score_limit: int | None = Field(default=None, ge=0, le=20)
    time_limit: int | None = Field(default=None, ge=0, le=30)


class RoomCommand(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    action: Literal["start", "pause", "resume", "stop", "reset", "team", "kick"]
    target: str | None = Field(default=None, pattern=r"^[a-f0-9]{32}$")
    team: Literal["red", "blue", "spectator"] | None = None


def _room_list(db, *, admin=False, offset=0, limit=100, q=""):
    query = db.query(LumaBallRoom).filter(LumaBallRoom.status.in_(rooms.ACTIVE))
    if q.strip():
        term = "%" + q.strip().replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(LumaBallRoom.name.ilike(term, escape="\\"))
    total = query.count()
    values = query.order_by(LumaBallRoom.created_at.desc(), LumaBallRoom.id).offset(offset).limit(limit).all()
    result = {"items": [rooms.public_room(db, room, full=admin) for room in values], "total": total}
    if admin:
        result.update(offset=offset, limit=limit)
    return result


@router.get("/lumaball/rooms")
def public_rooms(q: str = Query(default="", max_length=80), db: Session = Depends(get_db)):
    return _room_list(db, q=q)


@router.post("/lumaball/rooms", status_code=201)
async def create_room(data: RoomCreate, request: Request, db: Session = Depends(get_db)):
    identity = resolve_identity(request, db)
    rate_limit("lumaball-create:" + identity.profile.id, 6, 60)
    result = rooms.create_room(db, identity, data.model_dump(exclude_none=True))
    await _hub().publish_room(result["id"])
    return result


@router.get("/lumaball/rooms/{room_id}")
def room_detail(room_id: str, request: Request, db: Session = Depends(get_db)):
    identity = resolve_identity(request, db)
    room = rooms.room_by_id(db, room_id)
    if not identity.is_admin and rooms.member(db, room_id, identity.profile.id) is None:
        return {**rooms.public_room(db, room, full=False), "members": [], "chat": [], "is_member": False}
    return rooms.public_room(db, room, identity.profile.id)


@router.post("/lumaball/rooms/{room_id}/join")
async def join_room(room_id: str, request: Request, data: RoomJoin | None = Body(default=None),
                    db: Session = Depends(get_db)):
    identity = resolve_identity(request, db)
    rate_limit("lumaball-join:" + identity.profile.id, 20, 60)
    result = rooms.join_room(db, room_id, identity, data.password if data else "")
    await _hub().publish_room(room_id)
    return result


@router.post("/lumaball/rooms/{room_id}/leave")
async def leave_room(room_id: str, request: Request, db: Session = Depends(get_db)):
    identity = resolve_identity(request, db)
    room = rooms.leave_room(db, room_id, identity.profile.id)
    await _hub().disconnect_profile(identity.profile.id, "left_room")
    if room.status == "closed":
        await _hub().close_room(room_id, "host_left")
    else:
        await _hub().publish_room(room_id)
    return {"ok": True}


@router.get("/lumaball/stats")
def public_stats(db: Session = Depends(get_db)):
    values = rooms.stats(db)
    return {key: values[key] for key in ("rooms_active", "players_online", "matches_total")}


def _matches(db, *, limit=20, offset=0):
    query = db.query(LumaBallMatch)
    total = query.count()
    values = query.order_by(LumaBallMatch.finished_at.desc(), LumaBallMatch.id).offset(offset).limit(limit).all()
    return {"items": [rooms.public_match(row) for row in values], "total": total, "offset": offset, "limit": limit}


@router.get("/lumaball/matches")
def public_matches(limit: int = Query(default=10, ge=1, le=30), offset: int = Query(default=0, ge=0),
                   db: Session = Depends(get_db)):
    return _matches(db, limit=limit, offset=offset)


@router.get("/admin/lumaball/stats")
def admin_stats(db: Session = Depends(get_db), admin=Depends(require_admin)):
    return rooms.stats(db)


@router.get("/admin/lumaball/rooms")
def admin_rooms(q: str = Query(default="", max_length=80), limit: int = Query(default=30, ge=1, le=100),
                offset: int = Query(default=0, ge=0), db: Session = Depends(get_db), admin=Depends(require_admin)):
    return _room_list(db, admin=True, q=q, offset=offset, limit=limit)


@router.patch("/admin/lumaball/rooms/{room_id}")
async def update_room(room_id: str, data: RoomUpdate, db: Session = Depends(get_db), admin=Depends(require_admin)):
    room = rooms.room_by_id(db, room_id)
    values = data.model_dump(exclude_unset=True)
    if not values or any(value is None for value in values.values()):
        raise HTTPException(422, "Укажите изменяемые поля без пустых значений")
    if room.status in ("playing", "paused") and set(values) - {"name"}:
        raise HTTPException(409, "Сначала остановите матч, чтобы изменить его лимиты или пароль")
    if "max_players" in values:
        if values["max_players"] > get_config(db)["max_players"]:
            raise HTTPException(422, "Количество игроков превышает предел в настройках LumaBall")
        if values["max_players"] < len(rooms.active_members(db, room.id)):
            raise HTTPException(409, "В комнате больше игроков, чем указано в новом лимите")
    for key, value in values.items():
        if key == "name":
            room.name = rooms.clean_text(value, 80)
        elif key == "password":
            password = rooms.clean_text(value, 64, empty=True)
            room.password_hash = hash_password(password) if password else ""
        else:
            setattr(room, key, value)
    room.updated_at = utcnow()
    record_audit(db, admin, "lumaball.room.update", "lumaball_room", room.id, fields=values.keys())
    db.commit()
    await _hub().publish_room(room.id)
    return rooms.public_room(db, room)


@router.delete("/admin/lumaball/rooms/{room_id}")
async def delete_room(room_id: str, db: Session = Depends(get_db), admin=Depends(require_admin)):
    room = rooms.room_by_id(db, room_id, include_closed=True)
    if room.status != "closed":
        rooms.close_room(db, room, "administrator")
        record_audit(db, admin, "lumaball.room.close", "lumaball_room", room.id)
        db.commit()
    await _hub().close_room(room.id, "administrator")
    return {"ok": True}


@router.post("/admin/lumaball/rooms/{room_id}/command")
async def command_room(room_id: str, data: RoomCommand, request: Request,
                       db: Session = Depends(get_db), admin=Depends(require_admin)):
    identity = resolve_identity(request, db)
    room = rooms.room_command(db, room_id, identity, data.model_dump(exclude_none=True), commit=False)
    record_audit(db, admin, "lumaball.room." + data.action, "lumaball_room", room.id,
                 fields=("team",) if data.action == "team" else ())
    db.commit()
    if data.action == "kick" and data.target:
        await _hub().disconnect_profile(data.target, "kicked")
    await _hub().publish_room(room.id)
    return rooms.public_room(db, room, identity.profile.id)


@router.delete("/admin/lumaball/rooms/{room_id}/chat")
async def clear_chat(room_id: str, db: Session = Depends(get_db), admin=Depends(require_admin)):
    room = rooms.room_by_id(db, room_id, include_closed=True)
    count = db.query(LumaBallChatMessage).filter_by(room_id=room.id).delete(synchronize_session=False)
    record_audit(db, admin, "lumaball.room.chat_clear", "lumaball_room", room.id, metadata={"count": count})
    db.commit()
    await _hub().publish_room(room.id)
    return {"ok": True, "deleted": count}


@router.get("/admin/lumaball/matches")
def admin_matches(limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
                  db: Session = Depends(get_db), admin=Depends(require_admin)):
    return _matches(db, limit=limit, offset=offset)


@router.delete("/admin/lumaball/matches/{match_id}")
def delete_match(match_id: str, db: Session = Depends(get_db), admin=Depends(require_admin)):
    row = db.get(LumaBallMatch, match_id)
    if row is None:
        raise HTTPException(404, "Матч не найден")
    record_audit(db, admin, "lumaball.match.delete", "lumaball_match", row.id)
    db.delete(row)
    db.commit()
    return {"ok": True}
