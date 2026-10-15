"""LumaBall records share QStudy's engine, accounts, and backup lifecycle."""
from datetime import datetime, timezone

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text

from app.database import Base


def utcnow():
    return datetime.now(timezone.utc).replace(tzinfo=None)


class LumaBallProfile(Base):
    __tablename__ = "lumaball_profiles"
    id = Column(String(32), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), unique=True, nullable=True, index=True)
    kind = Column(String(10), nullable=False)
    name = Column(String(32), nullable=False)
    guest_number = Column(Integer, unique=True, nullable=True)
    banned = Column(Boolean, nullable=False, default=False)
    ban_reason = Column(String(300), nullable=False, default="")
    created_at = Column(DateTime, nullable=False, default=utcnow)
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)
    last_seen_at = Column(DateTime, nullable=False, default=utcnow)


class LumaBallSettings(Base):
    __tablename__ = "lumaball_settings"
    key = Column(String(20), primary_key=True)
    value_json = Column(Text, nullable=False, default="{}")
    updated_at = Column(DateTime, nullable=False, default=utcnow, onupdate=utcnow)


class LumaBallGuestCredential(Base):
    __tablename__ = "lumaball_guest_credentials"
    digest = Column(String(64), primary_key=True)
    profile_id = Column(String(32), ForeignKey("lumaball_profiles.id", ondelete="CASCADE"), nullable=False, index=True)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)


class LumaBallTicket(Base):
    __tablename__ = "lumaball_tickets"
    digest = Column(String(64), primary_key=True)
    profile_id = Column(String(32), ForeignKey("lumaball_profiles.id", ondelete="CASCADE"), nullable=False, index=True)
    user_token_version = Column(Integer, nullable=True)
    expires_at = Column(DateTime, nullable=False, index=True)
    created_at = Column(DateTime, nullable=False, default=utcnow)
