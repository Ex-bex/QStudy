import json
import re
from datetime import datetime, timezone
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session
from app.services import background
from app.database import get_db
from app.models import TestSession, TestQuestion, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.security import validate_relations, validate_selection, save_upload
from app.services.ai import generate_content, AIError
from app.services.learning_context import LearningSelection, safe_learning_provenance, dump_learning_provenance
from app.services.learning_generation import (prepare_generation, source_payload, validate_generation_source,
    generate_job_text, generated_provenance, learning_prompt)

router = APIRouter(prefix="/tests", tags=["tests"])


class StartRequest(LearningSelection):
    model_config = ConfigDict(extra="forbid")
    subject_ids: List[int] = Field(default_factory=list, max_length=30)
    topic_ids: Optional[List[int]] = Field(default=None, max_length=100)
    difficulty: str = Field(default="medium", pattern="^(easy|medium|hard)$")
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
        "created_at": s.created_at.replace(tzinfo=timezone.utc).isoformat() if s.created_at else None,
        "subject_ids": _loads(s.subject_ids_json, []),
        "topic_ids": _loads(s.topic_ids_json, []),
        "source_context": safe_learning_provenance(s.source_context_json),
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
            Subject.id == sid).first()
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
    return "\n\n".join(parts)[:60000]


@router.post("/start")
async def start_test(data: StartRequest, db: Session = Depends(get_db),
                     user=Depends(get_current_user)):
    source = prepare_generation(db, user, data, data.subject_ids, data.topic_ids)
    subject_ids = list(data.subject_ids)
    topic_ids = list(data.topic_ids or [])

    count = max(1, min(data.count, 20))

    # Контекст собираем СРАЗУ (сессия жива), генерация — в фоне
    subj_line = source.title
    prompt = learning_prompt(source, f"""Составь {count} тестовых вопросов с выбором из 4 вариантов уровня «{data.difficulty}».

Правила для каждого вопроса:
- ровно 4 варианта, ровно один правильный
- неправильные варианты правдоподобные, но однозначно неверные
- "explanation" — 1-2 предложения почему ответ верен

Верни СТРОГО JSON-массив без текста вокруг:
[{{"question": "текст вопроса", "options": ["в1","в2","в3","в4"], "correct_index": 0, "explanation": "почему"}}]
""")

    session = TestSession(user_id=user.id, difficulty=data.difficulty, status="generating",
        subject_ids_json=json.dumps(subject_ids), topic_ids_json=json.dumps(topic_ids),
        source_context_json=dump_learning_provenance(source.provenance))
    db.add(session)
    db.flush()
    job = background.enqueue_job(db, user.id, "test", f"Тест: {subj_line}",
        {"session_id": session.id, "subject_ids": subject_ids, "topic_ids": topic_ids,
         "count": count, "prompt": prompt, **source_payload(source)}, resource_key=f"test:{session.id}")
    db.commit()
    background.wake_worker()
    return {"job_id": job.id, "status": "started"}


def _test_failure(db, user_id, payload):
    db.query(TestSession).filter(TestSession.id == payload.get("session_id"),
        TestSession.user_id == user_id, TestSession.status == "generating").update({"status": "error"})


