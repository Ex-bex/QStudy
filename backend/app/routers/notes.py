from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from pydantic import BaseModel
from typing import Optional
from app.database import get_db
from app.models import Note
from app.auth import get_current_user

router = APIRouter(prefix="/notes", tags=["notes"])


class NoteCreate(BaseModel):
    title: str = "Без названия"
    content: str = ""
    subject_id: Optional[int] = None
    topic_id: Optional[int] = None


class NoteUpdate(BaseModel):
    title: Optional[str] = None
    content: Optional[str] = None
    subject_id: Optional[int] = None
    topic_id: Optional[int] = None


@router.get("")
def list_notes(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return db.query(Note).filter(Note.user_id == user.id) \
             .order_by(Note.updated_at.desc()).all()


@router.post("")
def create_note(data: NoteCreate, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
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