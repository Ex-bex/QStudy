import re
import os
import uuid
import shutil
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.database import get_db
from app.config import settings
from app.models import ChatSession, ChatMessage, Material, Note
from app.auth import get_current_user
from app.services.ai import chat_completion, transcribe_audio, AIError

router = APIRouter(prefix="/chat", tags=["chat"])

SYSTEM_PROMPT = """Ты — ИИ-ассистент StudyHub, встроенный в личную учебную платформу студента.

Твоя специализация — учёба: объясняй темы, отвечай по материалам студента, помогай готовиться к занятиям и экзаменам. Но ты не ограничен этим: поддерживай любые разговоры — общие вопросы, советы, бытовые и абстрактные темы, просто поболтать.

Как отвечать:
- На языке пользователя (обычно русский), дружелюбно и по делу, без воды
- Если даны МАТЕРИАЛЫ СТУДЕНТА, опирайся на них при вопросах об учёбе и указывай источник, например (из lecture_2.pdf) или (из заметки «Пределы»)
- Если ответа в материалах нет — честно скажи об этом и ответь из общих знаний
- Если студент чего-то не понимает — объясняй с нуля, простыми словами, с примерами
- Если не знаешь чего-то точно — так и скажи, не выдумывай"""

MAX_HISTORY = 20
CHUNK_SIZE = 1200
CHUNK_OVERLAP = 200
TOP_K = 4

_STOPWORDS = {
    "какой", "какая", "какое", "какие", "это", "для", "как", "почему", "зачем",
    "когда", "где", "кто", "есть", "быть", "был", "была", "его", "ее", "их",
    "них", "они", "мне", "тебе", "себе", "такой", "такая", "также", "чтобы",
    "если", "или", "все", "всё", "надо", "нужно", "можно", "меня", "тебя",
    "что", "чем", "так", "там", "тут",
}

def _tokenize(text: str) -> set:
    words = re.findall(r"[a-zа-яё0-9]{3,}", text.lower())
    return {w for w in words if w not in _STOPWORDS}

def _chunkify(text: str) -> list:
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        chunks.append(text[start:start + CHUNK_SIZE])
        start += CHUNK_SIZE - CHUNK_OVERLAP
    return chunks

_cache: dict = {}  # (kind, id) -> (len_text, [(chunk, tokens), ...])

def _cached_chunks(kind: str, obj_id: int, text: str):
    key = (kind, obj_id)
    cached = _cache.get(key)
    if cached and cached[0] == len(text):
        return cached[1]
    items = [(ch, _tokenize(ch)) for ch in _chunkify(text)]
    _cache[key] = (len(text), items)
    return items

def search_context(db: Session, user_id: int, query: str) -> str:
    """Простой RAG: ищем куски файлов и заметок с пересечением ключевых слов."""
    q_tokens = _tokenize(query)
    if not q_tokens:
        return ""

    scored = []
FILE_INTENT_WORDS = (
    "файл", "пдф", "pdf", "документ", "материал", "заметк",
    "лекци", "конспект", "прочитай", "изучи", "загрузил", "загрузила",
    "посмотри", "что это", "о чём",
)

def materials_overview(db: Session, user_id: int) -> str:
    """Краткий обзор всех материалов — когда вопрос про файлы, но поиск не сработал."""
    parts = []
    materials = db.query(Material).filter(
        Material.user_id == user_id,
        Material.processed == True,  # noqa: E712
    ).order_by(Material.id.desc()).limit(10).all()
    for m in materials:
        head = (m.extracted_text or "").replace("\n", " ")[:400]
        parts.append(f"Файл «{m.filename}»: {head}...")

    notes = db.query(Note).filter(Note.user_id == user_id) \
                  .order_by(Note.id.desc()).limit(10).all()
    for n in notes:
        head = (n.content or "").replace("\n", " ")[:300]
        parts.append(f"Заметка «{n.title}»: {head}...")

    return "\n\n".join(parts)

    materials = db.query(Material).filter(
        Material.user_id == user_id, Material.processed == True).all()  # noqa: E712
    for m in materials:
        for chunk, tokens in _cached_chunks("material", m.id, m.extracted_text or ""):
            score = len(q_tokens & tokens)
            if score:
                scored.append((score, f"файл «{m.filename}»", chunk))

    notes = db.query(Note).filter(Note.user_id == user_id).all()
    for n in notes:
        text = f"{n.title}\n{n.content or ''}"
        for chunk, tokens in _cached_chunks("note", n.id, text):
            score = len(q_tokens & tokens)
            if score:
                scored.append((score, f"заметка «{n.title}»", chunk))

    if not scored:
        return ""
    scored.sort(key=lambda x: -x[0])
    parts = [f"[Источник: {src}]\n{chunk}" for _, src, chunk in scored[:TOP_K]]
    return "\n\n---\n\n".join(parts)

def _session_owned(db: Session, session_id: int, user) -> ChatSession:
    s = db.query(ChatSession).filter(
        ChatSession.id == session_id, ChatSession.user_id == user.id).first()
    if not s:
        raise HTTPException(404, "Чат не найден")
    return s

