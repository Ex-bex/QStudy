import json
import re
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session
from app.services import background
from app.database import get_db
from app.models import TestSession, TestQuestion, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.services.ai import generate_content, AIError

router = APIRouter(prefix="/tests", tags=["tests"])


class StartRequest(BaseModel):
    subject_ids: List[int]
    topic_ids: Optional[List[int]] = None
    difficulty: str = "medium"
    count: int = 10


class AnswerRequest(BaseModel):
    option_index: int


def parse_json(raw: str):
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
    return json.loads(raw)


def _loads(text: str, fallback):
    try:
        return json.loads(text) if text else fallback
    except Exception:
        return fallback


def _names(db: Session, model, ids: list) -> list:
    if not ids:
        return []
    rows = db.query(model).filter(model.id.in_(ids)).all()
    by_id = {r.id: r for r in rows}
    return [by_id[i].name if hasattr(by_id[i], "name") else by_id[i].title
            for i in ids if i in by_id]


def q_public(q: TestQuestion, reveal: bool) -> dict:
    d = {
        "id": q.id, "order": q.order, "question": q.question,
        "options": _loads(q.options, []), "user_index": q.user_index,
    }
    if reveal or q.user_index is not None:
        d["correct_index"] = q.correct_index
        d["explanation"] = q.explanation
    return d


def s_public(s: TestSession, reveal: bool = False) -> dict:
    return {
        "id": s.id, "difficulty": s.difficulty, "status": s.status,
        "score": s.score, "summary": s.summary,
        "subject_ids": _loads(s.subject_ids_json, []),
        "topic_ids": _loads(s.topic_ids_json, []),
        "subject_names": _names(db=None, model=None, ids=[]) or [],  # заполняется в роутах
        "questions": [q_public(q, reveal) for q in s.questions],
    }


def _full_public(db: Session, s: TestSession, reveal: bool = False) -> dict:
    d = s_public(s, reveal)
    d["subject_names"] = _names(db, Subject, d["subject_ids"])
    d["topic_names"] = _names(db, Topic, d["topic_ids"])
    return d


def _owned(db: Session, session_id: int, user) -> TestSession:
    s = db.query(TestSession).filter(
        TestSession.id == session_id, TestSession.user_id == user.id).first()
    if not s:
        raise HTTPException(404, "Тест не найден")
    return s


def _context(db: Session, user_id: int, subject_ids: list, topic_ids: Optional[list]) -> str:
    parts = []
    for sid in subject_ids:
        subject = db.query(Subject).filter(
            Subject.id == sid, Subject.user_id == user_id).first()
        if not subject:
            continue
        subj_topics = [t.title for t in db.query(Topic).filter(
            Topic.subject_id == sid).all() if not topic_ids or t.id in topic_ids]
        parts.append(f"===== ПРЕДМЕТ «{subject.name}»"
                     + (f" (темы: {', '.join(subj_topics)})" if subj_topics else "") + " =====")

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
    return "\n\n".join(parts)


@router.post("/start")
async def start_test(data: StartRequest, db: Session = Depends(get_db),
                     user=Depends(get_current_user)):
    if not data.subject_ids:
        raise HTTPException(400, "Выбери хотя бы один предмет")

    subjects = db.query(Subject).filter(
        Subject.id.in_(data.subject_ids), Subject.user_id == user.id).all()
    if not subjects:
        raise HTTPException(404, "Предметы не найдены")
    subject_ids = [s.id for s in subjects]
    topic_ids = list(data.topic_ids or [])

    count = max(1, min(data.count, 20))

    # Контекст собираем СРАЗУ (сессия жива), генерация — в фоне
    context = _context(db, user.id, subject_ids, topic_ids)
    subj_line = ", ".join(s.name for s in subjects)
    topic_titles = [t.title for t in db.query(Topic).filter(
        Topic.id.in_(topic_ids)).all()] if topic_ids else []

    prompt = f"""Составь {count} тестовых вопросов с выбором из 4 вариантов уровня «{data.difficulty}».
Предметы: {subj_line}."""
    if topic_titles:
        prompt += f" Темы: {', '.join(topic_titles)}."
    prompt += f"""

Правила для каждого вопроса:
- ровно 4 варианта, ровно один правильный
- неправильные варианты правдоподобные, но однозначно неверные
- "explanation" — 1-2 предложения почему ответ верен

{("Опирайся СТРОГО на материалы студента ниже — не задавай вопросов вне их содержания." if context else "Материалов нет — используй свои знания по предметам.")}

{f"МАТЕРИАЛЫ СТУДЕНТА:{chr(10)}{context}" if context else ""}

Верни СТРОГО JSON-массив без текста вокруг:
[{{"question": "текст вопроса", "options": ["в1","в2","в3","в4"], "correct_index": 0, "explanation": "почему"}}]
"""

    job = background.create_job(user.id, "test", f"Тест: {subj_line}")

    async def _work():
        from app.database import SessionLocal
        db2 = SessionLocal()
        try:
            raw = await generate_content(prompt, json_mode=True)
            items = parse_json(raw)
            if isinstance(items, dict):
                items = items.get("questions", [])

            session = TestSession(
                user_id=user.id, difficulty=data.difficulty,
                subject_ids_json=json.dumps(subject_ids),
                topic_ids_json=json.dumps(topic_ids),
            )
            db2.add(session)
            db2.flush()
            made = 0
            for item in items[:count]:
                if not isinstance(item, dict) or not item.get("question"):
                    continue
                options = item.get("options")
                ci = item.get("correct_index")
                if not isinstance(options, list) or len(options) != 4:
                    continue
                if not isinstance(ci, int) or not (0 <= ci <= 3):
                    continue
                db2.add(TestQuestion(
                    session_id=session.id, order=made, question=item["question"],
                    options=json.dumps([str(o) for o in options]),
                    correct_index=ci, explanation=str(item.get("explanation", "")),
                ))
                made += 1
            if made == 0:
                raise Exception("ИИ не составил ни одного корректного вопроса")
            db2.commit()
            job.result = {"test_id": session.id}
        finally:
            db2.close()

    background.run_job(job, _work())
    return {"job_id": job.id, "status": "started"}


