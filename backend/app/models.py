from sqlalchemy import (Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Float, UniqueConstraint, LargeBinary)
from sqlalchemy.orm import relationship
from datetime import datetime
from app.database import Base


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, index=True)
    email = Column(String, unique=True, index=True, nullable=False)
    hashed_password = Column(String, nullable=False) # type: ignore
    name = Column(String(120), nullable=False, default="")
    role = Column(String(20), nullable=False, default="student")
    is_active = Column(Boolean, nullable=False, default=True)
    token_version = Column(Integer, nullable=False, default=0)
    group_id = Column(Integer, ForeignKey("student_groups.id"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow) # type: ignore


class Subject(Base):
    __tablename__ = "subjects"
    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    name = Column(String, nullable=False)
    description = Column(Text, default="")
    color = Column(String, default="#6366f1")
    created_at = Column(DateTime, default=datetime.utcnow)
    topics = relationship("Topic", back_populates="subject", cascade="all, delete-orphan")


class Topic(Base):
    __tablename__ = "topics"
    id = Column(Integer, primary_key=True, index=True)
    subject_id = Column(Integer, ForeignKey("subjects.id"))
    title = Column(String, nullable=False)
    description = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    subject = relationship("Subject", back_populates="topics")


class Material(Base):
    __tablename__ = "materials"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    subject_id = Column(Integer, ForeignKey("subjects.id"), nullable=True)
    topic_id = Column(Integer, ForeignKey("topics.id"), nullable=True)
    filename = Column(String)
    filepath = Column(String)
    file_type = Column(String)
    size = Column(Integer)
    extracted_text = Column(Text, default="")
    processed = Column(Boolean, default=False)
    created_at = Column(DateTime, default=datetime.utcnow)


class Note(Base):
    __tablename__ = "notes"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    subject_id = Column(Integer, ForeignKey("subjects.id"), nullable=True)
    topic_id = Column(Integer, ForeignKey("topics.id"), nullable=True)
    title = Column(String, default="Без названия")
    content = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Task(Base):
    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    subject_id = Column(Integer, ForeignKey("subjects.id"), nullable=True)
    topic_id = Column(Integer, ForeignKey("topics.id"), nullable=True)
    question = Column(Text, nullable=False)
    answer = Column(Text, default="")
    hint = Column(Text, default="")
    difficulty = Column(String, default="medium")
    status = Column(String, default="new")
    user_answer = Column(Text, default="")
    source_context_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)


class ChatSession(Base):
    __tablename__ = "chat_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    title = Column(String, default="Новый чат")
    created_at = Column(DateTime, default=datetime.utcnow)

    messages = relationship("ChatMessage", back_populates="session",
                            cascade="all, delete-orphan")


class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("chat_sessions.id"))
    role = Column(String)
    content = Column(Text)
    source_context_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)

    session = relationship("ChatSession", back_populates="messages")


class ExamSession(Base):
    __tablename__ = "exam_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    subject_id = Column(Integer, ForeignKey("subjects.id"), nullable=True)
    topic_id = Column(Integer, ForeignKey("topics.id"), nullable=True)
    subject_ids_json = Column(Text, default="")   # JSON: [1, 3] — несколько предметов
    topic_ids_json = Column(Text, default="")
    source_context_json = Column(Text, default="{}")
    difficulty = Column(String, default="medium")
    status = Column(String, default="active")
    summary = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)

    questions = relationship("ExamQuestion", back_populates="session",
                             cascade="all, delete-orphan",
                             order_by="ExamQuestion.order")


class ExamQuestion(Base):
    __tablename__ = "exam_questions"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("exam_sessions.id"))
    order = Column(Integer, default=0)
    question = Column(Text, nullable=False)
    reference = Column(Text, default="")
    user_answer = Column(Text, default="")
    verdict = Column(String, default="")
    score = Column(Integer, default=0)
    feedback = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)

    session = relationship("ExamSession", back_populates="questions")

class TestSession(Base):
    __tablename__ = "test_sessions"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    subject_ids_json = Column(Text, default="")
    topic_ids_json = Column(Text, default="")
    source_context_json = Column(Text, default="{}")
    difficulty = Column(String, default="medium")
    status = Column(String, default="active")
    score = Column(Integer, default=0)
    summary = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)
    finished_at = Column(DateTime, nullable=True)

    questions = relationship("TestQuestion", back_populates="session",
                             cascade="all, delete-orphan",
                             order_by="TestQuestion.order")


