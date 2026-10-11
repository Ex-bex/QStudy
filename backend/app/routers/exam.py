import json
import re
import os
import uuid
import shutil
from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.models import ExamSession, ExamQuestion, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.security import validate_relations, validate_selection, save_upload
from app.services.ai import generate_content, transcribe_audio, AIError
from app.services import background
from app.services.learning_context import LearningSelection, safe_learning_provenance
from app.services.learning_generation import (prepare_generation, source_payload, learning_prompt,
    validate_generation_source, generate_job_text, generated_provenance)

router = APIRouter(prefix="/exam", tags=["exam"])


class StartRequest(LearningSelection):
    model_config = ConfigDict(extra="forbid")
    subject_ids: List[int] = Field(default_factory=list, max_length=30)
    topic_ids: Optional[List[int]] = Field(default=None, max_length=100)
    difficulty: str = Field(default="medium", pattern="^(easy|medium|hard)$")
    count: int = 5


def parse_json(raw: str):
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
    return json.loads(raw)


def _names(db: Session, model, ids: list) -> list:
    if not ids:
        return []
    rows = db.query(model).filter(model.id.in_(ids)).all()
    by_id = {r.id: r for r in rows}
    return [by_id[i].name if hasattr(by_id[i], "name") else by_id[i].title
            for i in ids if i in by_id]


def _context(db: Session, user_id: int, subject_ids: list,
             topic_ids: Optional[list]) -> str:
    parts = []
    for sid in subject_ids:
        subject = db.query(Subject).filter(
            Subject.id == sid).first()
        if not subject:
            continue
        subj_topics = [t.title for t in db.query(Topic).filter(
            Topic.subject_id == sid).all() if not topic_ids or t.id in topic_ids]
        parts.append(f"===== ПРЕДМЕТ «{subject.name}»"
                     + (f" (темы: {', '.join(subj_topics)})" if subj_topics else "")
                     + " =====")

        qn = db.query(Note).filter(Note.user_id == user_id, Note.subject_id == sid)
        if topic_ids:
            qn = qn.filter(Note.topic_id.in_(topic_ids))
        for n in qn.limit(4):
            parts.append(f"Заметка «{n.title}»:\n{(n.content or '')[:1800]}")

        qm = db.query(Material).filter(
            Material.user_id == user_id, Material.subject_id == sid,
            Material.processed == True)  # noqa: E712
        if topic_ids:
            qm = qm.filter(Material.topic_id.in_(topic_ids))
        for m in qm.limit(4):
            if m.extracted_text:
                parts.append(f"Материал «{m.filename}»:\n{m.extracted_text[:3000]}")
    return "\n\n".join(parts)[:60000]


def question_public(q: ExamQuestion, reveal: bool) -> dict:
    d = {
        "id": q.id, "order": q.order, "question": q.question,
        "user_answer": q.user_answer, "verdict": q.verdict,
        "score": q.score, "feedback": q.feedback,
    }
    if reveal or q.verdict:
        d["reference"] = q.reference
    return d


def session_public(s: ExamSession, reveal: bool = False) -> dict:
    return {
        "id": s.id, "subject_id": s.subject_id, "topic_id": s.topic_id,
        "difficulty": s.difficulty, "status": s.status, "summary": s.summary,
        "created_at": str(s.created_at),
        "questions": [question_public(q, reveal) for q in s.questions],
        "source_context": safe_learning_provenance(s.source_context_json),
    }


def _full_public(db: Session, s: ExamSession) -> dict:
    d = session_public(s, reveal=(s.status == "finished"))
    try:
        sids = json.loads(s.subject_ids_json) if s.subject_ids_json else []
    except Exception:
        sids = [s.subject_id] if s.subject_id else []
    try:
        tids = json.loads(s.topic_ids_json) if s.topic_ids_json else []
    except Exception:
        tids = []
    d["subject_ids"] = sids
    d["topic_ids"] = tids
    d["subject_names"] = _names(db, Subject, sids)
    d["topic_names"] = _names(db, Topic, tids)
    return d


def _owned(db: Session, session_id: int, user) -> ExamSession:
    s = db.query(ExamSession).filter(
        ExamSession.id == session_id, ExamSession.user_id == user.id).first()
    if not s:
        raise HTTPException(404, "Экзамен не найден")
    return s


