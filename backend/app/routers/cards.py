import json
import re
from datetime import datetime, timedelta
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Flashcard, Subject, Topic, Note, Material
from app.auth import get_current_user
from app.security import validate_relations, validate_selection, save_upload
from app.services.ai import generate_content, AIError
from app.services import background
from app.services.learning_context import LearningSelection, safe_learning_provenance
from app.services.learning_generation import (prepare_generation, source_payload, learning_prompt,
    validate_generation_source, generate_job_text, generated_provenance)

router = APIRouter(prefix="/cards", tags=["cards"])


class GenerateRequest(LearningSelection):
    model_config = ConfigDict(extra="forbid")
    subject_id: int | None = Field(default=None, gt=0)
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
        "source_context": safe_learning_provenance(c.source_context_json),
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
    validate_relations(db, data.subject_id, data.topic_id)
    source = prepare_generation(db, user, data,
        [data.subject_id] if data.subject_id is not None else [],
        [data.topic_id] if data.topic_id is not None else [])
    count = max(1, min(data.count, 30))
    prompt = learning_prompt(source, f"""Составь {count} карточек для запоминания по выбранным темам.
Лицевая сторона — вопрос или термин, оборотная — короткий точный ответ (1–3 предложения).
Покрывай разные понятия, не дублируй карточки. Верни только JSON-массив:
[{{"front":"вопрос или термин", "back":"краткий ответ"}}]""")
    import hashlib
    payload = {"subject_id": data.subject_id, "topic_id": data.topic_id,
        "count": count, "prompt": prompt, **source_payload(source)}
    identity = {key: value for key, value in payload.items() if key != "source_context"}
    resource_key = "cards:" + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    job = background.enqueue_job(db, user.id, "cards", f"Карточки: {source.title}", payload, resource_key)
    job_id, user_id = job.id, user.id
    db.commit()
    result = await background.await_job_result(job_id, user_id)
    db.expire_all()
    rows = db.query(Flashcard).filter(Flashcard.user_id == user_id, Flashcard.id.in_(result["card_ids"])).all()
    by_id = {row.id: row for row in rows}
    return [card_public(by_id[item]) for item in result["card_ids"] if item in by_id]

@background.register_handler("cards")
async def _generate_cards_job(context, payload):
    with context.session() as db:
        context.require_current(db)
        validate_relations(db, payload["subject_id"], payload["topic_id"])
        validate_generation_source(context, db, payload)
    raw, research = await generate_job_text(context, payload, generate_content)
    try:
        items = parse_json(raw)
    except (ValueError, TypeError):
        raise background.JobPermanentError("ИИ вернул некорректные карточки. Повторите генерацию") from None
    if isinstance(items, dict): items = items.get("cards", [])
    if not isinstance(items, list):
        raise background.JobPermanentError("ИИ вернул некорректные карточки. Повторите генерацию")
    items = [item for item in items[:payload["count"]] if isinstance(item, dict) and str(item.get("front", "")).strip() and str(item.get("back", "")).strip()]
    if not items:
        raise background.JobPermanentError("ИИ не составил карточки. Повторите генерацию")
    with context.session() as db:
        context.require_current(db)
        validate_relations(db, payload["subject_id"], payload["topic_id"])
        validate_generation_source(context, db, payload)
        created = [Flashcard(user_id=context.user_id, subject_id=payload["subject_id"], topic_id=payload["topic_id"],
            front=str(item["front"])[:10000], back=str(item["back"])[:10000],
            source_context_json=generated_provenance(payload, research)) for item in items]
        db.add_all(created); db.flush()
        result = {"card_ids": [card.id for card in created]}
        context.complete(db, result)
        return result


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

class CardInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    front: str = Field(min_length=1, max_length=10000)
    back: str = Field(min_length=1, max_length=10000)
    subject_id: int | None = None
    topic_id: int | None = None


@router.get("")
def list_cards(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return [card_public(card) for card in db.query(Flashcard).filter(Flashcard.user_id == user.id).order_by(Flashcard.id.desc())]


@router.post("", status_code=201)
def create_card(data: CardInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    validate_relations(db, data.subject_id, data.topic_id)
    card = Flashcard(user_id=user.id, **data.model_dump())
    db.add(card)
    db.commit()
    db.refresh(card)
    return card_public(card)


@router.patch("/{card_id}")
def update_card(card_id: int, data: CardInput, db: Session = Depends(get_db), user=Depends(get_current_user)):
    card = db.query(Flashcard).filter(Flashcard.id == card_id, Flashcard.user_id == user.id).first()
    if not card:
        raise HTTPException(404, "Карточка не найдена")
    validate_relations(db, data.subject_id, data.topic_id)
    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(card, key, value)
    db.commit()
    return card_public(card)
