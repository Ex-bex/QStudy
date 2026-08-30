import json
import re
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Flashcard, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.services.ai import generate_content, AIError

router = APIRouter(prefix="/cards", tags=["cards"])

class GenerateRequest(BaseModel):
    subject_id: int
    topic_id: Optional[int] = None
    count: int = 10

class ReviewRequest(BaseModel):
    quality: int  # 0-2: 0 = забыл, 1 = с трудом, 2 = помню

def parse_json(raw: str):
    raw = raw.strip()
    if raw.startswith("```"):
        raw = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw, flags=re.S)
    return json.loads(raw)

def card_public(c: Flashcard) -> dict:
    return {
        "id": c.id, "front": c.front, "back": c.back,
        "subject_id": c.subject_id, "topic_id": c.topic_id,
        "interval": c.interval, "repetitions": c.repetitions,
        "next_review": str(c.next_review), "created_at": str(c.created_at),
    }

def sm2(card: Flashcard, quality: int):
    """Алгоритм SM-2 (упрощённый Anki).
    quality: 0 = забыл, 1 = с трудом, 2 = помню"""
    if quality == 0:
        card.repetitions = 0
        card.interval = 1
    elif quality == 1:
        card.repetitions += 0  # не растёт, но и не сбрасывается
        card.interval = max(1, round(card.interval * 0.6) if card.interval else 1)
        if card.interval < 1:
            card.interval = 1
    else:
        card.repetitions += 1
        if card.repetitions == 1:
            card.interval = 1
        elif card.repetitions == 2:
            card.interval = 3
        else:
            card.interval = round(card.interval * card.ease_factor)

    card.ease_factor = max(1.3, card.ease_factor + (0.1 if quality == 2 else -0.2 if quality == 0 else 0))
    card.next_review = datetime.utcnow() + timedelta(days=card.interval)
    return card

@router.post("/generate")
async def generate_cards(data: GenerateRequest, db: Session = Depends(get_db),
                         user=Depends(get_current_user)):
    subject = db.query(Subject).filter(
        Subject.id == data.subject_id, Subject.user_id == user.id).first()
    if not subject:
        raise HTTPException(404, "Предмет не найден")
    topic = None
    if data.topic_id:
        topic = db.query(Topic).filter(Topic.id == data.topic_id).first()

    parts = []
    q = db.query(Note).filter(Note.user_id == user.id, Note.subject_id == data.subject_id)
    if topic:
        q = q.filter(Note.topic_id == topic.id)
    for n in q.limit(5):
        parts.append(f"Заметка «{n.title}»:\n{(n.content or '')[:2000]}")

    qm = db.query(Material).filter(
        Material.user_id == user.id, Material.subject_id == data.subject_id,
        Material.processed == True)  # noqa: E712
    if topic:
        qm = qm.filter(Material.topic_id == topic.id)
    for m in qm.limit(5):
        if m.extracted_text:
            parts.append(f"Материал «{m.filename}»:\n{m.extracted_text[:2000]}")
    context = "\n\n".join(parts)

    count = max(1, min(data.count, 30))
    prompt = f"Предмет: «{subject.name}»."
    if topic:
        prompt += f" Тема: «{topic.title}»."
    prompt += f"""
Составь {count} флеш-карточек для запоминания. Формат: лицевая сторона — вопрос/термин,
оборотная — короткий точный ответ (1-3 предложения). Покрывай разные факты: определения,
формулы, даты, классификации — что уместно для предмета.

{("Опирайся ТОЛЬКО на материалы студента ниже." if context else "Материалов нет — используй базовые знания по предмету.")}

{f"МАТЕРИАЛЫ СТУДЕНТА:{chr(10)}{context}" if context else ""}

Верни СТРОГО JSON-массив без текста вокруг:
[{{"front": "вопрос или термин", "back": "краткий ответ"}}]"""

    try:
        raw = await generate_content(prompt, json_mode=True)
        items = parse_json(raw)
    except AIError as e:
        raise HTTPException(502, str(e))
    except Exception:
        raise HTTPException(502, "ИИ вернул неожиданный формат — попробуй ещё раз")

    if isinstance(items, dict):
        items = items.get("cards", [])

    created = []
    for item in items[:count]:
        if not isinstance(item, dict) or not item.get("front") or not item.get("back"):
            continue
        card = Flashcard(
            user_id=user.id, subject_id=data.subject_id,
            topic_id=topic.id if topic else None,
            front=str(item["front"]), back=str(item["back"]),
        )
        db.add(card)
        created.append(card)
    db.commit()
    return [card_public(c) for c in created]

@router.get("/due")
def due_cards(subject_id: Optional[int] = None, db: Session = Depends(get_db),
              user=Depends(get_current_user)):
    """Карточки, которые пора повторить сегодня."""
    q = db.query(Flashcard).filter(
        Flashcard.user_id == user.id,
        Flashcard.next_review <= datetime.utcnow(),
    )
    if subject_id:
        q = q.filter(Flashcard.subject_id == subject_id)
    cards = q.order_by(Flashcard.next_review).limit(50).all()
    return [card_public(c) for c in cards]

@router.get("/stats")
def stats(db: Session = Depends(get_db), user=Depends(get_current_user)):
    total = db.query(Flashcard).filter(Flashcard.user_id == user.id).count()
    due = db.query(Flashcard).filter(
        Flashcard.user_id == user.id,
        Flashcard.next_review <= datetime.utcnow(),
    ).count()
    return {"total": total, "due": due}

@router.post("/{card_id}/review")
def review_card(card_id: int, data: ReviewRequest, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    card = db.query(Flashcard).filter(
        Flashcard.id == card_id, Flashcard.user_id == user.id).first()
    if not card:
        raise HTTPException(404, "Карточка не найдена")
    if data.quality not in (0, 1, 2):
        raise HTTPException(400, "quality должен быть 0, 1 или 2")

    sm2(card, data.quality)
    db.commit()
    db.refresh(card)
    return {
        "card": card_public(card),
        "next_in_days": card.interval,
    }

@router.delete("/{card_id}")
def delete_card(card_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    card = db.query(Flashcard).filter(
        Flashcard.id == card_id, Flashcard.user_id == user.id).first()
    if not card:
        raise HTTPException(404, "Карточка не найдена")
    db.delete(card)
    db.commit()
    return {"ok": True}