@router.post("/start")
async def start_exam(data: StartRequest, db: Session = Depends(get_db),
                     user=Depends(get_current_user)):
    source = prepare_generation(db, user, data, data.subject_ids, data.topic_ids)
    count = max(1, min(data.count, 10))
    prompt = learning_prompt(source, f"""Составь {count} открытых вопросов для устного экзамена уровня «{data.difficulty}».
Вопросы требуют развёрнутого ответа: определения, объяснения, сравнения и примеры по выбранным темам.
Эталонный ответ перечисляет ключевые пункты, которые должен назвать студент.
Верни только JSON-массив:
[{{"question":"вопрос", "reference":"ключевые пункты ответа"}}]""")
    session = ExamSession(user_id=user.id, difficulty=data.difficulty, status="generating",
        subject_ids_json=json.dumps(data.subject_ids), topic_ids_json=json.dumps(data.topic_ids or []),
        source_context_json=json.dumps(source.provenance, ensure_ascii=False))
    db.add(session)
    db.flush()
    job = background.enqueue_job(db, user.id, "exam", f"Экзамен: {source.title}",
        {"session_id": session.id, "subject_ids": list(data.subject_ids),
         "topic_ids": list(data.topic_ids or []), "count": count, "prompt": prompt,
         **source_payload(source)}, resource_key=f"exam:{session.id}")
    db.commit()
    result = await background.await_job_result(job.id, user.id)
    db.expire_all()
    session = _owned(db, result["exam_id"], user)
    return _full_public(db, session)

def _exam_failure(db, user_id, payload):
    db.query(ExamSession).filter(ExamSession.id == payload.get("session_id"),
        ExamSession.user_id == user_id, ExamSession.status == "generating").update({"status": "error"})


@background.register_handler("exam", on_error=_exam_failure)
async def _generate_exam_job(context, payload):
    with context.session() as db:
        context.require_current(db)
        session = db.query(ExamSession).filter(ExamSession.id == payload["session_id"],
            ExamSession.user_id == context.user_id, ExamSession.status == "generating").first()
        if not session:
            raise background.JobCancelled("Экзамен удалён или изменён; генерация остановлена")
        validate_selection(db, payload["subject_ids"], payload["topic_ids"])
        validate_generation_source(context, db, payload)
    raw, research = await generate_job_text(context, payload, generate_content)
    try:
        items = parse_json(raw)
    except (ValueError, TypeError):
        raise background.JobPermanentError("ИИ вернул некорректные вопросы. Повторите создание экзамена") from None
    if isinstance(items, dict):
        items = items.get("questions", [])
    if not isinstance(items, list):
        raise background.JobPermanentError("ИИ вернул некорректные вопросы. Повторите создание экзамена")
    questions = []
    for item in items[:payload["count"]]:
        if not isinstance(item, dict) or not isinstance(item.get("question"), str) or not item["question"].strip():
            continue
        questions.append({"question": item["question"][:10000],
            "reference": str(item.get("reference", ""))[:20000]})
    if not questions:
        raise background.JobPermanentError("ИИ не составил корректные вопросы. Повторите создание экзамена")
    with context.session() as db:
        context.require_current(db)
        session = db.query(ExamSession).filter(ExamSession.id == payload["session_id"],
            ExamSession.user_id == context.user_id, ExamSession.status == "generating").first()
        if not session:
            raise background.JobCancelled("Экзамен удалён или изменён; генерация остановлена")
        validate_selection(db, payload["subject_ids"], payload["topic_ids"])
        validate_generation_source(context, db, payload)
        for previous in list(session.questions):
            db.delete(previous)
        for order, item in enumerate(questions):
            db.add(ExamQuestion(session_id=session.id, order=order,
                question=item["question"], reference=item["reference"]))
        session.status = "active"
        session.source_context_json = generated_provenance(payload, research)
        context.complete(db, {"exam_id": session.id})