@router.get("/sessions")
def list_sessions(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return db.query(ChatSession).filter(
        ChatSession.user_id == user.id).order_by(ChatSession.id.desc()).all()

@router.delete("/sessions/{session_id}")
def delete_session(session_id: int, db: Session = Depends(get_db),
                   user=Depends(get_current_user)):
    s = _session_owned(db, session_id, user)
    db.delete(s)
    db.commit()
    return {"ok": True}
``

@router.get("/sessions/{session_id}/messages")
def get_messages(session_id: int, db: Session = Depends(get_db),
                 user=Depends(get_current_user)):
    _session_owned(db, session_id, user)
    return db.query(ChatMessage).filter(
        ChatMessage.session_id == session_id).order_by(ChatMessage.id).all()

class SendRequest(BaseModel):
    session_id: Optional[int] = None
    message: str
    context: Optional[dict] = None

@router.post("/send")
async def send_message(data: SendRequest, db: Session = Depends(get_db), user=Depends(get_current_user)):
    text = data.message.strip()
    if not text:
        raise HTTPException(400, "Пустое сообщение")

    if data.session_id:
        session = _session_owned(db, data.session_id, user)
    else:
        session = ChatSession(user_id=user.id, title=text[:50])
        db.add(session)
        db.commit()
        db.refresh(session)

    user_msg = ChatMessage(session_id=session.id, role="user", content=text)
    db.add(user_msg)
    db.commit()
    db.refresh(user_msg)

    # История (включая только что добавленный вопрос) → формат Gemini
    rows = db.query(ChatMessage).filter(
        ChatMessage.session_id == session.id).order_by(ChatMessage.id.desc()) \
        .limit(MAX_HISTORY + 1).all()[::-1]
    contents = [
        {"role": "model" if m.role == "assistant" else "user",
         "parts": [{"text": m.content}]}
        for m in rows
    ]

    # --- Контекстная осведомлённость: что студент делает прямо сейчас ---
    ctx_lines = []
    if data.context:
        c = data.context
        page_names = {
            "dashboard": "главная", "subjects": "Предметы", "notes": "Заметки",
            "files": "Файлы", "voice": "Диктофон", "tasks": "Тренажёр",
            "exam": "Экзаменатор", "review": "Повторение (карточки)",
            "chat": "Чат",
        }
        page = page_names.get(c.get("page", ""), c.get("page"))
        if page and page != "Чат":
            ctx_lines.append(f"- Страница: {page}")
        if c.get("subject"):
            ctx_lines.append(f"- Предмет: {c['subject']}")
        if c.get("topic"):
            ctx_lines.append(f"- Тема: {c['topic']}")
        task = c.get("task")
        if task:
            ctx_lines.append(
                f"- Студент сейчас работает над задачей (Тренажёр):\n"
                f"  Вопрос задачи: {task.get('question', '')}\n"
                f"  Статус: {task.get('status', 'unknown')}")
        exam_q = c.get("exam_question")
        if exam_q:
            ctx_lines.append(f"- Идёт экзамен, текущий вопрос: {exam_q}")

    activity = ("\n\nТЕКУЩАЯ АКТИВНОСТЬ СТУДЕНТА (ты видишь, чем он занят, "
                "и подстраивайся: если он спрашивает «не понимаю» — объясняй "
                "именно его текущую задачу/тему, не переспрашивая):\n"
                + "\n".join(ctx_lines)) if ctx_lines else ""

    # --- RAG: поиск по материалам ---
    context = search_context(db, user.id, text)

    # Доп. поиск: если студент работает над задачей — ищем ещё и по её тексту
    # (в коротком «не понимаю» нет ключевых слов, поэтому ищем по самой задаче)
    if data.context and data.context.get("task"):
        task_text = data.context["task"].get("question", "")
        if task_text:
            extra = search_context(db, user.id, task_text)
            if extra and extra not in (context or ""):
                context = (context + "\n\n" + extra) if context else extra

    # Запасной сценарий: вопрос явно про материалы, но ключевых слов не нашлось
    if not context:
        low = text.lower()
        if any(w in low for w in FILE_INTENT_WORDS):
            context = materials_overview(db, user.id)

    # --- Сборка системного промпта: база + активность + материалы ---
    system = SYSTEM_PROMPT + activity
    if context:
        system += ("\n\nМАТЕРИАЛЫ СТУДЕНТА (наиболее релевантные куски "
                   "к текущему вопросу):\n\n" + context)

    try:
        answer = await chat_completion(system, contents)
    except AIError as e:
        raise HTTPException(502, str(e))

    ai_msg = ChatMessage(session_id=session.id, role="assistant", content=answer)
    db.add(ai_msg)
    db.commit()
    db.refresh(ai_msg)

    return {
        "session_id": session.id,
        "session_title": session.title,
        "user_message": user_msg,
        "assistant_message": ai_msg,
    }

@router.post("/transcribe")
async def transcribe_voice(file: UploadFile = File(...),
                           user=Depends(get_current_user)):
    """Голосовое → текст для поля ввода чата."""
    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    tmp = os.path.join(settings.UPLOAD_DIR, f"tmp_{uuid.uuid4().hex}_{file.filename}")
    with open(tmp, "wb") as f:
        shutil.copyfileobj(file.file, f)
    try:
        text = await transcribe_audio(tmp)
    except AIError as e:
        raise HTTPException(502, str(e))
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    return {"text": text}
