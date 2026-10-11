import json
import re
from typing import Optional

from fastapi import APIRouter, Body, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Lecture, Topic, Subject, Note, Material
from app.auth import get_current_user
from app.services.ai import generate_content, AIError
from app.services import background
from app.services.learning_context import LearningSelection, safe_learning_provenance
from app.services.learning_generation import (prepare_generation, source_payload, learning_prompt,
    validate_generation_source, generate_job_text, generated_provenance)

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
    return "\n\n".join(parts)[:60000]


def lecture_public(l: Lecture) -> dict:
    return {
        "id": l.id, "topic_id": l.topic_id, "content": l.content,
        "status": l.status,
        "updated_at": str(l.updated_at),
        "source_context": safe_learning_provenance(l.source_context_json),
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
            Material.user_id == user.id, Material.topic_id == topic_id,
            Material.processed == True).count())  # noqa: E712
    return d


@router.post("/topic/{topic_id}/generate")
async def generate_lecture(topic_id: int, selection: LearningSelection | None = Body(default=None),
                           db: Session = Depends(get_db),
                           user=Depends(get_current_user)):
    topic = db.query(Topic).filter(Topic.id == topic_id).first()
    if not topic:
        raise HTTPException(404, "Тема не найдена")
    subject = db.query(Subject).filter(Subject.id == topic.subject_id).first()
    if not subject:
        raise HTTPException(404, "Предмет не найден")

    source = prepare_generation(db, user, selection or LearningSelection(), [subject.id], [topic_id])

    lecture = db.query(Lecture).filter(Lecture.user_id == user.id, Lecture.topic_id == topic_id).first()
    if lecture and lecture.status == "generating":
        raise HTTPException(409, "Лекция уже создаётся. Дождитесь завершения")
    if lecture is None:
        lecture = Lecture(user_id=user.id, topic_id=topic_id)
        db.add(lecture)
        db.flush()
    lecture.status = "generating"
    prompt = learning_prompt(source, "Составь подробную лекцию по выбранной теме на языке материалов. "
        "Формат Markdown: заголовок, разделы от простого к сложному, определения и примеры, "
        "в конце 5–8 основных выводов. Дополнение из общей теории явно помечай. Верни только текст лекции.")
    job = background.enqueue_job(db, user.id, "lecture", f"Лекция: {topic.title}",
        {"lecture_id": lecture.id, "topic_id": topic_id, "prompt": prompt,
         "materials_hash": _materials_signature(db, user.id, topic_id), **source_payload(source)},
        resource_key=f"lecture:{lecture.id}")
    db.commit()
    background.wake_worker()
    return {"job_id": job.id, "status": "started"}


def _lecture_failure(db, user_id, payload):
    db.query(Lecture).filter(Lecture.id == payload.get("lecture_id"),
        Lecture.user_id == user_id, Lecture.status == "generating").update({"status": "error"})


@background.register_handler("lecture", on_error=_lecture_failure)
async def _generate_lecture_job(context, payload):
    with context.session() as db:
        context.require_current(db)
        lecture = db.query(Lecture).filter(Lecture.id == payload["lecture_id"],
            Lecture.user_id == context.user_id, Lecture.topic_id == payload["topic_id"]).first()
        if not lecture or (payload["topic_id"] is not None and not db.get(Topic, payload["topic_id"])) or lecture.status != "generating":
            raise background.JobCancelled("Тема или лекция изменена; генерация остановлена")
        validate_generation_source(context, db, payload)
    text, research = await generate_job_text(context, payload, generate_content, json_mode=False, key="text")
    with context.session() as db:
        context.require_current(db)
        lecture = db.query(Lecture).filter(Lecture.id == payload["lecture_id"],
            Lecture.user_id == context.user_id, Lecture.topic_id == payload["topic_id"]).first()
        if not lecture or (payload["topic_id"] is not None and not db.get(Topic, payload["topic_id"])) or lecture.status != "generating":
            raise background.JobCancelled("Тема или лекция изменена; генерация остановлена")
        validate_generation_source(context, db, payload)
        lecture.content = text
        lecture.status = "ready"
        lecture.materials_hash = payload["materials_hash"]
        lecture.source_context_json = generated_provenance(payload, research)
        result = {"lecture_id": lecture.id, "topic_id": lecture.topic_id}
        context.complete(db, result)
        return result


class LectureUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    content: str = Field(max_length=150000)


@router.patch("/topic/{topic_id}")
def update_lecture(topic_id: int, data: LectureUpdate,
                   db: Session = Depends(get_db), user=Depends(get_current_user)):
    lec = db.query(Lecture).filter(
        Lecture.user_id == user.id, Lecture.topic_id == topic_id).first()
    if not lec:
        raise HTTPException(404, "Лекция не найдена")
    if lec.status == "generating":
        raise HTTPException(409, "Дождитесь завершения генерации перед редактированием")
    lec.content = data.content
    lec.status = "ready"
    db.commit()
    return lecture_public(lec)


@router.delete("/topic/{topic_id}")
def delete_lecture(topic_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    lecture = db.query(Lecture).filter(Lecture.user_id == user.id, Lecture.topic_id == topic_id).first()
    if not lecture:
        raise HTTPException(404, "Лекция не найдена")
    if lecture.status == "generating":
        raise HTTPException(409, "Дождитесь завершения генерации перед удалением")
    db.delete(lecture)
    db.commit()
    return {"ok": True}


class LearningLectureRequest(LearningSelection):
    subject_ids: list[int] = Field(default_factory=list, max_length=30)
    topic_ids: list[int] = Field(default_factory=list, max_length=100)


@router.post("/generate")
async def generate_learning_lecture(data: LearningLectureRequest, db: Session = Depends(get_db),
                                    user=Depends(get_current_user)):
    source = prepare_generation(db, user, data, data.subject_ids, data.topic_ids)
    lecture = Lecture(user_id=user.id, topic_id=None, status="generating",
                      source_context_json=json.dumps(source.provenance, ensure_ascii=False))
    db.add(lecture)
    db.flush()
    prompt = learning_prompt(source, "Составь подробную учебную лекцию по всем выбранным темам. "
        "Используй Markdown, определения, доступные объяснения и примеры; для каждой темы отдельный раздел. "
        "В конце добавь вопросы для самопроверки и основные выводы. Отделяй требования силабуса от "
        "теоретических дополнений. Верни только текст лекции.")
    job = background.enqueue_job(db, user.id, "lecture", f"Лекция: {source.title}",
        {"lecture_id": lecture.id, "topic_id": None, "materials_hash": source.fingerprint,
         "prompt": prompt, **source_payload(source)}, resource_key=f"lecture:{lecture.id}")
    db.commit()
    background.wake_worker()
    return {"job_id": job.id, "lecture_id": lecture.id, "status": "started"}


def _owned_lecture(db, lecture_id, user):
    lecture = db.query(Lecture).filter(Lecture.user_id == user.id, Lecture.id == lecture_id).first()
    if lecture is None:
        raise HTTPException(404, "Лекция не найдена")
    return lecture


@router.get("/{lecture_id}")
def read_learning_lecture(lecture_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    return lecture_public(_owned_lecture(db, lecture_id, user))


@router.patch("/{lecture_id}")
def edit_learning_lecture(lecture_id: int, data: LectureUpdate,
                         db: Session = Depends(get_db), user=Depends(get_current_user)):
    lecture = _owned_lecture(db, lecture_id, user)
    if lecture.status == "generating":
        raise HTTPException(409, "Дождитесь завершения генерации перед редактированием")
    lecture.content = data.content
    lecture.status = "ready"
    db.commit()
    return lecture_public(lecture)


@router.delete("/{lecture_id}")
def remove_learning_lecture(lecture_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    lecture = _owned_lecture(db, lecture_id, user)
    if lecture.status == "generating":
        raise HTTPException(409, "Дождитесь завершения генерации перед удалением")
    db.delete(lecture)
    db.commit()
    return {"ok": True}