@router.post("/{session_id}/answer/{question_id}")
def answer_question(session_id: int, question_id: int, data: AnswerRequest,
                    db: Session = Depends(get_db), user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    if s.status != "active":
        raise HTTPException(400, "Тест уже завершён")
    q = db.query(TestQuestion).filter(
        TestQuestion.id == question_id, TestQuestion.session_id == s.id).first()
    if not q:
        raise HTTPException(404, "Вопрос не найден")
    if q.user_index is not None:
        raise HTTPException(400, "На этот вопрос уже ответили")
    if not (0 <= data.option_index <= 3):
        raise HTTPException(400, "Вариант должен быть 0-3")

    q.user_index = data.option_index
    db.commit()
    return {"question": q_public(q, reveal=False)}


@router.post("/{session_id}/finish")
async def finish_test(session_id: int, db: Session = Depends(get_db),
                      user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    if s.status == "finished":
        return _full_public(db, s, reveal=True)

    answered = [q for q in s.questions if q.user_index is not None]
    if not answered:
        raise HTTPException(400, "Ни на один вопрос не отвечено")

    correct = sum(1 for q in answered if q.user_index == q.correct_index)
    s.score = round(correct / len(answered) * 100)
    s.status = "finished"
    s.finished_at = datetime.utcnow()
    db.commit()

    wrong = [q for q in answered if q.user_index != q.correct_index]
    if wrong:
        protocol = "\n\n".join(
            f"Вопрос: {q.question}\nПравильный: {_loads(q.options, [''])[q.correct_index]}\n"
            f"Выбрал: {(_loads(q.options, [''])[q.user_index] if q.user_index is not None else '—')}\n"
            f"Пояснение: {q.explanation}"
            for q in wrong)
        prompt = f"""Студент прошёл тест. Результат: {correct}/{len(answered)} ({s.score}%).
Ошибки:

{protocol}

Дай краткий итог (80-140 слов): пробелы по ошибкам, что повторить, один совет. Поддерживающий тон."""
        job = background.create_job(user.id, "test", f"Итог теста: {s.score}%")

        async def _work():
            from app.database import SessionLocal
            db2 = SessionLocal()
            try:
                summary = await generate_content(prompt)
                s2 = db2.query(TestSession).filter(TestSession.id == s.id).first()
                if s2:
                    s2.summary = summary
                    db2.commit()
            finally:
                db2.close()

        background.run_job(job, _work())
    else:
        s.summary = f"Идеально! {correct}/{len(answered)}. 🎉"

    return _full_public(db, s, reveal=True)

@router.get("")
def list_tests(db: Session = Depends(get_db), user=Depends(get_current_user)):
    rows = db.query(TestSession).filter(
        TestSession.user_id == user.id).order_by(TestSession.id.desc()).limit(20).all()
    return [_full_public(db, s, reveal=(s.status == "finished")) for s in rows]


@router.get("/{session_id}")
def get_test(session_id: int, db: Session = Depends(get_db),
             user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    return _full_public(db, s, reveal=(s.status == "finished"))


@router.delete("/{session_id}")
def delete_test(session_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    s = _owned(db, session_id, user)
    db.delete(s)
    db.commit()
    return {"ok": True}