@background.register_handler("test", on_error=_test_failure)
async def _generate_test_job(context, payload):
    with context.session() as db:
        context.require_current(db)
        session = db.query(TestSession).filter(TestSession.id == payload["session_id"],
            TestSession.user_id == context.user_id, TestSession.status == "generating").first()
        if not session:
            raise background.JobCancelled("Тест удалён или изменён; генерация остановлена")
        validate_generation_source(context, db, payload)
        if not (payload.get("learning_selection") or {}).get("course_id"):
            validate_selection(db, payload["subject_ids"], payload["topic_ids"])
    raw, research = await generate_job_text(context, payload, generate_content, json_mode=True)
    try:
        items = parse_json(raw)
    except (ValueError, TypeError):
        raise background.JobPermanentError("ИИ вернул некорректные вопросы. Повторите создание теста") from None
    if isinstance(items, dict):
        items = items.get("questions", [])
    if not isinstance(items, list):
        raise background.JobPermanentError("ИИ вернул некорректные вопросы. Повторите создание теста")
    questions = []
    for item in items[:payload["count"]]:
        if not isinstance(item, dict) or not isinstance(item.get("question"), str) or not item["question"].strip():
            continue
        options = item.get("options"); correct_index = item.get("correct_index")
        if not isinstance(options, list) or len(options) != 4 or type(correct_index) is not int or not 0 <= correct_index <= 3:
            continue
        questions.append({"question": item["question"][:10000], "options": [str(o)[:3000] for o in options],
            "correct_index": correct_index, "explanation": str(item.get("explanation", ""))[:10000]})
    if not questions:
        raise background.JobPermanentError("ИИ не составил корректные вопросы. Повторите создание теста")
    with context.session() as db:
        context.require_current(db)
        session = db.query(TestSession).filter(TestSession.id == payload["session_id"],
            TestSession.user_id == context.user_id, TestSession.status == "generating").first()
        if not session:
            raise background.JobCancelled("Тест удалён или изменён; генерация остановлена")
        validate_generation_source(context, db, payload)
        if not (payload.get("learning_selection") or {}).get("course_id"):
            validate_selection(db, payload["subject_ids"], payload["topic_ids"])
        # Replace only the reserved placeholder, then finalize in one transaction.
        # A restart never creates a second test session or a second question set.
        for old in list(session.questions):
            db.delete(old)
        for order, item in enumerate(questions):
            db.add(TestQuestion(session_id=session.id, order=order, question=item["question"],
                options=json.dumps(item["options"], ensure_ascii=False),
                correct_index=item["correct_index"], explanation=item["explanation"]))
        session.status = "active"
        session.source_context_json = generated_provenance(payload, research)
        result = {"test_id": session.id}
        context.complete(db, result)
        return result


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
    if s.status != "active":
        raise HTTPException(409, "Тест ещё создаётся или завершён с ошибкой")

    answered = [q for q in s.questions if q.user_index is not None]
    if not answered:
        raise HTTPException(400, "Ни на один вопрос не отвечено")

    correct = sum(1 for q in answered if q.user_index == q.correct_index)
    s.score = round(correct / max(1, len(s.questions)) * 100)
    s.status = "finished"
    s.finished_at = datetime.utcnow()

    wrong = [q for q in answered if q.user_index != q.correct_index]
    if wrong:
        protocol = "\n\n".join(
            f"Вопрос: {q.question}\nПравильный: {_loads(q.options, [''])[q.correct_index]}\n"
            f"Выбрал: {(_loads(q.options, [''])[q.user_index] if q.user_index is not None else '—')}\n"
            f"Пояснение: {q.explanation}"
            for q in wrong)[:60000]
        prompt = f"""Студент прошёл тест. Результат: {correct}/{len(answered)} ({s.score}%).
Ошибки:

{protocol}

Дай краткий итог (80-140 слов): пробелы по ошибкам, что повторить, один совет. Поддерживающий тон."""
        background.enqueue_job(db, user.id, "test_summary", f"Итог теста: {s.score}%",
            {"session_id": s.id, "prompt": prompt}, resource_key=f"summary:{s.id}")
    else:
        s.summary = f"Результат: {correct}/{len(s.questions)}. {s.score}%"
    db.commit()
    background.wake_worker()
    return _full_public(db, s, reveal=True)


@background.register_handler("test_summary")
async def _summarize_test_job(context, payload):
    with context.session() as db:
        context.require_current(db)
        session = db.query(TestSession).filter(TestSession.id == payload["session_id"],
            TestSession.user_id == context.user_id, TestSession.status == "finished").first()
        if not session:
            raise background.JobCancelled("Тест удалён или изменён; итог остановлен")
    saved = context.get_checkpoint()
    summary = saved.get("summary")
    if summary is None:
        summary = await generate_content(payload["prompt"])
        context.save_checkpoint({"summary": summary})
    with context.session() as db:
        context.require_current(db)
        session = db.query(TestSession).filter(TestSession.id == payload["session_id"],
            TestSession.user_id == context.user_id, TestSession.status == "finished").first()
        if not session:
            raise background.JobCancelled("Тест удалён или изменён; итог остановлен")
        session.summary = summary
        result = {"test_id": session.id}
        context.complete(db, result)
        return result

@router.get("")
def list_tests(db: Session = Depends(get_db), user=Depends(get_current_user)):
    rows = db.query(TestSession).filter(
        TestSession.user_id == user.id, TestSession.status.in_(("active", "finished"))).order_by(TestSession.id.desc()).limit(20).all()
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