class TestQuestion(Base):
    __tablename__ = "test_questions"

    id = Column(Integer, primary_key=True, index=True)
    session_id = Column(Integer, ForeignKey("test_sessions.id"))
    order = Column(Integer, default=0)
    question = Column(Text, nullable=False)
    options = Column(Text, default="")
    correct_index = Column(Integer, default=0)
    user_index = Column(Integer, nullable=True)
    explanation = Column(Text, default="")
    created_at = Column(DateTime, default=datetime.utcnow)

    session = relationship("TestSession", back_populates="questions")


class Lecture(Base):
    __tablename__ = "lectures"
    __table_args__ = (UniqueConstraint("user_id", "topic_id", name="uq_lecture_user_topic"),)

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    topic_id = Column(Integer, ForeignKey("topics.id"))
    content = Column(Text, default="")
    status = Column(String, default="empty")
    materials_hash = Column(String, default="")
    source_context_json = Column(Text, default="{}")
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Flashcard(Base):
    __tablename__ = "flashcards"

    id = Column(Integer, primary_key=True, index=True)
    user_id = Column(Integer, ForeignKey("users.id"))
    subject_id = Column(Integer, ForeignKey("subjects.id"), nullable=True)
    topic_id = Column(Integer, ForeignKey("topics.id"), nullable=True)
    front = Column(Text, nullable=False)
    back = Column(Text, nullable=False)
    source_context_json = Column(Text, default="{}")
    ease_factor = Column(Float, default=2.5)
    interval = Column(Integer, default=0)
    repetitions = Column(Integer, default=0)
    next_review = Column(DateTime, default=datetime.utcnow)
    created_at = Column(DateTime, default=datetime.utcnow)


class StudentGroup(Base):
    __tablename__ = "student_groups"
    id = Column(Integer, primary_key=True)
    name = Column(String(100), unique=True, nullable=False)
    description = Column(Text, default="")
    academic_year = Column(String(100), default="")
    curator = Column(String(200), default="")
    program = Column(String(300), default="")
    study_year = Column(Integer, nullable=True)
    semester = Column(Integer, nullable=True)
    warnings_json = Column(Text, default="[]")
    created_at = Column(DateTime, default=datetime.utcnow)
    courses = relationship("Course", back_populates="group", cascade="all, delete-orphan")


class AcademicSetting(Base):
    __tablename__ = "academic_settings"
    key = Column(String(100), primary_key=True)
    value = Column(Text, nullable=False, default="")


