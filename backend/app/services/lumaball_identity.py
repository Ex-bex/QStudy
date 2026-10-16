"""Shared-account identities and narrowly scoped, revocable guest sessions."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
import hashlib
import json
import re
import secrets
import unicodedata
from urllib.parse import urlsplit
import uuid

from fastapi import HTTPException, Request
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator
from sqlalchemy import delete
from sqlalchemy.exc import IntegrityError

from app.auth import get_current_user
from app.config import settings
from app.lumaball_models import (LumaBallGuestCredential, LumaBallProfile,
                                 LumaBallSettings, LumaBallTicket, utcnow)
from app.models import AcademicSetting, BrandingAsset, User

GUEST_SESSION_DAYS = 30
TICKET_SECONDS = 60
_TOKEN = re.compile(r"^[A-Za-z0-9_-]{40,128}$")


def clean_name(value: str) -> str:
    value = " ".join(unicodedata.normalize("NFKC", value).split())
    if not 2 <= len(value) <= 32 or any(unicodedata.category(c).startswith("C") for c in value):
        raise ValueError("Имя игрока: от 2 до 32 видимых символов")
    if value.casefold().startswith("guest#"):
        raise ValueError("Имена guest# с номером назначаются гостям автоматически")
    return value


class IceServer(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    urls: list[str] = Field(min_length=1, max_length=4)
    username: str = Field(default="", max_length=120)
    credential: str = Field(default="", max_length=300)

    @field_validator("urls")
    @classmethod
    def valid_urls(cls, values):
        for value in values:
            if not 6 <= len(value) <= 500 or any(c.isspace() or ord(c) < 32 for c in value):
                raise ValueError("Некорректный адрес STUN/TURN")
            scheme, _, remainder = value.partition(":")
            if scheme not in {"stun", "stuns", "turn", "turns"} or remainder.startswith("//"):
                raise ValueError("Разрешены адреса stun:, stuns:, turn: и turns:")
            parsed = urlsplit("//" + remainder)
            try:
                port = parsed.port
            except ValueError as error:
                raise ValueError("Некорректный порт STUN/TURN") from error
            if (not parsed.hostname or parsed.username or parsed.password or parsed.path
                    or parsed.fragment or (port is not None and not 1 <= port <= 65535)
                    or parsed.query not in {"", "transport=udp", "transport=tcp"}):
                raise ValueError("Некорректный адрес STUN/TURN")
        return values


class GameSettings(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    enabled: bool = True
    title: str = Field(default="QBall", min_length=1, max_length=60)
    description: str = Field(default="Футбол в браузере. Быстрые матчи, своя команда и один точный удар.", max_length=500)
    announcement: str = Field(default="", max_length=300)
    rules: str = Field(default="Играйте честно, уважайте соперников и не мешайте другим участникам. Управление: WASD или стрелки, пробел — удар.", max_length=5000)
    guests_enabled: bool = True
    guest_create_rooms: bool = True
    max_rooms: int = Field(default=20, ge=1, le=100)
    max_players: int = Field(default=20, ge=2, le=20)
    default_players: int = Field(default=2, ge=2, le=20)
    # Original LumaBall counts score/time until the host stops the game.
    # Saved positive administrator limits remain optional match rules.
    score_limit: int = Field(default=0, ge=0, le=20)
    time_limit: int = Field(default=0, ge=0, le=30)
    chat_enabled: bool = True
    ice_servers: list[IceServer] = Field(default_factory=lambda: [IceServer(urls=["stun:stun.l.google.com:19302"])], max_length=5)

    @field_validator("title")
    @classmethod
    def visible_title(cls, value):
        if not value.strip():
            raise ValueError("Укажите название")
        return value.strip()

    @model_validator(mode="after")
    def players_within_limit(self):
        if self.default_players > self.max_players:
            raise ValueError("Число игроков по умолчанию превышает максимум")
        return self


def upgrade_default_brand(db) -> bool:
    """Rename the original default without replacing administrator settings."""
    row = db.get(LumaBallSettings, "site")
    if row is None:
        return False
    try:
        values = json.loads(row.value_json)
    except (ValueError, TypeError):
        return False
    if not isinstance(values, dict) or values.get("title") != "LumaBall":
        return False
    values["title"] = "QBall"
    row.value_json = json.dumps(values, ensure_ascii=False)
    return True


def get_settings(db) -> GameSettings:
    row = db.get(LumaBallSettings, "site")
    try:
        return GameSettings.model_validate(json.loads(row.value_json)) if row else GameSettings()
    except (ValueError, TypeError):
        raise HTTPException(503, "Настройки QBall повреждены. Обратитесь к администратору")


def get_config(db) -> dict:
    values = get_settings(db).model_dump(exclude={"ice_servers"})
    asset = db.get(BrandingAsset, "lumaball")
    values["logo_url"] = f"/api/lumaball/logo?v={asset.digest}" if asset else None
    # Invite links must use the launcher's address, never a browser-supplied Host.
    values["public_base_url"] = settings.PUBLIC_BASE_URL.rstrip("/")
    return values


def _stamp(value):
    return value.isoformat() + "Z" if value else None


def profile_public(profile, db, *, administration=False):
    user = db.get(User, profile.user_id) if profile.user_id is not None else None
    value = {"id": profile.id, "name": profile.name, "kind": profile.kind,
             "is_admin": bool(user and user.is_active and user.role == "admin")}
    if profile.kind == "user" and profile.user_id is not None:
        value["user_id"] = profile.user_id
    if administration:
        value.update(user_id=profile.user_id, banned=profile.banned, ban_reason=profile.ban_reason,
                     created_at=_stamp(profile.created_at), updated_at=_stamp(profile.updated_at),
                     last_seen_at=_stamp(profile.last_seen_at))
    return value


@dataclass
class Identity:
    profile: LumaBallProfile
    is_admin: bool
    user: User | None = None
    guest_token: str | None = None
    token_version: int | None = None
    issued_at: datetime = field(default_factory=utcnow)

    def public(self):
        value = {"id": self.profile.id, "name": self.profile.name,
                 "kind": self.profile.kind, "is_admin": self.is_admin}
        if self.user is not None:
            value["user_id"] = self.user.id
        return value


def _check_profile(profile, db, *, expected_version=None):
    if profile is None:
        raise HTTPException(401, "Игровая сессия истекла. Войдите снова")
    user = db.get(User, profile.user_id) if profile.user_id is not None else None
    if profile.kind == "user" and (user is None or not user.is_active
                                  or (expected_version is not None and user.token_version != expected_version)):
        raise HTTPException(401, "Сессия QStudy завершена. Войдите снова")
    if profile.banned:
        raise HTTPException(403, "Доступ к QBall ограничен администратором")
    admin = bool(user and user.role == "admin" and user.is_active)
    config = get_settings(db)
    if not config.enabled and not admin:
        raise HTTPException(503, "QBall временно закрыт администратором")
    if profile.kind == "guest" and not config.guests_enabled:
        raise HTTPException(403, "Гостевой вход отключён. Войдите в QStudy")
    return Identity(profile, admin, user, token_version=user.token_version if user else None)


def validate_identity(identity: Identity, db) -> Identity:
    """Revalidate an established game connection against current server policy."""
    profile_id = identity.profile.id
    db.expire_all()
    if not _after_restore_cutoff(identity.issued_at, db):
        raise HTTPException(401, "Игровая сессия отозвана после восстановления данных")
    return _check_profile(db.get(LumaBallProfile, profile_id), db,
                          expected_version=identity.token_version)


def _after_restore_cutoff(created_at, db):
    cutoff = db.get(AcademicSetting, "auth_min_iat")
    if cutoff is None:
        return True
    try:
        return created_at.replace(tzinfo=timezone.utc).timestamp() > float(cutoff.value)
    except (ValueError, TypeError, OverflowError):
        return False


def _user_profile(db, user):
    profile = db.query(LumaBallProfile).filter(LumaBallProfile.user_id == user.id).first()
    if profile is None:
        try:
            name = clean_name(user.name or "")
        except ValueError:
            name = f"Игрок #{user.id}"
        profile = LumaBallProfile(id=uuid.uuid4().hex, user_id=user.id, kind="user", name=name)
        db.add(profile)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            profile = db.query(LumaBallProfile).filter(LumaBallProfile.user_id == user.id).one()
    return profile


def _digest(value):
    return hashlib.sha256(value.encode("ascii")).hexdigest()


def _create_guest(db):
    for _ in range(20):
        number = secrets.randbelow(900000) + 100000
        profile = LumaBallProfile(id=uuid.uuid4().hex, kind="guest", guest_number=number, name=f"guest#{number}")
        token = secrets.token_urlsafe(32)
        try:
            with db.begin_nested():
                db.add(profile)
                db.flush()
                db.add(LumaBallGuestCredential(digest=_digest(token), profile_id=profile.id,
                                             expires_at=utcnow() + timedelta(days=GUEST_SESSION_DAYS)))
                db.flush()
            identity = _check_profile(profile, db)
            identity.guest_token = token
            return identity
        except IntegrityError:
            continue
    raise HTTPException(503, "Не удалось создать гостевой профиль. Попробуйте позже")


def resolve_identity(request: Request, db, create_guest=False) -> Identity:
    authorization = request.headers.get("authorization")
    if authorization is not None:
        scheme, _, token = authorization.partition(" ")
        if scheme.casefold() != "bearer" or not token:
            raise HTTPException(401, "Сессия QStudy недействительна")
        user = get_current_user(token, db)
        return _check_profile(_user_profile(db, user), db)
    guest = request.headers.get("x-lumaball-session", "")
    if guest:
        credential = db.get(LumaBallGuestCredential, _digest(guest)) if _TOKEN.fullmatch(guest) else None
        if (credential is None or credential.expires_at <= utcnow()
                or not _after_restore_cutoff(credential.created_at, db)):
            raise HTTPException(401, "Гостевая сессия истекла. Откройте QBall заново")
        return _check_profile(db.get(LumaBallProfile, credential.profile_id), db)
    if not create_guest:
        raise HTTPException(401, "Начните игру или войдите в QStudy")
    config = get_settings(db)
    if not config.enabled:
        raise HTTPException(503, "QBall временно закрыт администратором")
    if not config.guests_enabled:
        raise HTTPException(403, "Гостевой вход отключён. Войдите в QStudy")
    return _create_guest(db)


def issue_ticket(identity: Identity, db) -> str:
    _check_profile(identity.profile, db)
    token = secrets.token_urlsafe(32)
    now = utcnow()
    db.query(LumaBallTicket).filter(LumaBallTicket.expires_at <= now).delete(synchronize_session=False)
    db.query(LumaBallGuestCredential).filter(LumaBallGuestCredential.expires_at <= now).delete(synchronize_session=False)
    db.add(LumaBallTicket(digest=_digest(token), profile_id=identity.profile.id,
                         user_token_version=identity.user.token_version if identity.user else None,
                         expires_at=now + timedelta(seconds=TICKET_SECONDS)))
    identity.profile.last_seen_at = now
    db.flush()
    return token


def consume_ticket(ticket: str, db) -> Identity:
    if not isinstance(ticket, str) or not _TOKEN.fullmatch(ticket):
        raise HTTPException(401, "Игровой билет недействителен")
    result = db.execute(delete(LumaBallTicket).where(
        LumaBallTicket.digest == _digest(ticket), LumaBallTicket.expires_at > utcnow()).returning(
            LumaBallTicket.profile_id, LumaBallTicket.user_token_version, LumaBallTicket.created_at)).first()
    # Commit the atomic consumption before any policy check; rejected tickets
    # cannot be replayed, including after a ban or account removal.
    db.commit()
    if result is None:
        raise HTTPException(401, "Игровой билет истёк или уже использован")
    if not _after_restore_cutoff(result.created_at, db):
        raise HTTPException(401, "Игровой билет отозван после восстановления данных")
    identity = _check_profile(db.get(LumaBallProfile, result.profile_id), db,
                              expected_version=result.user_token_version)
    identity.issued_at = result.created_at
    return identity
