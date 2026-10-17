"""QCareer records share QStudy's Base, users and curriculum; no separate database."""
from datetime import datetime

from sqlalchemy import Boolean, Column, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint

from app.database import Base


class CareerSettings(Base):
    __tablename__ = "career_settings"
    id = Column(Integer, primary_key=True)
    initialized = Column(Boolean, nullable=False, default=True)
    enabled = Column(Boolean, nullable=False, default=True)
    title = Column(String(120), nullable=False, default="QCareer")
    description = Column(Text, nullable=False, default="От учебных результатов к профессии и дальнейшему образованию")
    announcement = Column(Text, nullable=False, default="")


class CareerSkill(Base):
    __tablename__ = "career_skills"
    id = Column(Integer, primary_key=True)
    slug = Column(String(100), nullable=False, unique=True)
    name = Column(String(160), nullable=False)
    description = Column(Text, nullable=False, default="")
    category = Column(String(120), nullable=False, default="")
    is_active = Column(Boolean, nullable=False, default=True)


class CareerDirection(Base):
    __tablename__ = "career_directions"
    id = Column(Integer, primary_key=True)
    slug = Column(String(100), nullable=False, unique=True)
    title = Column(String(160), nullable=False)
    description = Column(Text, nullable=False, default="")
    category = Column(String(120), nullable=False, default="")
    study_paths_json = Column(Text, nullable=False, default="[]")
    career_paths_json = Column(Text, nullable=False, default="[]")
    requirements_json = Column(Text, nullable=False, default="[]")
    is_active = Column(Boolean, nullable=False, default=True)


class CareerLearningLink(Base):
    __tablename__ = "career_learning_links"
    id = Column(Integer, primary_key=True)
    skill_id = Column(Integer, ForeignKey("career_skills.id", ondelete="CASCADE"), nullable=False, index=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    module = Column(String(200), nullable=False, default="")
    week_number = Column(Integer, nullable=True)
    work_id = Column(Integer, ForeignKey("module_works.id", ondelete="CASCADE"), nullable=True)
    syllabus_id = Column(Integer, ForeignKey("syllabus_documents.id", ondelete="CASCADE"), nullable=True)
    title = Column(String(200), nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    target_level = Column(Integer, nullable=False, default=1)
    min_score = Column(Integer, nullable=False, default=70)
    prerequisites_json = Column(Text, nullable=False, default="[]")
    is_active = Column(Boolean, nullable=False, default=True)


class CareerProfile(Base):
    __tablename__ = "career_profiles"
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    target_direction_id = Column(Integer, ForeignKey("career_directions.id", ondelete="SET NULL"), nullable=True)
    interests_json = Column(Text, nullable=False, default="[]")
    about = Column(Text, nullable=False, default="")
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class CareerOpportunity(Base):
    __tablename__ = "career_opportunities"
    id = Column(Integer, primary_key=True)
    title = Column(String(200), nullable=False)
    organization = Column(String(200), nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    kind = Column(String(20), nullable=False, default="study")
    url = Column(String(2000), nullable=False, default="")
    location = Column(String(200), nullable=False, default="")
    direction_id = Column(Integer, ForeignKey("career_directions.id", ondelete="SET NULL"), nullable=True)
    published_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    is_active = Column(Boolean, nullable=False, default=True)


class CareerSavedOpportunity(Base):
    __tablename__ = "career_saved_opportunities"
    __table_args__ = (UniqueConstraint("user_id", "opportunity_id", name="uq_career_saved_user_opportunity"),)
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    opportunity_id = Column(Integer, ForeignKey("career_opportunities.id", ondelete="CASCADE"), nullable=False)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
