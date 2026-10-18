"""Private Word question banks and immutable QTests attempts in the common DB."""
from datetime import datetime

from sqlalchemy import Column, DateTime, ForeignKey, Integer, LargeBinary, String, Text
from sqlalchemy.orm import relationship

from app.database import Base


class QTestsBank(Base):
    __tablename__ = "qtests_banks"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    filename = Column(String(200), nullable=False, default="")
    answer_mode = Column(String(20), nullable=False, default="marked")
    status = Column(String(20), nullable=False, default="importing")
    error = Column(String(500), nullable=False, default="")
    warnings_json = Column(Text, nullable=False, default="[]")
    source_payload = Column(LargeBinary, nullable=False, default=b"")
    job_id = Column(String(64), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)
    questions = relationship("QTestsBankQuestion", cascade="all, delete-orphan", order_by="QTestsBankQuestion.position")


class QTestsBankQuestion(Base):
    __tablename__ = "qtests_bank_questions"
    id = Column(Integer, primary_key=True)
    bank_id = Column(Integer, ForeignKey("qtests_banks.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False, default=0)
    question = Column(Text, nullable=False)
    options_json = Column(Text, nullable=False)
    correct_index = Column(Integer, nullable=False)
    explanation = Column(Text, nullable=False, default="")


class QTestsAttempt(Base):
    __tablename__ = "qtests_attempts"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    bank_id = Column(Integer, ForeignKey("qtests_banks.id", ondelete="SET NULL"), nullable=True, index=True)
    bank_title = Column(String(200), nullable=False)
    status = Column(String(20), nullable=False, default="active")
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    finished_at = Column(DateTime, nullable=True)
    questions = relationship("QTestsAttemptQuestion", cascade="all, delete-orphan", order_by="QTestsAttemptQuestion.position")


class QTestsAttemptQuestion(Base):
    __tablename__ = "qtests_attempt_questions"
    id = Column(Integer, primary_key=True)
    attempt_id = Column(Integer, ForeignKey("qtests_attempts.id", ondelete="CASCADE"), nullable=False, index=True)
    position = Column(Integer, nullable=False)
    question = Column(Text, nullable=False)
    options_json = Column(Text, nullable=False)
    correct_index = Column(Integer, nullable=False)
    user_index = Column(Integer, nullable=True)
    explanation = Column(Text, nullable=False, default="")
    explanation_status = Column(String(20), nullable=False, default="source")


class QTestsSetting(Base):
    __tablename__ = "qtests_settings"
    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=False, default="")
