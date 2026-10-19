"""Additive private direct messaging tables in the existing Q-ID database."""
from datetime import datetime

from sqlalchemy import (Boolean, CheckConstraint, Column, DateTime, ForeignKey,
                        Index, Integer, LargeBinary, String, Text, UniqueConstraint)

from app.database import Base


class QMessageSetting(Base):
    __tablename__ = "qmessage_settings"
    key = Column(String(80), primary_key=True)
    value = Column(Text, nullable=False)


class QMessageConversation(Base):
    __tablename__ = "qmessage_conversations"
    __table_args__ = (UniqueConstraint("user_low", "user_high"), CheckConstraint("user_low < user_high"))
    id = Column(Integer, primary_key=True)
    user_low = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    user_high = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class QMessageMember(Base):
    __tablename__ = "qmessage_members"
    conversation_id = Column(Integer, ForeignKey("qmessage_conversations.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    # A monotone integer survives deletion of old messages without dangling FKs.
    read_message_id = Column(Integer, nullable=False, default=0)
    typing_until = Column(DateTime, nullable=True)


class QMessageAttachment(Base):
    __tablename__ = "qmessage_attachments"
    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey("qmessage_conversations.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    filename = Column(String(160), nullable=False)
    payload = Column(LargeBinary, nullable=False)
    width = Column(Integer, nullable=False)
    height = Column(Integer, nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class QMessageMessage(Base):
    __tablename__ = "qmessage_messages"
    __table_args__ = (UniqueConstraint("author_id", "client_id"),
                     Index("ix_qmessage_history", "conversation_id", "id"))
    id = Column(Integer, primary_key=True)
    conversation_id = Column(Integer, ForeignKey("qmessage_conversations.id", ondelete="CASCADE"), nullable=False)
    author_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    client_id = Column(String(36), nullable=False)
    fingerprint = Column(String(64), nullable=False, default="")
    text = Column(Text, nullable=False, default="")
    sticker_id = Column(String(60), ForeignKey("qmessage_stickers.id", ondelete="SET NULL"), nullable=True)
    attachment_id = Column(Integer, ForeignKey("qmessage_attachments.id", ondelete="SET NULL"), nullable=True, unique=True)
    reply_to_id = Column(Integer, ForeignKey("qmessage_messages.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    edited_at = Column(DateTime, nullable=True)
    deleted_at = Column(DateTime, nullable=True)


class QMessageReaction(Base):
    __tablename__ = "qmessage_reactions"
    message_id = Column(Integer, ForeignKey("qmessage_messages.id", ondelete="CASCADE"), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    emoji = Column(String(16), nullable=False)


class QMessageEvent(Base):
    __tablename__ = "qmessage_events"
    __table_args__ = (Index("ix_qmessage_recipient_cursor", "user_id", "id"), {"sqlite_autoincrement": True})
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    conversation_id = Column(Integer, ForeignKey("qmessage_conversations.id", ondelete="CASCADE"), nullable=True)
    message_id = Column(Integer, ForeignKey("qmessage_messages.id", ondelete="CASCADE"), nullable=True)
    type = Column(String(40), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class QMessageBlock(Base):
    __tablename__ = "qmessage_blocks"
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    blocked_user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)


class QMessageBan(Base):
    __tablename__ = "qmessage_bans"
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    reason = Column(String(500), nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)


class QMessageReport(Base):
    __tablename__ = "qmessage_reports"
    __table_args__ = (UniqueConstraint("message_id", "reporter_id"),)
    id = Column(Integer, primary_key=True)
    message_id = Column(Integer, ForeignKey("qmessage_messages.id", ondelete="CASCADE"), nullable=False, index=True)
    reporter_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    reason = Column(String(1000), nullable=False)
    status = Column(String(20), nullable=False, default="open")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    resolved_at = Column(DateTime, nullable=True)


class QMessageSticker(Base):
    __tablename__ = "qmessage_stickers"
    id = Column(String(60), primary_key=True)
    label = Column(String(80), nullable=False)
    emoji = Column(String(16), nullable=False, default="")
    active = Column(Boolean, nullable=False, default=True)
    position = Column(Integer, nullable=False, default=0)
    builtin = Column(Boolean, nullable=False, default=False)
    image_payload = Column(LargeBinary, nullable=True)
