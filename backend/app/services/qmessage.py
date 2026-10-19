"""Database-backed messaging rules, privacy serializers and safe image decoding."""
import hashlib
import io
import json
import warnings
from datetime import datetime

from fastapi import HTTPException
from PIL import Image, ImageOps, UnidentifiedImageError
from sqlalchemy import func, or_, text

from app.models import AcademicSetting, StudentGroup, User
from app.qmessage_models import (QMessageAttachment, QMessageBan, QMessageBlock, QMessageConversation,
                                QMessageEvent, QMessageMember, QMessageMessage, QMessageReaction,
                                QMessageSetting, QMessageSticker)

DEFAULTS = {"enabled": True, "title": "QMessage", "announcement": ""}
REACTIONS = {"👍", "❤️", "😂", "🎉", "😮", "😢", "👏", "🔥"}
BUILTIN_STICKERS = (("wave", "Привет", "👋"), ("heart", "С любовью", "❤️"),
                    ("spark", "Отлично", "✨"), ("party", "Праздник", "🎉"),
                    ("laugh", "Смешно", "😂"), ("study", "Учимся", "📚"),
                    ("goal", "Гол", "⚽"), ("thanks", "Спасибо", "🙏"))


def initialize_qmessage(db):
    """Seed the catalog once; never undo an administrator's edits or removals."""
    if db.get(QMessageSetting, "catalog_initialized") is not None:
        return
    for position, (identifier, label, emoji) in enumerate(BUILTIN_STICKERS):
        if db.get(QMessageSticker, identifier) is None:
            db.add(QMessageSticker(id=identifier, label=label, emoji=emoji, position=position, builtin=True))
    db.add(QMessageSetting(key="catalog_initialized", value="true"))
    db.commit()


def config(db):
    values = dict(DEFAULTS)
    for row in db.query(QMessageSetting).filter(QMessageSetting.key.in_(DEFAULTS)).all():
        try:
            value = json.loads(row.value)
        except ValueError:
            continue
        if type(value) is type(DEFAULTS[row.key]):
            values[row.key] = value
    from app.services import branding
    branding_reader = getattr(branding, "message_branding", None)
    return {**values, **(branding_reader(db) if branding_reader else {
        "logo_url": "/brand/qmessage-prototype.svg", "logo_custom": False})}


def enabled(db):
    if not config(db)["enabled"]:
        raise HTTPException(503, "QMessage временно отключён администратором")


def lock_write(db):
    # SQLite takes a reserved write lock even if this no-op matches zero rows.
    # Serialize read/check/write to prevent duplicate sends and stale block/read races.
    if db.get_bind().dialect.name == "sqlite":
        db.execute(text("UPDATE qmessage_settings SET value=value WHERE key='catalog_initialized'"))


def allowed_to_send(db, user_id):
    enabled(db)
    ban = db.get(QMessageBan, user_id)
    if ban is not None:
        raise HTTPException(403, "Отправка сообщений ограничена администратором" + (": " + ban.reason if ban.reason else ""))


def public_user(db, user_id):
    user = db.get(User, user_id)
    if user is None:
        return {"id": user_id, "name": "Удалённый аккаунт", "group_name": "", "avatar_url": None, "online": False}
    group = db.get(StudentGroup, user.group_id) if user.group_id else None
    return {"id": user.id, "name": user.name or "Пользователь Q-ID", "group_name": group.name if group else "",
            "avatar_url": None, "online": False}


def conversation(db, identifier, user_id):
    row = db.get(QMessageConversation, identifier)
    if row is None or user_id not in (row.user_low, row.user_high):
        # Administrators have no implicit access to private correspondence.
        raise HTTPException(404, "Переписка не найдена")
    return row


def peer_id(row, user_id):
    return row.user_high if row.user_low == user_id else row.user_low


def check_contact(db, row, user_id):
    allowed_to_send(db, user_id)
    other = db.get(User, peer_id(row, user_id))
    if other is None or not other.is_active:
        raise HTTPException(403, "Аккаунт собеседника недоступен")
    if db.get(QMessageBan, other.id) is not None:
        raise HTTPException(403, "Собеседник временно не может получать сообщения")
    if db.get(QMessageBlock, (user_id, other.id)) or db.get(QMessageBlock, (other.id, user_id)):
        raise HTTPException(403, "Переписка с этим пользователем заблокирована")


def member(db, row, user_id):
    return db.get(QMessageMember, (row.id, user_id))


def is_typing(db, row, user_id):
    other = member(db, row, peer_id(row, user_id))
    if db.get(QMessageBlock, (user_id, peer_id(row, user_id))) or db.get(QMessageBlock, (peer_id(row, user_id), user_id)):
        return False
    return bool(other and other.typing_until and other.typing_until > datetime.utcnow())


def sticker_public(row):
    return {"id": row.id, "label": row.label, "emoji": row.emoji, "active": row.active,
            "position": row.position, "builtin": row.builtin,
            "image_url": (f"/api/qmessage/stickers/{row.id}/image" if row.image_payload else
                          f"/qmessage-stickers/{row.id}.svg" if row.builtin and row.id in {item[0] for item in BUILTIN_STICKERS} else None)}


def attachment_public(row):
    return {"id": row.id, "url": f"/api/qmessage/attachments/{row.id}", "filename": row.filename,
            "content_type": "image/png", "size_bytes": len(row.payload), "width": row.width, "height": row.height}


