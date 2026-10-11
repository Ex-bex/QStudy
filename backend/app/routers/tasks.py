import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Task, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.security import validate_relations, validate_selection, save_upload
from app.services.ai import generate_content, AIError
from app.services import background
from app.services.learning_context import LearningSelection, safe_learning_provenance
from app.services.learning_generation import (prepare_generation, source_payload, learning_prompt,
    validate_generation_source, generate_job_text, generated_provenance)

router = APIRouter(prefix="/tasks", tags=["tasks"])


class GenerateRequest(LearningSelection):
    model_config = ConfigDict(extra="forbid")
    subject_id: int | None = Field(default=None, gt=0)
    topic_id: Optional[int] = None
    difficulty: str = Field(default="medium", pattern="^(easy|medium|hard)$")   # easy / medium / hard
    count: int = 5


class AnswerRequest(BaseModel):
    answer: str = Field(min_length=1, max_length=20000)


def parse_json(raw: str):
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
    return json.loads(raw)


def task_public(t: Task) -> dict:
    # Эталонный answer НЕ отдаём клиенту — чтобы решать честно
    return {
        "id": t.id, "question": t.question, "hint": t.hint,
        "difficulty": t.difficulty, "status": t.status,
        "user_answer": t.user_answer, "subject_id": t.subject_id,
        "topic_id": t.topic_id, "created_at": str(t.created_at),
        "source_context": safe_learning_provenance(t.source_context_json),
    }


@router.post("/generate")
async def generate_tasks(data: GenerateRequest, db: Session = Depends(get_db),
                         user=Depends(get_current_user)):
    validate_relations(db, data.subject_id, data.topic_id)
    source = prepare_generation(db, user, data,
        [data.subject_id] if data.subject_id is not None else [],
        [data.topic_id] if data.topic_id is not None else [])
    count = max(1, min(data.count, 10))
    prompt = learning_prompt(source, f"""Составь {count} разнообразных задач или вопросов уровня «{data.difficulty}».
Проверяй понимание: определения, сравнения, расчёты и небольшие практические случаи по выбранным темам.
Подсказка не должна раскрывать ответ. Верни только JSON-массив:
[{{"question":"вопрос", "answer":"эталонный ответ с объяснением", "hint":"подсказка"}}]""")
    import hashlib
    payload = {"subject_id": data.subject_id, "topic_id": data.topic_id,
        "difficulty": data.difficulty, "count": count, "prompt": prompt,
        "sources": [source.title], **source_payload(source)}
    identity = {key: value for key, value in payload.items() if key != "source_context"}
    resource_key = "tasks:" + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    job = background.enqueue_job(db, user.id, "tasks", f"Упражнения: {source.title}", payload, resource_key)
    job_id, user_id = job.id, user.id
    db.commit()
    result = await background.await_job_result(job_id, user_id)
    db.expire_all()
    rows = db.query(Task).filter(Task.user_id == user_id, Task.id.in_(result["task_ids"])).all()
    by_id = {row.id: row for row in rows}
    return {"tasks": [task_public(by_id[item]) for item in result["task_ids"] if item in by_id],
            "sources": result["sources"]}

@background.register_handler("tasks")
async def _generate_tasks_job(context, payload):
    with context.session() as db:
        context.require_current(db)
        validate_relations(db, payload["subject_id"], payload["topic_id"])
        validate_generation_source(context, db, payload)
    raw, research = await generate_job_text(context, payload, generate_content)
    try:
        items = parse_json(raw)
    except (ValueError, TypeError):
        raise background.JobPermanentError("ИИ вернул некорректные упражнения. Повторите генерацию") from None
    if isinstance(items, dict): items = items.get("tasks", [])
    if not isinstance(items, list):
        raise background.JobPermanentError("ИИ вернул некорректные упражнения. Повторите генерацию")
    items = [item for item in items[:payload["count"]] if isinstance(item, dict) and isinstance(item.get("question"), str) and item["question"].strip()]
    if not items:
        raise background.JobPermanentError("ИИ не составил упражнения. Повторите генерацию")
    with context.session() as db:
        context.require_current(db)
        validate_relations(db, payload["subject_id"], payload["topic_id"])
        validate_generation_source(context, db, payload)
        created = [Task(user_id=context.user_id, subject_id=payload["subject_id"], topic_id=payload["topic_id"],
            question=item["question"][:20000], answer=str(item.get("answer", ""))[:20000],
            hint=str(item.get("hint", ""))[:10000], difficulty=payload["difficulty"],
            source_context_json=generated_provenance(payload, research)) for item in items]
        db.add_all(created); db.flush()
        result = {"task_ids": [task.id for task in created], "sources": payload["sources"]}
        context.complete(db, result)
        return result

@router.post("/{task_id}/answer")
async def answer_task(task_id: int, data: AnswerRequest, db: Session = Depends(get_db),
                      user=Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == user.id).first()
    if not task:
        raise HTTPException(404, "Задача не найдена")
    if not data.answer.strip():
        raise HTTPException(400, "Ответ пустой")

    prompt = f"""Проверь ответ студента как преподаватель.

Вопрос: {task.question}
Эталонный ответ: {task.answer or "(эталона нет, оцени по сути вопроса)"}
Ответ студента: {data.answer}

Верни СТРОГО JSON без текста вокруг:
{{"verdict": "correct|partial|wrong", "score": число 0-100, "feedback": "разбор по-русски: что верно, в чём ошибка, как правильно. 2-5 предложений"}}
"""
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

    task.user_answer = data.answer
    task.status = {"correct": "solved", "partial": "partial", "wrong": "failed"}[verdict]
    db.commit()
    db.refresh(task)
    return {
        "task": task_public(task),
        "verdict": verdict,
        "score": max(0, min(100, int(result.get("score", 0)))),
        "feedback": result.get("feedback", ""),
    }


@router.get("")
def list_tasks(subject_id: Optional[int] = None, db: Session = Depends(get_db),
               user=Depends(get_current_user)):
    q = db.query(Task).filter(Task.user_id == user.id)
    if subject_id:
        q = q.filter(Task.subject_id == subject_id)
    return [task_public(t) for t in q.order_by(Task.id.desc()).all()]


@router.delete("/{task_id}")
def delete_task(task_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == user.id).first()
    if not task:
        raise HTTPException(404, "Задача не найдена")
    db.delete(task)
    db.commit()
    return {"ok": True}

class TaskInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = Field(min_length=1, max_length=20000)
    answer: str = Field(default="", max_length=20000)
    hint: str = Field(default="", max_length=10000)
    difficulty: str = Field(default="medium", pattern="^(easy|medium|hard)$")
    subject_id: int | None = None
    topic_id: int | None = None


@router.post("", status_code=201)
def create_task(data: TaskInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    validate_relations(db, data.subject_id, data.topic_id)
    task = Task(user_id=user.id, **data.model_dump())
    db.add(task)
    db.commit()
    db.refresh(task)
    return task_public(task)


@router.patch("/{task_id}")
def update_task(task_id: int, data: TaskInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    task = db.query(Task).filter(Task.id == task_id, Task.user_id == user.id).first()
    if not task:
        raise HTTPException(404, "Задача не найдена")
    validate_relations(db, data.subject_id, data.topic_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(task, key, value)
    task.status = "new"
    task.user_answer = ""
    db.commit()
    return task_public(task)
