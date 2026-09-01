from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from app.database import get_db
from app.models import Subject, Topic
from app.auth import get_current_user

router = APIRouter(prefix="/subjects", tags=["subjects"])


class SubjectCreate(BaseModel):
    name: str
    description: str = ""
    color: str = "#6366f1"


class TopicCreate(BaseModel):
    title: str
    description: str = ""


@router.get("")
def list_subjects(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return db.query(Subject).filter(Subject.user_id == user.id).all()


@router.post("")
def create_subject(data: SubjectCreate, db: Session = Depends(get_db),
                   user=Depends(get_current_user)):
    subject = Subject(user_id=user.id, **data.model_dump())
    db.add(subject)
    db.commit()
    db.refresh(subject)
    return subject


@router.delete("/{subject_id}")
def delete_subject(subject_id: int, db: Session = Depends(get_db),
                   user=Depends(get_current_user)):
    subject = db.query(Subject).filter(
        Subject.id == subject_id, Subject.user_id == user.id).first()
    if not subject:
        raise HTTPException(404, "Предмет не найден")
    db.delete(subject)
    db.commit()
    return {"ok": True}


@router.get("/{subject_id}/topics")
def list_topics(subject_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    return db.query(Topic).join(Subject).filter(
        Topic.subject_id == subject_id, Subject.user_id == user.id).all()


@router.post("/{subject_id}/topics")
def create_topic(subject_id: int, data: TopicCreate,
                 db: Session = Depends(get_db), user=Depends(get_current_user)):
    subject = db.query(Subject).filter(
        Subject.id == subject_id, Subject.user_id == user.id).first()
    if not subject:
        raise HTTPException(404, "Предмет не найден")
    topic = Topic(subject_id=subject_id, **data.model_dump())
    db.add(topic)
    db.commit()
    db.refresh(topic)
    return topic