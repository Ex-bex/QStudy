"""Public LumaBall entry and administrator controls, sharing QStudy auth."""
from typing import Literal

from fastapi import APIRouter, Body, Depends, HTTPException, Query, Request
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator
from sqlalchemy import delete
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.auth import require_admin
from app.database import get_db
from app.lumaball_models import LumaBallProfile, LumaBallSettings, LumaBallTicket
from app.models import BrandingAsset, User
from app.security import client_key, rate_limit
from app.services.audit import record_audit
from app.services.branding import MAX_LOGO_BYTES, normalize_png, put_asset
from app.services.lumaball_identity import (GameSettings, clean_name, get_config,
    get_settings, issue_ticket, profile_public, resolve_identity)

router = APIRouter(tags=["lumaball"])


class Nickname(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str = Field(min_length=2, max_length=32)
    _name = field_validator("name")(clean_name)


class PlayerUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    name: str | None = Field(default=None, min_length=2, max_length=32)
    banned: bool | None = None
    ban_reason: str | None = Field(default=None, max_length=300)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        return clean_name(value) if value is not None else value


def _admin_settings(db):
    return {**get_config(db), "ice_servers": get_settings(db).model_dump()["ice_servers"]}


@router.get("/lumaball/config")
def configuration(db: Session = Depends(get_db)):
    return get_config(db)


@router.post("/lumaball/session")
def session(request: Request, db: Session = Depends(get_db)):
    rate_limit("lumaball-session:" + client_key(request), 30, 60)
    identity = resolve_identity(request, db, create_guest=True)
    response = {"identity": identity.public(), "config": get_config(db),
                "ws_ticket": issue_ticket(identity, db),
                "ice_servers": get_settings(db).model_dump()["ice_servers"]}
    if identity.guest_token:
        # The same-origin BFF strips this field into its HttpOnly guest cookie.
        response["guest_token"] = identity.guest_token
    db.commit()
    return response


@router.get("/lumaball/me")
def me(request: Request, db: Session = Depends(get_db)):
    identity = resolve_identity(request, db)
    db.commit()
    return {"identity": identity.public(), "config": get_config(db)}


@router.patch("/lumaball/me")
def change_nickname(data: Nickname, request: Request, db: Session = Depends(get_db)):
    identity = resolve_identity(request, db)
    if identity.profile.kind != "user":
        raise HTTPException(403, "Номер гостя назначается автоматически. Для своего имени войдите в QStudy")
    rate_limit("lumaball-nickname:" + identity.profile.id, 10, 60)
    identity.profile.name = data.name
    db.commit()
    return {"identity": identity.public(), "config": get_config(db)}


@router.get("/lumaball/logo")
def public_logo(request: Request, db: Session = Depends(get_db)):
    asset = db.get(BrandingAsset, "lumaball")
    if asset is None:
        raise HTTPException(404, "Логотип LumaBall пока не загружен")
    headers = {"Cache-Control": "no-cache", "ETag": f'"{asset.digest}"', "X-Content-Type-Options": "nosniff"}
    if request.headers.get("if-none-match") == headers["ETag"]:
        return Response(status_code=304, headers=headers)
    return Response(asset.payload, media_type="image/png", headers=headers)


@router.get("/admin/lumaball/settings")
def admin_settings(db: Session = Depends(get_db), admin=Depends(require_admin)):
    return _admin_settings(db)


@router.patch("/admin/lumaball/settings")
def update_settings(changes: dict = Body(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    # Validation is performed on the complete merged document: omitted fields
    # survive, while explicit nulls, unknown keys and invalid limits are rejected.
    try:
        values = GameSettings.model_validate({**get_settings(db).model_dump(), **changes})
    except ValidationError as error:
        raise HTTPException(422, [{"loc": list(item["loc"]), "msg": item["msg"], "type": item["type"]}
                                  for item in error.errors()])
    row = db.get(LumaBallSettings, "site")
    if row is None:
        row = LumaBallSettings(key="site")
        db.add(row)
    row.value_json = values.model_dump_json()
    record_audit(db, admin, "lumaball.settings.update", "lumaball_settings", "site", fields=changes.keys())
    db.commit()
    return _admin_settings(db)


@router.get("/admin/lumaball/players")
def players(q: str = Query(default="", max_length=120), kind: Literal["user", "guest"] | None = None,
            limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
            db: Session = Depends(get_db), admin=Depends(require_admin)):
    query = db.query(LumaBallProfile)
    if q.strip():
        term = "%" + q.strip().replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(LumaBallProfile.name.ilike(term, escape="\\"))
    if kind:
        query = query.filter(LumaBallProfile.kind == kind)
    total = query.count()
    items = query.order_by(LumaBallProfile.last_seen_at.desc(), LumaBallProfile.id).offset(offset).limit(limit).all()
    return {"items": [profile_public(row, db, administration=True) for row in items],
            "total": total, "offset": offset, "limit": limit}


@router.patch("/admin/lumaball/players/{profile_id}")
def update_player(profile_id: str, changes: PlayerUpdate, db: Session = Depends(get_db), admin=Depends(require_admin)):
    profile = db.get(LumaBallProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "Игрок не найден")
    values = changes.model_dump(exclude_unset=True)
    if not values or any(value is None for value in values.values()):
        raise HTTPException(422, "Укажите изменяемые поля без пустых значений")
    if "name" in values and profile.kind == "guest":
        raise HTTPException(422, "Гостевой номер назначается автоматически")
    user = db.get(User, profile.user_id) if profile.user_id is not None else None
    if values.get("banned") and user and user.is_active and user.role == "admin":
        raise HTTPException(409, "Нельзя заблокировать администратора QStudy в игре")
    for key, value in values.items():
        setattr(profile, key, value.strip() if key == "ban_reason" else value)
    if values.get("banned") is False:
        profile.ban_reason = ""
    if profile.banned:
        db.execute(delete(LumaBallTicket).where(LumaBallTicket.profile_id == profile.id))
    record_audit(db, admin, "lumaball.player.update", "lumaball_profile", profile.id, fields=values.keys())
    db.commit()
    return profile_public(profile, db, administration=True)


@router.put("/admin/lumaball/logo")
async def upload_logo(request: Request, db: Session = Depends(get_db), admin=Depends(require_admin)):
    if request.headers.get("content-type", "").lower().startswith("multipart/form-data"):
        async with request.form(max_files=1, max_fields=0, max_part_size=MAX_LOGO_BYTES + 1) as data:
            file = data.get("file")
            if file is None or not hasattr(file, "read"):
                raise HTTPException(422, "Выберите PNG-файл")
            payload = await file.read(MAX_LOGO_BYTES + 1)
    else:
        content = bytearray()
        async for chunk in request.stream():
            content.extend(chunk)
            if len(content) > MAX_LOGO_BYTES:
                raise HTTPException(413, "PNG должен занимать не более 2 МБ")
        payload = bytes(content)
    logo = await run_in_threadpool(normalize_png, payload)
    put_asset(db, "lumaball", logo, admin.id)
    record_audit(db, admin, "lumaball.logo.upload", "lumaball_settings", "site",
                 fields=("logo",), metadata={"size_bytes": len(logo.payload)})
    db.commit()
    return get_config(db)


@router.delete("/admin/lumaball/players/{profile_id}")
def delete_player(profile_id: str, db: Session = Depends(get_db), admin=Depends(require_admin)):
    profile = db.get(LumaBallProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "Игрок не найден")
    if profile.user_id == admin.id:
        raise HTTPException(409, "Нельзя удалить собственный активный игровой профиль")
    # This removes only game identity/credentials. A QStudy account, password,
    # study materials and personal work are deliberately outside this action.
    record_audit(db, admin, "lumaball.player.delete", "lumaball_profile", profile.id)
    db.delete(profile)
    db.commit()
    return {"ok": True, "account_preserved": True}


@router.delete("/admin/lumaball/logo")
def reset_logo(db: Session = Depends(get_db), admin=Depends(require_admin)):
    asset = db.get(BrandingAsset, "lumaball")
    if asset:
        db.delete(asset)
    record_audit(db, admin, "lumaball.logo.reset", "lumaball_settings", "site", fields=("logo",))
    db.commit()
    return get_config(db)
