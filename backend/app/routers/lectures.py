import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db, SessionLocal
from app.models import Lecture, Topic, Subject, Note, Material
from app.auth import get_current_user
from app.services.ai import generate_content, AIError
from app.services import background

router = APIRouter(prefix="/lectures", tags=["lectures"])


def _materials_signature(db: Session, user_id: int, topic_id: int) -> str:
    """Отпечаток материалов темы — чтобы понять, что лекция устарела."""
    notes = db.query(Note).filter(
        Note.user_id == user_id, Note.topic_id == topic_id).all()
    mats = db.query(Material).filter(
        Material.user_id == user_id, Material.topic_id == topic_id,
        Material.processed == True).all()  # noqa: E712
    parts = [f"{n.id}:{n.updated_at}" for n in notes]
    parts += [f"{m.id}:{len(m.extracted_text or '')}" for m in mats]
    return "|".join(parts)


def _collect_materials(db: Session, user_id: int, topic: Topic, subject) -> str:
    parts = [f"ПРЕДМЕТ «{subject.name}», ТЕМА «{topic.title}»"]
    qn = db.query(Note).filter(Note.user_id == user_id, Note.topic_id == topic.id)
    for n in qn.all():
        parts.append(f"— Заметка «{n.title}»:\n{(n.content or '')[:3000]}")
    qm = db.query(Material).filter(
        Material.user_id == user_id, Material.topic_id == topic.id,
        Material.processed == True)  # noqa: E712
    for m in qm.all():
        if m.extracted_text:
            parts.append(f"— Материал «{m.filename}»:\n{m.extracted_text[:4000]}")
    return "\n\n".join(parts)


def lecture_public(l: Lecture) -> dict:
    return {
        "id": l.id, "topic_id": l.topic_id, "content": l.content,
        "status": l.status,
        "updated_at": str(l.updated_at),
    }


@router.get("")
def list_lectures(db: Session = Depends(get_db), user=Depends(get_current_user)):
    rows = db.query(Lecture).filter(Lecture.user_id == user.id).all()
    return [lecture_public(l) for l in rows]


@router.get("/topic/{topic_id}")
def get_lecture(topic_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    topic = db.query(Topic).filter(Topic.id == topic_id).first()
    if not topic:
        raise HTTPException(404, "Тема не найдена")
    subject = db.query(Subject).filter(Subject.id == topic.subject_id).first()

    lec = db.query(Lecture).filter(
        Lecture.user_id == user.id, Lecture.topic_id == topic_id).first()
    if not lec:
        lec = Lecture(user_id=user.id, topic_id=topic_id, status="empty")
        db.add(lec)
        db.commit()
        db.refresh(lec)

    d = lecture_public(lec)
    d["stale"] = bool(lec.content) and (
        lec.materials_hash != _materials_signature(db, user.id, topic_id))
    d["topic_title"] = topic.title
    d["subject_name"] = subject.name if subject else ""
    d["materials_count"] = (
        db.query(Note).filter(
            Note.user_id == user.id, Note.topic_id == topic_id).count()
        + db.query(Material).filter(
            Material.user_id == user_id, Material.topic_id == topic_id,
            Material.processed == True).count())  # noqa: E712
    return d


@router.post("/topic/{topic_id}/generate")
async def generate_lecture(topic_id: int, db: Session = Depends(get_db),
                           user=Depends(get_current_user)):
    topic = db.query(Topic).filter(Topic.id == topic_id).first()
    if not topic:
        raise HTTPException(404, "Тема не найдена")
    subject = db.query(Subject).filter(Subject.id == topic.subject_id).first()
    if not subject:
        raise HTTPException(404, "Предмет не найден")

    context = _collect_materials(db, user.id, topic, subject)
    if not context.strip():
        raise HTTPException(
            400, "Материалов темы нет: добавь заметки или загрузи и обработай файлы")

    user_id_local = user.id
    job = background.create_job(user.id, "lecture", f"Лекция: {topic.title}")

    async def _work():
        db2 = SessionLocal()
        try:
            prompt = f"""Составь подробную учебную лекцию по теме.

{context}

Требования:
- Академичный, но живой тон, в markdown
- Структура: # заголовок, ## разделы от простого к сложному
- Ключевые определения выделены, формулы в LaTeX ($...$)
- Примеры и аналогии там, где уместно
- В конце: ## Кратко — выжимка в 5-8 пунктах
- Опирайся СТРОГО на материалы выше; если в них пробел — заполни из общих знаний, пометив «(из общей теории)»

Верни только текст лекции."""
            text = await generate_content(prompt)
            lec = db2.query(Lecture).filter(
                Lecture.user_id == user_id_local,
                Lecture.topic_id == topic_id).first()
            if not lec:
                lec = Lecture(user_id=user_id_local, topic_id=topic_id)
                db2.add(lec)
            lec.content = text
            lec.status = "ready"
            lec.materials_hash = _materials_signature(db2, user_id_local, topic_id)
            db2.commit()
        except Exception:
            db2.rollback()
            raise
        finally:
            db2.close()

    background.run_job(job, _work())
    return {"job_id": job.id, "status": "started"}


@router.patch("/topic/{topic_id}")
def update_lecture(topic_id: int, data: dict,
                   db: Session = Depends(get_db), user=Depends(get_current_user)):
    lec = db.query(Lecture).filter(
        Lecture.user_id == user.id, Lecture.topic_id == topic_id).first()
    if not lec:
        raise HTTPException(404, "Лекция не найдена")
    if "content" in data:
        lec.content = data["content"]
        lec.status = "ready"
    db.commit()
    return lecture_public(lec)