@router.post("/{session_id}/answer/{question_id}")
async def answer_question(session_id: int, question_id: int,
                          file: Optional[UploadFile] = File(None),
                          text_answer: str = Form("", max_length=20000),
                          db: Session = Depends(get_db),
                          user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    if s.status != "active":
        raise HTTPException(400, "Экзамен уже завершён")

    q = db.query(ExamQuestion).filter(
        ExamQuestion.id == question_id, ExamQuestion.session_id == s.id).first()
    if not q:
        raise HTTPException(404, "Вопрос не найден")
    if q.verdict:
        raise HTTPException(400, "На этот вопрос уже ответили")

    if file is not None:
        _, tmp, _ = await save_upload(file, {"webm", "mp3", "wav", "ogg", "m4a"})
        try:
            answer_text = await transcribe_audio(tmp)
        except AIError as e:
            raise HTTPException(502, f"Не удалось расшифровать ответ: {e}")
        finally:
            if os.path.exists(tmp):
                os.remove(tmp)
    else:
        answer_text = text_answer.strip()

    if not answer_text:
        raise HTTPException(400, "Пустой ответ")

    try:
        sids = json.loads(s.subject_ids_json) if s.subject_ids_json else []
    except Exception:
        sids = [s.subject_id] if s.subject_id else []
    subj_rows = db.query(Subject).filter(Subject.id.in_(sids)).all() if sids else []
    subj_name = ", ".join(x.name for x in subj_rows) if subj_rows else "предмет"

    prompt = f"""Ты — преподаватель на устном экзамене по предметам «{subj_name}».

Вопрос: {q.question}
Эталонный ответ: {q.reference or "(эталона нет, оцени по сути вопроса)"}
Ответ студента (расшифровка устной речи): {answer_text}

Речь расшифрована автоматически — будь снисходителен к оговоркам, оценивай по сути.
Верни СТРОГО JSON без текста вокруг:
{{"verdict": "correct|partial|wrong", "score": число 0-100, "feedback": "разбор по-русски: что верно, чего не хватает, какие ошибки. 2-5 предложений"}}"""

    try:
        raw = await generate_content(prompt, json_mode=True)
        result = parse_json(raw)
    except AIError as e:
        raise HTTPException(502, str(e))
    except Exception:
        raise HTTPException(502, "ИИ вернул неожиданный формат — попробуй ещё раз")

    verdict = result.get("verdict", "wrong")
    if verdict not in ("correct", "partial", "wrong"):
        verdict = "wrong"

    q.user_answer = answer_text
    q.verdict = verdict
    q.score = max(0, min(100, int(result.get("score", 0))))
    q.feedback = result.get("feedback", "")
    db.commit()
    return {"question": question_public(q, reveal=False)}


@router.post("/{session_id}/finish")
async def finish_exam(session_id: int, db: Session = Depends(get_db),
                      user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    if s.status == "finished":
        return _full_public(db, s)

    answered = [q for q in s.questions if q.verdict]
    if not answered:
        raise HTTPException(400, "Ни на один вопрос не отвечено")

    lines = []
    for q in s.questions:
        lines.append(
            f"Вопрос: {q.question}\nЭталон: {q.reference}\n"
            f"Ответ студента: {q.user_answer or '(нет ответа)'}\n"
            f"Оценка: {q.score}/100 ({q.verdict})")
    protocol = "\n\n".join(lines)

    try:
        sids = json.loads(s.subject_ids_json) if s.subject_ids_json else []
    except Exception:
        sids = [s.subject_id] if s.subject_id else []
    subj_rows = db.query(Subject).filter(Subject.id.in_(sids)).all() if sids else []
    subj_name = ", ".join(x.name for x in subj_rows) if subj_rows else "предмет"

    prompt = f"""Ты — преподаватель, экзамен по предметам «{subj_name}» завершён.
Протокол экзамена:

{protocol}

Составь итог экзамена (простой текст, без JSON):
1) Общий результат — средний балл и уровень подготовки одной фразой
2) Что студент знает хорошо
3) Слабые места — чего не хватило в ответах
4) Три конкретных шага: что и как повторить
Тон поддерживающий, 120-180 слов."""

    try:
        summary = await generate_content(prompt)
    except AIError as e:
        raise HTTPException(502, str(e))

    s.status = "finished"
    s.summary = summary
    s.finished_at = datetime.utcnow()
    db.commit()
    return _full_public(db, s)


@router.get("")
def list_exams(db: Session = Depends(get_db), user=Depends(get_current_user)):
    sessions = db.query(ExamSession).filter(
        ExamSession.user_id == user.id,
        ExamSession.status.in_(("active", "finished"))).order_by(ExamSession.id.desc()).limit(20).all()
    return [_full_public(db, s) for s in sessions]


@router.get("/{session_id}")
def get_exam(session_id: int, db: Session = Depends(get_db),
             user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    return _full_public(db, s)


@router.delete("/{session_id}")
def delete_exam(session_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    db.delete(s)
    db.commit()
    return {"ok": True}