class Course(Base):
    __tablename__ = "courses"
    id = Column(Integer, primary_key=True)
    group_id = Column(Integer, ForeignKey("student_groups.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(200), nullable=False)
    description = Column(Text, default="")
    teacher = Column(String(200), default="")
    credits = Column(Float, default=0)
    color = Column(String(7), default="#4f46e5")
    created_at = Column(DateTime, default=datetime.utcnow)
    group = relationship("StudentGroup", back_populates="courses")
    schedule = relationship("ScheduleEntry", cascade="all, delete-orphan")
    weeks = relationship("CurriculumWeek", cascade="all, delete-orphan", order_by="CurriculumWeek.week_number")
    works = relationship("ModuleWork", cascade="all, delete-orphan")
    syllabi = relationship("SyllabusDocument", cascade="all, delete-orphan")


class ScheduleEntry(Base):
    __tablename__ = "schedule_entries"
    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    day_of_week = Column(Integer, nullable=False)
    start_time = Column(String(5), nullable=False)
    # Empty storage value means unknown; API represents this as null. Keeping the
    # existing NOT NULL column avoids rebuilding users' schedule tables.
    end_time = Column(String(5), nullable=False, default="")
    start_times_json = Column(Text, default="[]")
    room = Column(String(100), default="")
    lesson_type = Column(String(100), default="Практика")
    week_pattern = Column(String(20), default="every")
    teacher = Column(String(200), default="")
    notes = Column(Text, default="")
    source_file = Column(String(255), default="")
    source_container = Column(String(255), default="")
    source_container_sha256 = Column(String(64), default="")
    source_sheet = Column(String(200), default="")
    source_cell = Column(String(100), default="")
    source_row_id = Column(String(200), default="")
    source_sha256 = Column(String(64), default="")
    source_updated_at = Column(String(100), default="")
    source_raw = Column(Text, default="")
    warnings_json = Column(Text, default="[]")


class SyllabusDocument(Base):
    __tablename__ = "syllabus_documents"
    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    uploaded_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    title = Column(String(200), nullable=False)
    filename = Column(String(255), nullable=False)
    filepath = Column(Text, nullable=False)
    size = Column(Integer, nullable=False)
    source_sha256 = Column(String(64), default="")
    source_restricted = Column(Boolean, default=False, nullable=False)
    extracted_text = Column(Text, default="")
    summary = Column(Text, default="")
    status = Column(String(30), default="extracted")
    draft_json = Column(Text, default="{}")
    warnings_json = Column(Text, default="[]")
    created_at = Column(DateTime, default=datetime.utcnow)
    published_at = Column(DateTime, nullable=True)


class CurriculumWeek(Base):
    __tablename__ = "curriculum_weeks"
    __table_args__ = (UniqueConstraint("course_id", "week_number", name="uq_course_week"),)
    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    week_number = Column(Integer, nullable=False)
    title = Column(String(300), nullable=False)
    content = Column(Text, default="")
    tasks = Column(Text, default="")
    assessment = Column(Text, default="")
    hours = Column(Float, default=0)
    module = Column(String(200), default="")
    resources = Column(Text, default="")
    source_syllabus_id = Column(Integer, ForeignKey("syllabus_documents.id", ondelete="SET NULL"), nullable=True)
    progress = relationship("WeekProgress", cascade="all, delete-orphan")


class ModuleWork(Base):
    __tablename__ = "module_works"
    id = Column(Integer, primary_key=True)
    course_id = Column(Integer, ForeignKey("courses.id", ondelete="CASCADE"), nullable=False, index=True)
    title = Column(String(300), nullable=False)
    description = Column(Text, default="")
    module = Column(String(200), default="")
    week_number = Column(Integer, nullable=True)
    due_date = Column(DateTime, nullable=True)
    max_score = Column(Integer, default=100)
    kind = Column(String(30), default="assignment")
    source_syllabus_id = Column(Integer, ForeignKey("syllabus_documents.id", ondelete="SET NULL"), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    submissions = relationship("WorkSubmission", cascade="all, delete-orphan")


class WorkSubmission(Base):
    __tablename__ = "work_submissions"
    __table_args__ = (UniqueConstraint("work_id", "user_id", name="uq_work_student"),)
    id = Column(Integer, primary_key=True)
    work_id = Column(Integer, ForeignKey("module_works.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    content = Column(Text, default="")
    status = Column(String(30), default="draft")
    grade = Column(Float, nullable=True)
    feedback = Column(Text, default="")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class WeekProgress(Base):
    __tablename__ = "week_progress"
    __table_args__ = (UniqueConstraint("week_id", "user_id", name="uq_week_student"),)
    id = Column(Integer, primary_key=True)
    week_id = Column(Integer, ForeignKey("curriculum_weeks.id", ondelete="CASCADE"), nullable=False, index=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    completed = Column(Boolean, default=False)
    note = Column(Text, default="")
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class PasswordResetToken(Base):
    __tablename__ = "password_reset_tokens"
    id = Column(Integer, primary_key=True)
    user_id = Column(Integer, ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True)
    token_hash = Column(String(64), unique=True, nullable=False, index=True)
    token_version = Column(Integer, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    used_at = Column(DateTime, nullable=True)
    delivery_status = Column(String(20), default="pending", nullable=False)


class DeveloperDepartment(Base):
    """Explicit public QForce contacts, separate from private user accounts."""
    __tablename__ = "developer_departments"
    id = Column(Integer, primary_key=True)
    name = Column(String(120), nullable=False)
    director = Column(String(200), nullable=False, default="")
    description = Column(Text, nullable=False, default="")
    email = Column(String(320), nullable=False, default="")
    telegram = Column(String(100), nullable=False, default="")
    website = Column(String(2048), nullable=False, default="")
    logo = Column(String(20), nullable=False, default="main")
    display_order = Column(Integer, nullable=False, default=0)
    created_at = Column(DateTime, nullable=False, default=datetime.utcnow)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class BrandingAsset(Base):
    """Normalized public logos kept in the database, including its backups."""
    __tablename__ = "branding_assets"
    key = Column(String(100), primary_key=True)
    digest = Column(String(64), nullable=False)
    payload = Column(LargeBinary, nullable=False)
    width = Column(Integer, nullable=False)
    height = Column(Integer, nullable=False)
    department_id = Column(Integer, ForeignKey("developer_departments.id", ondelete="CASCADE"), nullable=True)
    uploaded_by = Column(Integer, ForeignKey("users.id", ondelete="SET NULL"), nullable=True)
    updated_at = Column(DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)
