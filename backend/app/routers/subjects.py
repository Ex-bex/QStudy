from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, ConfigDict
from app.database import get_db
from app.models import Subject, Topic, Note, Task, Flashcard, Material, Lecture, ExamSession
from app.auth import get_current_user, require_admin
from app.services.audit import record_audit

router = APIRouter(prefix="/subjects", tags=["subjects"])


class SubjectCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str = Field(min_length=1, max_length=160)
    description: str = Field(default="", max_length=10000)
    color: str = Field(default="#6366f1", pattern=r"^#[0-9a-fA-F]{6}$")


class SubjectUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=10000)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")


class TopicCreate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=20000)


class TopicUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=20000)


def _subject(db, subject_id):
    subject = db.get(Subject, subject_id)
    if not subject:
        raise HTTPException(404, "Предмет не найден")
    return subject


def _topic(db, subject_id, topic_id):
    _subject(db, subject_id)
    topic = db.query(Topic).filter(Topic.id == topic_id, Topic.subject_id == subject_id).first()
    if not topic:
        raise HTTPException(404, "Тема не найдена")
    return topic


def _detach_topic(db, topic_id):
    for model in (Note, Task, Flashcard, Material, ExamSession):
        db.query(model).filter(model.topic_id == topic_id).update({"topic_id": None})
    db.query(Lecture).filter(Lecture.topic_id == topic_id).delete()


@router.get("")
def list_subjects(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return db.query(Subject).order_by(Subject.name).all()


@router.post("", status_code=201)
def create_subject(data: SubjectCreate, db: Session = Depends(get_db), user=Depends(require_admin)):
    subject = Subject(user_id=user.id, **data.model_dump())
    db.add(subject)
    db.flush()
    record_audit(db, user, "subject.create", "subject", subject.id, fields=data.model_fields_set)
    db.commit()
    db.refresh(subject)
    return subject


@router.patch("/{subject_id}")
def update_subject(subject_id: int, data: SubjectUpdate, db: Session = Depends(get_db), user=Depends(require_admin)):
    subject = _subject(db, subject_id)
    for key, value in data.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(subject, key, value)
    record_audit(db, user, "subject.update", "subject", subject.id, fields=data.model_fields_set)
    db.commit()
    return subject


@router.delete("/{subject_id}")
def delete_subject(subject_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    subject = _subject(db, subject_id)
    for topic in subject.topics:
        _detach_topic(db, topic.id)
    for model in (Note, Task, Flashcard, Material, ExamSession):
        db.query(model).filter(model.subject_id == subject_id).update({"subject_id": None})
    record_audit(db, user, "subject.delete", "subject", subject_id)
    db.delete(subject)
    db.commit()
    return {"ok": True}


@router.get("/{subject_id}/topics")
def list_topics(subject_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    _subject(db, subject_id)
    return db.query(Topic).filter(Topic.subject_id == subject_id).order_by(Topic.id).all()


@router.post("/{subject_id}/topics", status_code=201)
def create_topic(subject_id: int, data: TopicCreate, db: Session = Depends(get_db), user=Depends(require_admin)):
    _subject(db, subject_id)
    topic = Topic(subject_id=subject_id, **data.model_dump())
    db.add(topic)
    db.flush()
    record_audit(db, user, "topic.create", "topic", topic.id, fields=data.model_fields_set)
    db.commit()
    db.refresh(topic)
    return topic


@router.patch("/{subject_id}/topics/{topic_id}")
def update_topic(subject_id: int, topic_id: int, data: TopicUpdate, db: Session = Depends(get_db), user=Depends(require_admin)):
    topic = _topic(db, subject_id, topic_id)
    for key, value in data.model_dump(exclude_unset=True, exclude_none=True).items():
        setattr(topic, key, value)
    record_audit(db, user, "topic.update", "topic", topic.id, fields=data.model_fields_set)
    db.commit()
    return topic


@router.delete("/{subject_id}/topics/{topic_id}")
def delete_topic(subject_id: int, topic_id: int, db: Session = Depends(get_db), user=Depends(require_admin)):
    topic = _topic(db, subject_id, topic_id)
    _detach_topic(db, topic_id)
    record_audit(db, user, "topic.delete", "topic", topic_id)
    db.delete(topic)
    db.commit()
    return {"ok": True}
