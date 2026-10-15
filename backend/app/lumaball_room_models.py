"""LumaBall shares QStudy's SQLite, migrations, account lifecycle and backups."""
from datetime import datetime
from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from app.database import Base


class LumaBallRoom(Base):
    __tablename__ = "lumaball_rooms"
    id = Column(String(32), primary_key=True)
    name = Column(String(80), nullable=False)
    host_id = Column(String(32), ForeignKey("lumaball_profiles.id", ondelete="SET NULL"), nullable=True, index=True)
    password_hash = Column(String(512), nullable=False, default="")
    status = Column(String(20), nullable=False, default="lobby", index=True)
    max_players = Column(Integer, nullable=False, default=8)
    score_limit = Column(Integer, nullable=False, default=5)
    time_limit = Column(Integer, nullable=False, default=5)
    red_score = Column(Integer, nullable=False, default=0)
    blue_score = Column(Integer, nullable=False, default=0)
    match_id = Column(String(32), nullable=True)
    match_started_at = Column(DateTime, nullable=True)
    roster_json = Column(Text, nullable=False, default="[]")
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    closed_reason = Column(String(60), nullable=False, default="")


class LumaBallRoomMember(Base):
    __tablename__ = "lumaball_room_members"
    __table_args__ = (UniqueConstraint("room_id", "profile_id", name="uq_lumaball_room_member"),)
    id = Column(Integer, primary_key=True)
    room_id = Column(String(32), ForeignKey("lumaball_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    profile_id = Column(String(32), ForeignKey("lumaball_profiles.id", ondelete="CASCADE"), nullable=False, index=True)
    team = Column(String(12), nullable=False, default="spectator")
    connected = Column(Boolean, nullable=False, default=False)
    joined_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    left_at = Column(DateTime, nullable=True)


class LumaBallMatch(Base):
    __tablename__ = "lumaball_matches"
    id = Column(String(32), primary_key=True)
    room_id = Column(String(32), ForeignKey("lumaball_rooms.id", ondelete="SET NULL"), nullable=True)
    room_name = Column(String(80), nullable=False)
    host_id = Column(String(32), ForeignKey("lumaball_profiles.id", ondelete="SET NULL"), nullable=True)
    red_score = Column(Integer, nullable=False)
    blue_score = Column(Integer, nullable=False)
    duration_seconds = Column(Integer, nullable=False, default=0)
    participants_json = Column(Text, nullable=False, default="[]")
    started_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=False, default=datetime.utcnow, index=True)


class LumaBallChatMessage(Base):
    __tablename__ = "lumaball_chat_messages"
    id = Column(Integer, primary_key=True)
    room_id = Column(String(32), ForeignKey("lumaball_rooms.id", ondelete="CASCADE"), nullable=False, index=True)
    profile_id = Column(String(32), ForeignKey("lumaball_profiles.id", ondelete="SET NULL"), nullable=True)
    name = Column(String(80), nullable=False)
    text = Column(String(280), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
