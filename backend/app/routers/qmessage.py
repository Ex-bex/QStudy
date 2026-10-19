"""Private direct messages with durable long-poll events and scoped moderation."""
import asyncio
import json
import re
import time
from datetime import datetime, timedelta
from pathlib import PurePath
from typing import Literal
from urllib.parse import quote
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field, model_validator
from sqlalchemy import or_
from sqlalchemy.orm import Session
from starlette.concurrency import run_in_threadpool

from app.auth import get_current_user, oauth2_scheme, require_admin
from app.database import get_db
from app.models import User
from app.qmessage_models import (QMessageAttachment, QMessageBan, QMessageBlock, QMessageConversation,
                                QMessageEvent, QMessageMember, QMessageMessage, QMessageReaction,
                                QMessageReport, QMessageSetting, QMessageSticker)
from app.services import qmessage as service
from app.services.audit import record_audit

router = APIRouter(tags=["QMessage"])


class Input(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class StartInput(Input):
    user_id: int = Field(strict=True, gt=0)


class SendInput(Input):
    text: str = Field(default="", max_length=4000)
    client_id: UUID
    sticker_id: str | None = Field(default=None, min_length=1, max_length=60)
    reply_to_id: int | None = Field(default=None, strict=True, gt=0)
    attachment_id: int | None = Field(default=None, strict=True, gt=0)

    @model_validator(mode="after")
    def not_empty(self):
        if not self.text and not self.sticker_id and not self.attachment_id:
            raise ValueError("Введите сообщение, выберите стикер или изображение")
        return self


class EditInput(Input):
    text: str = Field(max_length=4000)


class ReadInput(Input):
    message_id: int = Field(strict=True, gt=0)


class ReactionInput(Input):
    emoji: str | None = Field(default=None, max_length=16)


class BlockInput(Input):
    blocked: bool = Field(strict=True)


class ReportInput(Input):
    reason: str = Field(min_length=1, max_length=1000)


class TypingInput(Input):
    typing: bool = Field(default=True, strict=True)


class BanInput(Input):
    banned: bool = Field(strict=True)
    reason: str = Field(default="", max_length=500)


class ResolveInput(Input):
    delete_message: bool = Field(default=False, strict=True)


class SettingsInput(Input):
    enabled: bool | None = Field(default=None, strict=True)
    title: str | None = Field(default=None, min_length=1, max_length=120)
    announcement: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def partial(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Укажите изменяемые настройки")
        return self


class StickerInput(Input):
    id: str = Field(pattern=r"^[a-z][a-z0-9_-]{0,59}$")
    label: str = Field(min_length=1, max_length=80)
    emoji: str = Field(default="", max_length=16)
    active: bool = Field(default=True, strict=True)
    position: int = Field(default=0, strict=True, ge=0, le=10000)


class StickerUpdate(Input):
    label: str | None = Field(default=None, min_length=1, max_length=80)
    emoji: str | None = Field(default=None, max_length=16)
    active: bool | None = Field(default=None, strict=True)
    position: int | None = Field(default=None, strict=True, ge=0, le=10000)

    @model_validator(mode="after")
    def partial(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Укажите изменяемые поля стикера")
        return self


def _owned_message(db, identifier, user_id, *, author=False):
    row = db.get(QMessageMessage, identifier)
    if row is None:
        raise HTTPException(404, "Сообщение не найдено")
    parent = service.conversation(db, row.conversation_id, user_id)
    if author and row.author_id != user_id:
        raise HTTPException(403, "Изменить сообщение может только его автор")
    return row, parent


def _image_response(row):
    return Response(row.payload, media_type="image/png", headers={"Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline; filename=\"image.png\"; filename*=UTF-8''" + quote(row.filename, safe="")})


@router.get("/qmessage/config")
def config(db: Session = Depends(get_db)):
    return service.config(db)


@router.get("/qmessage/users")
def search_users(q: str = Query(default="", max_length=100), db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.allowed_to_send(db, user.id)
    query = q.strip().casefold()
    if len(query) < 2:
        return {"items": []}
    results = []
    for row in db.query(User).filter(User.is_active.is_(True), User.id != user.id).order_by(User.id).yield_per(100):
        public = service.public_user(db, row.id)
        if query in public["name"].casefold() or query in public["group_name"].casefold() or query == f"#{row.id}":
            results.append(public)
            if len(results) == 30:
                break
    return {"items": results}


@router.get("/qmessage/conversations")
def list_conversations(db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.enabled(db)
    # Capture the cursor first. A concurrent message is replayed, never skipped.
    cursor = service.cursor(db, user.id)
    rows = db.query(QMessageConversation).filter(or_(QMessageConversation.user_low == user.id,
        QMessageConversation.user_high == user.id)).order_by(QMessageConversation.updated_at.desc(), QMessageConversation.id.desc()).all()
    ban = db.get(QMessageBan, user.id)
    return {"items": [service.conversation_public(db, row, user.id) for row in rows], "cursor": cursor,
            "account": {"banned": ban is not None, "ban_reason": ban.reason if ban else ""}}


@router.post("/qmessage/conversations")
def start_conversation(data: StartInput, response: Response, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db); service.allowed_to_send(db, user.id)
    other = db.get(User, data.user_id)
    if other is None or not other.is_active or other.id == user.id:
        raise HTTPException(404, "Собеседник не найден")
    low, high = sorted((user.id, other.id))
    row = db.query(QMessageConversation).filter_by(user_low=low, user_high=high).first()
    if row is None:
        if any(db.query(QMessageMember).filter_by(user_id=identifier).count() >= 500 for identifier in (user.id, other.id)):
            raise HTTPException(409, "Достигнут лимит 500 переписок")
        row = QMessageConversation(user_low=low, user_high=high)
        service.check_contact(db, row, user.id)
        db.add(row); db.flush()
        db.add_all([QMessageMember(conversation_id=row.id, user_id=identifier) for identifier in (low, high)])
        service.emit(db, row, "conversation.updated")
        db.commit()
        response.status_code = 201
    else:
        service.check_contact(db, row, user.id)
        db.commit()
    return service.conversation_public(db, row, user.id)


@router.get("/qmessage/conversations/{conversation_id}/messages")
def messages(conversation_id: int, before: int | None = Query(default=None, gt=0), q: str = Query(default="", max_length=100),
             limit: int = Query(default=50, ge=1, le=50), db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.enabled(db); parent = service.conversation(db, conversation_id, user.id)
    query = db.query(QMessageMessage).filter_by(conversation_id=parent.id)
    if before is not None:
        query = query.filter(QMessageMessage.id < before)
    term = q.strip().casefold()
    found = []
    for row in query.order_by(QMessageMessage.id.desc()).yield_per(100):
        if term and (row.deleted_at is not None or term not in row.text.casefold()):
            continue
        found.append(row)
        if len(found) > limit:
            break
    has_more = len(found) > limit
    own, other = service.member(db, parent, user.id), service.member(db, parent, service.peer_id(parent, user.id))
    return {"items": [service.message_public(db, row) for row in reversed(found[:limit])], "has_more": has_more,
            "typing": service.is_typing(db, parent, user.id), "read_message_id": own.read_message_id,
            "peer_read_message_id": other.read_message_id}


@router.post("/qmessage/conversations/{conversation_id}/messages")
def send(conversation_id: int, data: SendInput, response: Response, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db)
    parent = service.conversation(db, conversation_id, user.id)
    service.check_contact(db, parent, user.id)
    values = data.model_dump(mode="json")
    digest = service.fingerprint(values)
    previous = db.query(QMessageMessage).filter_by(author_id=user.id, client_id=str(data.client_id)).first()
    if previous is not None:
        if previous.conversation_id != parent.id or (not previous.deleted_at and previous.fingerprint != digest):
            raise HTTPException(409, "Этот идентификатор уже использован для другого сообщения")
        db.commit()
        return service.message_public(db, previous)
    recent = db.query(QMessageMessage).filter(QMessageMessage.author_id == user.id,
        QMessageMessage.created_at > datetime.utcnow() - timedelta(seconds=60)).count()
    if recent >= 90:
        raise HTTPException(429, "Слишком много сообщений. Подождите минуту")
    if data.reply_to_id:
        target = db.get(QMessageMessage, data.reply_to_id)
        if target is None or target.conversation_id != parent.id:
            raise HTTPException(404, "Сообщение для ответа не найдено в этой переписке")
    if data.sticker_id:
        sticker = db.get(QMessageSticker, data.sticker_id)
        if sticker is None or not sticker.active or not (sticker.emoji or sticker.image_payload or sticker.builtin):
            raise HTTPException(422, "Стикер недоступен")
    if data.attachment_id:
        attachment = db.get(QMessageAttachment, data.attachment_id)
        if (attachment is None or attachment.user_id != user.id or attachment.conversation_id != parent.id or
                db.query(QMessageMessage).filter_by(attachment_id=attachment.id).first()):
            raise HTTPException(404, "Изображение для отправки не найдено")
    row = QMessageMessage(conversation_id=parent.id, author_id=user.id, client_id=str(data.client_id), fingerprint=digest,
        text=data.text, sticker_id=data.sticker_id, attachment_id=data.attachment_id, reply_to_id=data.reply_to_id)
    db.add(row); db.flush()
    parent.updated_at = datetime.utcnow()
    own = service.member(db, parent, user.id)
    own.read_message_id = max(own.read_message_id, row.id); own.typing_until = None
    service.emit(db, parent, "message.created", row.id)
    db.commit()
    response.status_code = 201
    return service.message_public(db, row)


@router.patch("/qmessage/messages/{message_id}")
def edit(message_id: int, data: EditInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db)
    row, parent = _owned_message(db, message_id, user.id, author=True)
    service.check_contact(db, parent, user.id)
    if row.deleted_at:
        raise HTTPException(409, "Удалённое сообщение нельзя изменить")
    if not data.text and not row.sticker_id and not row.attachment_id:
        raise HTTPException(422, "Сообщение не должно быть пустым")
    if data.text != row.text:
        row.text = data.text; row.edited_at = datetime.utcnow()
        service.emit(db, parent, "message.updated", row.id)
    db.commit(); return service.message_public(db, row)


@router.delete("/qmessage/messages/{message_id}")
def delete(message_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db)
    row, _parent = _owned_message(db, message_id, user.id, author=True)
    # The author can remove their own old content even after a block or ban.
    service.delete_message(db, row); db.commit()
    return {"ok": True}


@router.post("/qmessage/conversations/{conversation_id}/read")
def read(conversation_id: int, data: ReadInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db); service.enabled(db)
    parent = service.conversation(db, conversation_id, user.id)
    row = db.get(QMessageMessage, data.message_id)
    if row is None or row.conversation_id != parent.id:
        raise HTTPException(404, "Сообщение не найдено в этой переписке")
    own = service.member(db, parent, user.id)
    if data.message_id > own.read_message_id:
        own.read_message_id = data.message_id
        service.emit(db, parent, "conversation.read", data.message_id)
    db.commit(); return {"ok": True, "read_message_id": own.read_message_id}


@router.put("/qmessage/messages/{message_id}/reaction")
def reaction(message_id: int, data: ReactionInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db)
    row, parent = _owned_message(db, message_id, user.id)
    service.check_contact(db, parent, user.id)
    if row.deleted_at:
        raise HTTPException(409, "Сообщение удалено")
    if data.emoji is not None and data.emoji not in service.REACTIONS:
        raise HTTPException(422, "Эта реакция не поддерживается")
    existing = db.get(QMessageReaction, (row.id, user.id))
    if data.emoji is None:
        if existing is not None:
            db.delete(existing)
    elif existing is None:
        db.add(QMessageReaction(message_id=row.id, user_id=user.id, emoji=data.emoji))
    else:
        existing.emoji = data.emoji
    service.emit(db, parent, "message.reaction", row.id)
    db.commit(); return service.message_public(db, row)


@router.put("/qmessage/users/{user_id}/block")
def block(user_id: int, data: BlockInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db); service.enabled(db)
    other = db.get(User, user_id)
    if other is None or other.id == user.id:
        raise HTTPException(404, "Пользователь не найден")
    existing = db.get(QMessageBlock, (user.id, user_id))
    if data.blocked and existing is None:
        db.add(QMessageBlock(user_id=user.id, blocked_user_id=user_id))
    elif not data.blocked and existing is not None:
        db.delete(existing)
    low, high = sorted((user.id, user_id))
    parent = db.query(QMessageConversation).filter_by(user_low=low, user_high=high).first()
    if parent:
        for row in db.query(QMessageMember).filter_by(conversation_id=parent.id):
            row.typing_until = None
        service.emit(db, parent, "conversation.updated")
    db.commit(); return {"ok": True, "blocked": data.blocked}


@router.post("/qmessage/messages/{message_id}/report")
def report(message_id: int, data: ReportInput, response: Response, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db); service.enabled(db)
    row, _parent = _owned_message(db, message_id, user.id)
    if row.author_id == user.id or row.deleted_at:
        raise HTTPException(422, "Можно пожаловаться на сообщение собеседника")
    existing = db.query(QMessageReport).filter_by(message_id=row.id, reporter_id=user.id).first()
    if existing is None:
        existing = QMessageReport(message_id=row.id, reporter_id=user.id, reason=data.reason)
        db.add(existing); db.flush()
        response.status_code = 201
    db.commit(); return {"id": existing.id, "status": existing.status}


@router.post("/qmessage/conversations/{conversation_id}/typing")
def typing(conversation_id: int, data: TypingInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db)
    parent = service.conversation(db, conversation_id, user.id)
    service.check_contact(db, parent, user.id)
    own = service.member(db, parent, user.id)
    now = datetime.utcnow()
    if not data.typing or not own.typing_until or own.typing_until < now + timedelta(seconds=5):
        own.typing_until = now + timedelta(seconds=8) if data.typing else None
        service.emit(db, parent, "typing", recipients=(service.peer_id(parent, user.id),))
    db.commit(); return {"ok": True}


@router.get("/qmessage/conversations/{conversation_id}/typing")
def get_typing(conversation_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.enabled(db); parent = service.conversation(db, conversation_id, user.id)
    return {"typing": service.is_typing(db, parent, user.id)}


def _event_batch(bind, token, after):
    # Each poll owns and closes its own connection before the async wait.
    with Session(bind=bind, expire_on_commit=False) as db:
        user = get_current_user(token=token, db=db)
        service.enabled(db)
        maximum = service.cursor(db, user.id)
        reset = after > maximum
        start = 0 if reset else after
        rows = db.query(QMessageEvent).filter(QMessageEvent.user_id == user.id, QMessageEvent.id > start).order_by(QMessageEvent.id).limit(101).all()
        items = [{"id": row.id, "type": row.type, "conversation_id": row.conversation_id, "message_id": row.message_id} for row in rows[:100]]
        return {"items": items, "cursor": items[-1]["id"] if items else start, "has_more": len(rows) > 100,
                "reset": reset}


@router.get("/qmessage/events")
async def events(after: int = Query(default=0, ge=0), wait: int = Query(default=20, ge=0, le=25),
                 db: Session = Depends(get_db), user=Depends(get_current_user), token=Depends(oauth2_scheme)):
    bind = db.get_bind()
    db.close()
    deadline = time.monotonic() + wait
    while True:
        result = await run_in_threadpool(_event_batch, bind, token, after)
        if result["items"] or result["reset"] or time.monotonic() >= deadline:
            return result
        await asyncio.sleep(min(0.75, max(0.01, deadline - time.monotonic())))


@router.post("/qmessage/conversations/{conversation_id}/attachments", status_code=201)
async def upload_attachment(conversation_id: int, file: UploadFile = File(...), db: Session = Depends(get_db), user=Depends(get_current_user)):
    # Validate before decoding, and check again after awaiting the bounded read.
    parent = service.conversation(db, conversation_id, user.id); service.check_contact(db, parent, user.id)
    try:
        data = await file.read(6 * 1024 * 1024 + 1)
        filename = PurePath((file.filename or "image").replace("\\", "/")).name
    finally:
        await file.close()
    payload, width, height = await run_in_threadpool(service.normalize_image, data)
    service.lock_write(db); db.expire_all()
    parent = service.conversation(db, conversation_id, user.id); service.check_contact(db, parent, user.id)
    from sqlalchemy import func
    used = db.query(func.sum(func.length(QMessageAttachment.payload))).filter_by(user_id=user.id).scalar() or 0
    if used + len(payload) > 100 * 1024 * 1024:
        raise HTTPException(409, "Достигнут лимит изображений 100 МБ. Удалите ненужные сообщения с изображениями")
    filename = re.sub(r"[\x00-\x1f\x7f]", "", filename.rsplit(".", 1)[0])[:140] or "image"
    row = QMessageAttachment(conversation_id=parent.id, user_id=user.id, filename=filename + ".png",
        payload=payload, width=width, height=height)
    db.add(row); db.commit(); return service.attachment_public(row)


@router.get("/qmessage/attachments/{attachment_id}")
def get_attachment(attachment_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.enabled(db)
    row = db.get(QMessageAttachment, attachment_id)
    if row is None:
        raise HTTPException(404, "Изображение не найдено")
    service.conversation(db, row.conversation_id, user.id)
    if row.user_id != user.id and db.query(QMessageMessage).filter_by(attachment_id=row.id).first() is None:
        raise HTTPException(404, "Изображение не отправлено")
    return _image_response(row)


@router.delete("/qmessage/attachments/{attachment_id}")
def delete_draft_attachment(attachment_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.lock_write(db)
    row = db.get(QMessageAttachment, attachment_id)
    if row is None or row.user_id != user.id:
        raise HTTPException(404, "Изображение не найдено")
    service.conversation(db, row.conversation_id, user.id)
    if db.query(QMessageMessage).filter_by(attachment_id=row.id).first() is not None:
        raise HTTPException(409, "Удалите отправленное сообщение, чтобы убрать его изображение")
    db.delete(row); db.commit(); return {"ok": True}


@router.get("/qmessage/stickers")
def stickers(db: Session = Depends(get_db), user=Depends(get_current_user)):
    service.enabled(db)
    return {"items": [service.sticker_public(row) for row in db.query(QMessageSticker).filter_by(active=True).order_by(QMessageSticker.position, QMessageSticker.id)]}


@router.get("/qmessage/stickers/{sticker_id}/image")
def sticker_image(sticker_id: str, db: Session = Depends(get_db)):
    row = db.get(QMessageSticker, sticker_id)
    if row is None or not row.image_payload:
        raise HTTPException(404, "Изображение стикера не найдено")
    return Response(row.image_payload, media_type="image/png", headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@router.get("/admin/qmessage/overview")
def admin_overview(db: Session = Depends(get_db), admin=Depends(require_admin)):
    return {"settings": service.config(db), "stats": {"conversations": db.query(QMessageConversation).count(),
        "messages": db.query(QMessageMessage).count(), "users": db.query(QMessageMember.user_id).distinct().count(),
        "banned_users": db.query(QMessageBan).count(), "open_reports": db.query(QMessageReport).filter_by(status="open").count(),
        "stickers": db.query(QMessageSticker).filter_by(active=True).count()}}


@router.patch("/admin/qmessage/settings")
def admin_settings(data: SettingsInput, db: Session = Depends(get_db), admin=Depends(require_admin)):
    service.lock_write(db)
    for key, value in data.model_dump(exclude_unset=True).items():
        row = db.get(QMessageSetting, key)
        if row is None:
            db.add(QMessageSetting(key=key, value=json.dumps(value, ensure_ascii=False)))
        else:
            row.value = json.dumps(value, ensure_ascii=False)
    record_audit(db, admin, "qmessage.settings.update", "qmessage", "settings", fields=data.model_fields_set)
    for user_id, in db.query(QMessageMember.user_id).distinct():
        service.emit(db, None, "account.updated", recipients=(user_id,))
    db.commit(); return service.config(db)


@router.get("/admin/qmessage/users")
def admin_users(q: str = Query(default="", max_length=100), db: Session = Depends(get_db), admin=Depends(require_admin)):
    term = q.strip().casefold(); items = []
    for row in db.query(User).order_by(User.id).yield_per(100):
        public = service.public_user(db, row.id)
        if term and term not in public["name"].casefold() and term not in public["group_name"].casefold() and term != str(row.id):
            continue
        ban = db.get(QMessageBan, row.id)
        items.append({**public, "role": row.role, "is_active": row.is_active, "banned": ban is not None, "ban_reason": ban.reason if ban else ""})
        if len(items) == 100:
            break
    return {"items": items}


@router.patch("/admin/qmessage/users/{user_id}/ban")
def admin_ban(user_id: int, data: BanInput, db: Session = Depends(get_db), admin=Depends(require_admin)):
    service.lock_write(db)
    if db.get(User, user_id) is None:
        raise HTTPException(404, "Аккаунт не найден")
    ban = db.get(QMessageBan, user_id)
    if data.banned:
        if ban is None:
            db.add(QMessageBan(user_id=user_id, reason=data.reason))
        else:
            ban.reason = data.reason
    elif ban is not None:
        db.delete(ban)
    db.query(QMessageMember).filter_by(user_id=user_id).update({"typing_until": None}, synchronize_session=False)
    service.emit(db, None, "account.updated", recipients=(user_id,))
    record_audit(db, admin, "qmessage.user.ban" if data.banned else "qmessage.user.unban", "user", user_id, fields=("messaging_ban",))
    db.commit(); return {"id": user_id, "banned": data.banned, "ban_reason": data.reason if data.banned else ""}


@router.get("/admin/qmessage/reports")
def admin_reports(status: Literal["open", "resolved", "all"] = "open", db: Session = Depends(get_db), admin=Depends(require_admin)):
    query = db.query(QMessageReport)
    if status != "all":
        query = query.filter_by(status=status)
    items = []
    for report in query.order_by(QMessageReport.id.desc()).limit(100):
        message = db.get(QMessageMessage, report.message_id)
        content = service.message_public(db, message) if message else None
        if content:
            # A report never grants the moderator access to reply text or chat history.
            content["reply_to"] = None
            if content["attachment"]:
                content["attachment"]["url"] = f"/api/admin/qmessage/reports/{report.id}/attachment"
        items.append({"id": report.id, "message_id": report.message_id, "conversation_id": message.conversation_id if message else None,
            "reporter": service.public_user(db, report.reporter_id), "author": service.public_user(db, message.author_id) if message else None,
            "reason": report.reason, "status": report.status, "created_at": service.timestamp(report.created_at),
            "resolved_at": service.timestamp(report.resolved_at), "message": content})
    return {"items": items}


@router.get("/admin/qmessage/reports/{report_id}/attachment")
def admin_report_image(report_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    report = db.get(QMessageReport, report_id)
    message = db.get(QMessageMessage, report.message_id) if report else None
    attachment = db.get(QMessageAttachment, message.attachment_id) if message and not message.deleted_at and message.attachment_id else None
    if attachment is None:
        raise HTTPException(404, "Изображение из жалобы не найдено")
    return _image_response(attachment)


@router.post("/admin/qmessage/reports/{report_id}/resolve")
def admin_resolve(report_id: int, data: ResolveInput, db: Session = Depends(get_db), admin=Depends(require_admin)):
    service.lock_write(db)
    report = db.get(QMessageReport, report_id)
    if report is None:
        raise HTTPException(404, "Жалоба не найдена")
    if data.delete_message:
        message = db.get(QMessageMessage, report.message_id)
        if message:
            service.delete_message(db, message)
    report.status = "resolved"; report.resolved_at = datetime.utcnow()
    record_audit(db, admin, "qmessage.report.resolve", "qmessage_report", report.id,
                 fields=("status", "message_deleted") if data.delete_message else ("status",))
    db.commit(); return {"id": report.id, "status": report.status}


@router.get("/admin/qmessage/stickers")
def admin_stickers(db: Session = Depends(get_db), admin=Depends(require_admin)):
    return {"items": [service.sticker_public(row) for row in db.query(QMessageSticker).order_by(QMessageSticker.position, QMessageSticker.id)]}


@router.post("/admin/qmessage/stickers", status_code=201)
def admin_create_sticker(data: StickerInput, db: Session = Depends(get_db), admin=Depends(require_admin)):
    service.lock_write(db)
    if db.get(QMessageSticker, data.id) is not None:
        raise HTTPException(409, "Стикер с таким ID уже существует")
    if db.query(QMessageSticker).count() >= 200:
        raise HTTPException(409, "Достигнут лимит 200 стикеров")
    row = QMessageSticker(**data.model_dump())
    db.add(row)
    record_audit(db, admin, "qmessage.sticker.create", "qmessage_sticker", row.id, fields=("label", "emoji", "active", "position"))
    db.commit(); return service.sticker_public(row)


def _sticker(db, sticker_id):
    row = db.get(QMessageSticker, sticker_id)
    if row is None:
        raise HTTPException(404, "Стикер не найден")
    return row


@router.patch("/admin/qmessage/stickers/{sticker_id}")
def admin_edit_sticker(sticker_id: str, data: StickerUpdate, db: Session = Depends(get_db), admin=Depends(require_admin)):
    service.lock_write(db); row = _sticker(db, sticker_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(row, key, value)
    record_audit(db, admin, "qmessage.sticker.update", "qmessage_sticker", row.id, fields=data.model_fields_set)
    db.commit(); return service.sticker_public(row)


@router.delete("/admin/qmessage/stickers/{sticker_id}")
def admin_delete_sticker(sticker_id: str, db: Session = Depends(get_db), admin=Depends(require_admin)):
    service.lock_write(db); row = _sticker(db, sticker_id); row.active = False
    record_audit(db, admin, "qmessage.sticker.disable", "qmessage_sticker", row.id, fields=("active",))
    db.commit(); return {"ok": True}


@router.put("/admin/qmessage/stickers/{sticker_id}/image")
async def admin_upload_sticker(sticker_id: str, file: UploadFile = File(...), db: Session = Depends(get_db), admin=Depends(require_admin)):
    _sticker(db, sticker_id)
    try:
        data = await file.read(2 * 1024 * 1024 + 1)
    finally:
        await file.close()
    payload, _width, _height = await run_in_threadpool(service.normalize_image, data, limit=2 * 1024 * 1024, allow_webp=False)
    service.lock_write(db); row = _sticker(db, sticker_id); row.image_payload = payload
    record_audit(db, admin, "qmessage.sticker.image.upload", "qmessage_sticker", row.id, fields=("image",), metadata={"size_bytes": len(payload)})
    db.commit(); return service.sticker_public(row)


@router.delete("/admin/qmessage/stickers/{sticker_id}/image")
def admin_reset_sticker(sticker_id: str, db: Session = Depends(get_db), admin=Depends(require_admin)):
    service.lock_write(db); row = _sticker(db, sticker_id); row.image_payload = None
    record_audit(db, admin, "qmessage.sticker.image.reset", "qmessage_sticker", row.id, fields=("image",))
    db.commit(); return service.sticker_public(row)
