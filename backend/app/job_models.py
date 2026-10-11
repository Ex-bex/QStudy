"""Durable, owner-scoped AI queue; payloads and checkpoints stay private."""
from datetime import datetime
from sqlalchemy import Column, DateTime, ForeignKey, Index, Integer, String, Text
from app.database import Base


class AIJob(Base):
    __tablename__ = "ai_jobs"
    __table_args__ = (Index("ix_ai_job_queue", "status", "available_at"),)

    id = Column(String(32), primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    kind = Column(String(60), nullable=False)
    title = Column(String(300), nullable=False)
    status = Column(String(20), nullable=False, default="queued", index=True)
    resource_key = Column(String(200), nullable=True)
    # NULL after completion. A unique live key prevents concurrent generation
    # for the same resource without preventing later intentional regeneration.
    active_key = Column(String(64), nullable=True, unique=True)
    payload_json = Column(Text, nullable=False, default="{}")
    checkpoint_json = Column(Text, nullable=False, default="{}")
    result_json = Column(Text, nullable=False, default="{}")
    error = Column(String(300), nullable=False, default="")
    attempts = Column(Integer, nullable=False, default=0)
    max_attempts = Column(Integer, nullable=False, default=3)
    available_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    lease_owner = Column(String(100), nullable=True)
    lease_expires_at = Column(DateTime, nullable=True)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)
    acknowledged_at = Column(DateTime, nullable=True)