def timestamp(value):
    return value.isoformat() + "Z" if value else None


def message_public(db, row):
    deleted = row.deleted_at is not None
    sticker = db.get(QMessageSticker, row.sticker_id) if row.sticker_id and not deleted else None
    attachment = db.get(QMessageAttachment, row.attachment_id) if row.attachment_id and not deleted else None
    reply = db.get(QMessageMessage, row.reply_to_id) if row.reply_to_id else None
    reactions = {}
    if not deleted:
        for reaction in db.query(QMessageReaction).filter_by(message_id=row.id).order_by(QMessageReaction.user_id):
            reactions.setdefault(reaction.emoji, []).append(reaction.user_id)
    return {"id": row.id, "conversation_id": row.conversation_id, "author_id": row.author_id,
            "text": "" if deleted else row.text, "sticker_id": None if deleted else row.sticker_id,
            "sticker": sticker_public(sticker) if sticker else None,
            "attachment": attachment_public(attachment) if attachment else None,
            "reply_to_id": row.reply_to_id,
            "reply_to": {"id": reply.id, "author_id": reply.author_id, "text": "" if reply.deleted_at else reply.text,
                         "sticker_id": None if reply.deleted_at else reply.sticker_id,
                         "deleted": reply.deleted_at is not None} if reply and reply.conversation_id == row.conversation_id else None,
            "client_id": row.client_id, "created_at": timestamp(row.created_at), "edited_at": timestamp(row.edited_at),
            "deleted": deleted,
            "reactions": [{"emoji": emoji, "count": len(ids), "user_ids": ids} for emoji, ids in reactions.items()]}


def conversation_public(db, row, user_id):
    other_id = peer_id(row, user_id)
    own = member(db, row, user_id)
    other = member(db, row, other_id)
    last = db.query(QMessageMessage).filter_by(conversation_id=row.id).order_by(QMessageMessage.id.desc()).first()
    read_id = own.read_message_id if own else 0
    unread = db.query(QMessageMessage).filter(QMessageMessage.conversation_id == row.id,
        QMessageMessage.id > read_id, QMessageMessage.author_id != user_id, QMessageMessage.deleted_at.is_(None)).count()
    return {"id": row.id, "peer": public_user(db, other_id), "last_message": message_public(db, last) if last else None,
            "unread_count": unread, "read_message_id": read_id,
            "peer_read_message_id": other.read_message_id if other else 0,
            "blocked_by_me": db.get(QMessageBlock, (user_id, other_id)) is not None,
            "blocked_by_peer": db.get(QMessageBlock, (other_id, user_id)) is not None,
            "updated_at": timestamp(row.updated_at), "typing": is_typing(db, row, user_id)}


def emit(db, row, event_type, message_id=None, recipients=None):
    for user_id in (recipients if recipients is not None else (row.user_low, row.user_high)):
        db.add(QMessageEvent(user_id=user_id, conversation_id=row.id if row else None,
                            message_id=message_id, type=event_type))


def cursor(db, user_id):
    return db.query(func.max(QMessageEvent.id)).filter_by(user_id=user_id).scalar() or 0


def fingerprint(data):
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def delete_message(db, row):
    if row.deleted_at is not None:
        return
    attachment = db.get(QMessageAttachment, row.attachment_id) if row.attachment_id else None
    row.text = ""; row.sticker_id = None; row.attachment_id = None; row.fingerprint = ""
    row.deleted_at = datetime.utcnow()
    db.query(QMessageReaction).filter_by(message_id=row.id).delete(synchronize_session=False)
    if attachment is not None:
        db.delete(attachment)
    # Replies and reports resolve the current row rather than retaining text snapshots.
    parent = db.get(QMessageConversation, row.conversation_id)
    parent.updated_at = datetime.utcnow()
    emit(db, parent, "message.deleted", row.id)


def normalize_image(data, *, limit=6 * 1024 * 1024, allow_webp=True):
    if not data or len(data) > limit:
        raise HTTPException(413, f"Изображение должно занимать не более {limit // 1024 // 1024} МБ")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(data)) as source:
                if source.format not in ({"PNG", "JPEG", "WEBP"} if allow_webp else {"PNG", "JPEG"}):
                    raise HTTPException(422, "Поддерживаются PNG, JPEG и WebP" if allow_webp else "Поддерживаются PNG и JPEG")
                width, height = source.size
                if width < 1 or height < 1 or width > 4096 or height > 4096 or width * height > 4 * 1024 * 1024:
                    raise HTTPException(422, "Изображение: до 4096 пикселей по стороне и до 4 мегапикселей")
                if getattr(source, "n_frames", 1) != 1:
                    raise HTTPException(422, "Анимированные изображения не поддерживаются")
                source.verify()
            with Image.open(io.BytesIO(data)) as source:
                pixels = ImageOps.exif_transpose(source).convert("RGBA")
                clean = Image.new("RGBA", pixels.size)
                clean.paste(pixels)
                output = io.BytesIO(); clean.save(output, "PNG", compress_level=6)
                payload = output.getvalue()
        if len(payload) > limit:
            raise HTTPException(413, "После обработки изображение слишком большое. Уменьшите его размер")
        return payload, clean.width, clean.height
    except HTTPException:
        raise
    except (UnidentifiedImageError, OSError, SyntaxError, ValueError, Image.DecompressionBombError,
            Image.DecompressionBombWarning) as error:
        raise HTTPException(422, "Не удалось прочитать изображение") from error
