import json
import re
import os
import uuid
import shutil
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.models import ExamSession, ExamQuestion, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.services.ai import generate_content, transcribe_audio, AIError

router = APIRouter(prefix="/exam", tags=["exam"])


class StartRequest(BaseModel):
    subject_id: int
    topic_id: Optional[int] = None
    difficulty: str = "medium"
    count: int = 5


def parse_json(raw: str):
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
    return json.loads(raw)


def _context(db: Session, user_id: int, subject_id: int, topic_id: Optional[int]) -> str:
    parts = []
    q = db.query(Note).filter(Note.user_id == user_id, Note.subject_id == subject_id)
    if topic_id:
        q = q.filter(Note.topic_id == topic_id)
    for n in q.limit(5):
        parts.append(f"Заметка «{n.title}»:\n{(n.content or '')[:2000]}")

    qm = db.query(Material).filter(
        Material.user_id == user_id, Material.subject_id == subject_id,
        Material.processed == True)  # noqa: E712
    if topic_id:
        qm = qm.filter(Material.topic_id == topic_id)
    for m in qm.limit(5):
        if m.extracted_text:
            parts.append(f"Материал «{m.filename}»:\n{m.extracted_text[:2000]}")
    return "\n\n".join(parts)


def question_public(q: ExamQuestion, reveal: bool) -> dict:
    d = {
        "id": q.id, "order": q.order, "question": q.question,
        "user_answer": q.user_answer, "verdict": q.verdict,
        "score": q.score, "feedback": q.feedback,
    }
    if reveal or q.verdict:   # эталон открываем после ответа или в конце
        d["reference"] = q.reference
    return d


def session_public(s: ExamSession, reveal: bool = False) -> dict:
    return {
        "id": s.id, "subject_id": s.subject_id, "topic_id": s.topic_id,
        "difficulty": s.difficulty, "status": s.status, "summary": s.summary,
        "created_at": str(s.created_at),
        "questions": [question_public(q, reveal) for q in s.questions],
    }


def _owned(db: Session, session_id: int, user) -> ExamSession:
    s = db.query(ExamSession).filter(ExamSession.id == session_id, ExamSession.user_id == user.id).first()
    if not s:
        raise HTTPException(404, "Экзамен не найден")
    return s


@router.post("/start")
async def start_exam(data: StartRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    subject = db.query(Subject).filter(
        Subject.id == data.subject_id, Subject.user_id == user.id).first()
    if not subject:
        raise HTTPException(404, "Предмет не найден")
    topic = None
    if data.topic_id:
        topic = db.query(Topic).filter(Topic.id == data.topic_id).first()
        if not topic:
            raise HTTPException(404, "Тема не найдена")

    count = max(1, min(data.count, 10))
    context = _context(db, user.id, data.subject_id, topic.id if topic else None)

    prompt = f"Ты — преподаватель предмета «{subject.name}»."
    if topic:
        prompt += f" Тема: «{topic.title}»."
    prompt += f"""
Проведи устный экзамен. Составь {count} открытых вопросов уровня «{data.difficulty}» —
требующих развёрнутого ответа (НЕ варианты «а/б/в»). Разнообразь: определения,
«почему», «сравни», «приведи пример», мини-расчёты где уместно.

{("Составь вопросы СТРОГО по материалам студента ниже — не выходи за их пределы." if context else "Материалов нет — используй свои знания по предмету.")}

{f"МАТЕРИАЛЫ СТУДЕНТА:{chr(10)}{context}" if context else ""}

Верни СТРОГО JSON-массив без текста вокруг:
[{{"question": "текст вопроса", "reference": "эталонный ответ — ключевые пункты, которые должен назвать студент"}}]"""

    try:
        raw = await generate_content(prompt, json_mode=True)
        items = parse_json(raw)
    except AIError as e:
        raise HTTPException(502, str(e))
    except Exception:
        raise HTTPException(502, "ИИ вернул неожиданный формат — попробуй ещё раз")

    if isinstance(items, dict):
        items = items.get("questions", [])

    session = ExamSession(user_id=user.id, subject_id=data.subject_id,
                          topic_id=topic.id if topic else None,
                          difficulty=data.difficulty)
    db.add(session)
    db.flush()

    made = 0
    for item in items[:count]:
        if not isinstance(item, dict) or not item.get("question"):
            continue
        db.add(ExamQuestion(session_id=session.id, order=made,
                            question=item["question"],
                            reference=str(item.get("reference", ""))))
        made += 1
    if made == 0:
        db.rollback()
        raise HTTPException(502, "ИИ не составил вопросов — попробуй ещё раз")
    db.commit()
    db.refresh(session)
    return session_public(session)


@router.post("/{session_id}/answer/{question_id}")
async def answer_question(session_id: int, question_id: int,
                          file: Optional[UploadFile] = File(None),
                          text_answer: str = Form(""),
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

    # Ответ: из аудио (расшифровка) или текстом
    if file is not None:
        os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
        tmp = os.path.join(settings.UPLOAD_DIR, f"exam_{uuid.uuid4().hex}_{file.filename}")
        with open(tmp, "wb") as f:
            shutil.copyfileobj(file.file, f)
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

    subject = db.query(Subject).filter(Subject.id == s.subject_id).first()
    subj_name = subject.name if subject else "предмет"

    prompt = f"""Ты — преподаватель на устном экзамене по предмету «{subj_name}».

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
    q.score = int(result.get("score", 0))
    q.feedback = result.get("feedback", "")
    db.commit()
    return {"question": question_public(q, reveal=False)}


@router.post("/{session_id}/finish")
async def finish_exam(session_id: int, db: Session = Depends(get_db),
                      user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    if s.status == "finished":
        return session_public(s, reveal=True)

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

    subject = db.query(Subject).filter(Subject.id == s.subject_id).first()
    subj_name = subject.name if subject else "предмет"

    prompt = f"""Ты — преподаватель, экзамен по предмету «{subj_name}» завершён.
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
    return session_public(s, reveal=True)


@router.get("")
def list_exams(db: Session = Depends(get_db), user=Depends(get_current_user)):
    sessions = db.query(ExamSession).filter(
        ExamSession.user_id == user.id).order_by(ExamSession.id.desc()).limit(20).all()
    return [session_public(s, reveal=(s.status == "finished")) for s in sessions]


@router.get("/{session_id}")
def get_exam(session_id: int, db: Session = Depends(get_db),
             user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    return session_public(s, reveal=(s.status == "finished"))


@router.delete("/{session_id}")
def delete_exam(session_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    db.delete(s)
    db.commit()
    return {"ok": True}