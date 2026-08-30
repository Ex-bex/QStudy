import json
import re
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Task, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.services.ai import generate_content, AIError

router = APIRouter(prefix="/tasks", tags=["tasks"])

class GenerateRequest(BaseModel):
    subject_id: int
    topic_id: Optional[int] = None
    difficulty: str = "medium"   # easy / medium / hard
    count: int = 5

class AnswerRequest(BaseModel):
    answer: str

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
    }

@router.post("/generate")
async def generate_tasks(data: GenerateRequest, db: Session = Depends(get_db),
                         user=Depends(get_current_user)):
    subject = db.query(Subject).filter(
        Subject.id == data.subject_id, Subject.user_id == user.id).first()
    if not subject:
        raise HTTPException(404, "Предмет не найден")
    topic = None
    if data.topic_id:
        topic = db.query(Topic).filter(Topic.id == data.topic_id).first()
        if not topic:
            raise HTTPException(404, "Тема не найдена")

    def find_notes(topic_id: Optional[int]):
        q = db.query(Note).filter(Note.user_id == user.id,
                                  Note.subject_id == data.subject_id)
        if topic_id:
            q = q.filter(Note.topic_id == topic_id)
        return q.limit(5).all()

    def find_materials(topic_id: Optional[int]):
        qm = db.query(Material).filter(
            Material.user_id == user.id, Material.subject_id == data.subject_id,
            Material.processed == True)  # noqa: E712
        if topic_id:
            qm = qm.filter(Material.topic_id == topic_id)
        return [m for m in qm.limit(5) if m.extracted_text]

    # Сначала ищем в рамках выбранной темы; если пусто — расширяем до предмета
    topic_id = topic.id if topic else None
    notes_list = find_notes(topic_id)
    materials = find_materials(topic_id)
    if topic and not notes_list and not materials:
        notes_list = find_notes(None)
        materials = find_materials(None)

    parts, sources = [], []
    for n in notes_list:
        parts.append(f"Заметка «{n.title}»:\n{(n.content or '')[:2000]}")
        sources.append(f"заметка «{n.title}»")
    for m in materials:
        parts.append(f"Материал «{m.filename}»:\n{m.extracted_text[:4000]}")
        sources.append(f"файл «{m.filename}»")
    context = "\n\n".join(parts)

    count = max(1, min(data.count, 10))
    prompt = f"Ты — преподаватель предмета «{subject.name}»."
    if topic:
        prompt += f" Тема: «{topic.title}»."

    if context:
        prompt += f"""
    Составь {count} задач или вопросов уровня «{data.difficulty}» СТРОГО по материалам студента ниже.
    Не задавай вопросов по темам, которых нет в материалах. Формы разнообразь: определения,
    «почему», «сравни», расчёты, мини-кейсы — но каждый вопрос должен быть ответим ИЗ этих материалов.

    МАТЕРИАЛЫ СТУДЕНТА:
    {context}
    """
        else:
        prompt += f"""
    Составь {count} задач или вопросов уровня «{data.difficulty}» для проверки знаний студента.
    Материалов у студента нет — используй свои знания по предмету.
    Формы разнообразь: определения, «почему», расчёты, мини-кейсы — где уместно.
    """

        prompt += """
    Верни СТРОГО JSON-массив, без текста вокруг:
    [{"question": "текст вопроса", "answer": "эталонный ответ с объяснением", "hint": "подсказка, не раскрывающая ответ"}]
    """

    try:
        raw = await generate_content(prompt, json_mode=True)
        items = parse_json(raw)
    except AIError as e:
        raise HTTPException(502, str(e))
    except Exception:
        raise HTTPException(502, "ИИ вернул неожиданный формат — попробуй ещё раз")

    if isinstance(items, dict):
        items = items.get("tasks", [])

    created = []
    for item in items[:count]:
        if not isinstance(item, dict) or not item.get("question"):
            continue
        task = Task(
            user_id=user.id, subject_id=data.subject_id,
            topic_id=topic.id if topic else None,
            question=item["question"], answer=str(item.get("answer", "")),
            hint=str(item.get("hint", "")), difficulty=data.difficulty,
        )
        db.add(task)
        created.append(task)
    db.commit()
    return {"tasks": [task_public(t) for t in created], "sources": sources}

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
    return {"task": task_public(task),"verdict": verdict,"score": int(result.get("score", 0)), "feedback": result.get("feedback", ""),}

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
