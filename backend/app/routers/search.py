from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Note, Material, Task, Flashcard
from app.auth import get_current_user

router = APIRouter(prefix="/search", tags=["search"])


def _snippet(text: str, q: str, width: int = 120) -> str:
    idx = text.lower().find(q.lower())
    if idx == -1:
        return text[:width] + ("..." if len(text) > width else "")
    start = max(0, idx - width // 2)
    end = min(len(text), idx + len(q) + width // 2)
    return ("..." if start > 0 else "") + text[start:end] + ("..." if end < len(text) else "")


@router.get("")
def search(q: str = Query(..., min_length=2), db: Session = Depends(get_db),
           user=Depends(get_current_user)):
    """Поиск по заметкам, файлам, задачам и карточкам.
    Фильтруем в Python — SQLite не умеет регистронезависимый поиск по кириллице."""
    needle = q.lower()
    out = {"notes": [], "materials": [], "tasks": [], "cards": []}

    for n in db.query(Note).filter(Note.user_id == user.id).all():
        hay = f"{n.title}\n{n.content or ''}"
        if needle in hay.lower():
            out["notes"].append({
                "id": n.id, "title": n.title,
                "snippet": _snippet(n.content or n.title, q),
            })

    for m in db.query(Material).filter(Material.user_id == user.id).all():
        hay = f"{m.filename} {m.extracted_text or ''}"
        if needle in hay.lower():
            out["materials"].append({
                "id": m.id, "filename": m.filename, "file_type": m.file_type,
                "processed": m.processed,
                "snippet": _snippet(m.extracted_text or m.filename, q),
            })

    for t in db.query(Task).filter(Task.user_id == user.id).all():
        if needle in (t.question or "").lower():
            out["tasks"].append({"id": t.id, "question": t.question[:150], "status": t.status})

    for c in db.query(Flashcard).filter(Flashcard.user_id == user.id).all():
        if needle in f"{c.front} {c.back}".lower():
            out["cards"].append({"id": c.id, "front": c.front[:150]})

    return out