from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel, Field, ConfigDict
from typing import Optional
from app.database import get_db
from app.models import Note
from app.auth import get_current_user
from app.security import validate_relations

router = APIRouter(prefix="/notes", tags=["notes"])


class NoteCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: str = Field(default="Без названия", min_length=1, max_length=200)
    content: str = Field(default="", max_length=150000)
    subject_id: Optional[int] = None
    topic_id: Optional[int] = None


class NoteUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: Optional[str] = Field(default=None, min_length=1, max_length=200)
    content: Optional[str] = Field(default=None, max_length=150000)
    subject_id: Optional[int] = None
    topic_id: Optional[int] = None


@router.get("")
def list_notes(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return db.query(Note).filter(Note.user_id == user.id) \
             .order_by(Note.updated_at.desc()).all()


@router.post("")
def create_note(data: NoteCreate, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    validate_relations(db, data.subject_id, data.topic_id)
    note = Note(user_id=user.id, **data.model_dump())
    db.add(note)
    db.commit()
    db.refresh(note)
    return note


@router.patch("/{note_id}")
def update_note(note_id: int, data: NoteUpdate, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    note = db.query(Note).filter(Note.id == note_id, Note.user_id == user.id).first()
    if not note:
        raise HTTPException(404, "Заметка не найдена")
    values = data.model_dump(exclude_unset=True)
    validate_relations(db, values.get("subject_id", note.subject_id), values.get("topic_id", note.topic_id))
    if any(values.get(key, "") is None for key in ("title", "content")):
        raise HTTPException(422, "Заголовок и текст не могут быть null")
    for field, value in data.model_dump(exclude_unset=True).items():
        setattr(note, field, value)
    db.commit()
    db.refresh(note)
    return note


@router.delete("/{note_id}")
def delete_note(note_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    note = db.query(Note).filter(Note.id == note_id, Note.user_id == user.id).first()
    if not note:
        raise HTTPException(404, "Заметка не найдена")
    db.delete(note)
    db.commit()
    return {"ok": True}
