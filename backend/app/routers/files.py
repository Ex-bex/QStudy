import os
import uuid
import shutil
import asyncio
import hashlib
from fastapi.responses import FileResponse
from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from typing import Optional
from sqlalchemy.orm import Session
from app.database import get_db
from app.models import Material
from app.auth import get_current_user
from app.config import settings
from app.services.extract import extract_document
from app.services.ai import analyze_media, AIError
from app.services import background
from app.security import save_upload, safe_upload_path, validate_relations
from pydantic import BaseModel, Field, ConfigDict

router = APIRouter(prefix="/files", tags=["files"])

ALLOWED = {
    "pdf": "pdf", "docx": "docx",
    "xlsx": "xlsx", "pptx": "pptx",
    "png": "image", "jpg": "image", "jpeg": "image", "webp": "image", "gif": "image",
    "mp3": "audio", "wav": "audio", "ogg": "audio", "m4a": "audio", "webm": "audio",
    "mp4": "video", "mov": "video", "avi": "video", "mkv": "video",
    "txt": "text", "md": "text",
}

MEDIA_PROMPTS = {
    "image": "Это учебный материал студента. Извлеки ВЕСЬ видимый текст (доска, конспекты от руки, слайды). Формулы запиши в LaTeX. Кратко опиши важные схемы и рисунки. Верни только содержимое, без вступлений.",
    "audio": "Это учебная аудиозапись (лекция/семинар). Сделай подробную структурированную расшифровку: темы — подзаголовками, сохрани определения и формулы. В конце добавь раздел '## Кратко' с 5-10 ключевыми тезисами. Верни только текст.",
    "video": "Это учебное видео. Расшифруй речь и опиши важное с экрана (слайды, доска; формулы — в LaTeX). Структурируй подзаголовками. В конце добавь раздел '## Кратко' с ключевыми тезисами. Верни только текст.",
}

MEDIA_MIME = {
    "image": {"png": ["image/png"], "jpg": ["image/jpeg"], "jpeg": ["image/jpeg"],
              "webp": ["image/webp"], "gif": ["image/gif"]},
    "audio": {"webm": ["audio/webm", "video/webm"], "ogg": ["audio/ogg"],
              "mp3": ["audio/mp3"], "wav": ["audio/wav"], "m4a": ["audio/mp4"]},
    "video": {"mp4": ["video/mp4"], "mov": ["video/mov", "video/mp4"],
              "avi": ["video/avi"], "mkv": ["video/x-matroska"], "webm": ["video/webm"]},
}


def _ext(path: str) -> str:
    return path.rsplit(".", 1)[-1].lower()

def detect_type(filename: str) -> str:
    ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return ALLOWED.get(ext, "other")


@router.post("/upload")
async def upload_file(
    file: UploadFile = File(...),
    subject_id: Optional[int] = Form(None),
    topic_id: Optional[int] = Form(None),
    db: Session = Depends(get_db),
    user=Depends(get_current_user),
):
    file_type = detect_type(file.filename or "")
    if file_type == "other":
        raise HTTPException(400, "Неподдерживаемый формат")

    validate_relations(db, subject_id, topic_id)
    filename, filepath, size = await save_upload(file, set(ALLOWED))

    material = Material(
        user_id=user.id, subject_id=subject_id, topic_id=topic_id,
        filename=filename, filepath=filepath,
        file_type=file_type, size=size,
    )
    db.add(material)
    db.commit()
    db.refresh(material)
    return material_public(material)


@router.get("")
def list_files(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return [material_public(m) for m in db.query(Material).filter(Material.user_id == user.id)
            .order_by(Material.created_at.desc()).all()]


@router.delete("/{material_id}")
def delete_file(material_id: int, db: Session = Depends(get_db),
                user=Depends(get_current_user)):
    material = db.query(Material).filter(
        Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    safe_upload_path(material.filepath).unlink(missing_ok=True)
    db.delete(material)
    db.commit()
    return {"ok": True}

@router.get("/{material_id}/download")
def download_file(material_id: int, db: Session = Depends(get_db),
                  user=Depends(get_current_user)):
    material = db.query(Material).filter(
        Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    path = safe_upload_path(material.filepath)
    if not path.is_file():
        raise HTTPException(404, "Файл отсутствует на диске")
    return FileResponse(path, filename=material.filename, media_type="application/octet-stream")

@router.post("/{material_id}/process")
async def process_material(material_id: int, db: Session = Depends(get_db),
                           user=Depends(get_current_user)):
    material = db.query(Material).filter(
        Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    path = safe_upload_path(material.filepath)
    if not path.is_file():
        raise HTTPException(404, "Файл отсутствует на диске")

    fingerprint = await asyncio.to_thread(_file_digest, path)
    job = background.enqueue_job(db, user.id, "file", f"Обработка: {material.filename}",
        {"material_id": material.id, "size": material.size, "file_type": material.file_type,
         "sha256": fingerprint}, resource_key=f"file:{material.id}")
    job_id, user_id = job.id, user.id
    db.commit()
    return await background.await_job_result(job_id, user_id)


def _file_digest(path):
    digest = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _job_file(context, db, payload):
    context.require_current(db)
    material = db.query(Material).filter(Material.id == payload["material_id"], Material.user_id == context.user_id).first()
    if not material or material.file_type != payload["file_type"] or material.size != payload["size"]:
        raise background.JobCancelled("Файл удалён или изменён; обработка остановлена")
    path = safe_upload_path(material.filepath)
    if not path.is_file() or path.stat().st_size != payload["size"]:
        raise background.JobCancelled("Файл отсутствует или изменён; обработка остановлена")
    return material, path


@background.register_handler("file")
async def _process_file_job(context, payload):
    with context.session() as db:
        _, path = _job_file(context, db, payload)
    if await asyncio.to_thread(_file_digest, path) != payload["sha256"]:
        raise background.JobCancelled("Содержимое файла изменено; обработка остановлена")
    text = context.get_checkpoint().get("text")
    if text is None:
        if payload["file_type"] in ("image", "audio", "video"):
            mimes = MEDIA_MIME.get(payload["file_type"], {}).get(_ext(str(path)), [])
            if not mimes:
                raise background.JobPermanentError("Неизвестный медиаформат")
            text = await analyze_media(MEDIA_PROMPTS[payload["file_type"]], str(path), mimes)
        else:
            try:
                text = await asyncio.to_thread(extract_document, str(path), payload["file_type"])
            except Exception:
                raise background.JobPermanentError("Не удалось извлечь текст из файла") from None
        text = text[:150000]
        context.save_checkpoint({"text": text})
    with context.session() as db:
        material, path = _job_file(context, db, payload)
        if await asyncio.to_thread(_file_digest, path) != payload["sha256"]:
            raise background.JobCancelled("Содержимое файла изменено; обработка остановлена")
        material.extracted_text = text
        material.processed = True
        result = {"ok": True, "chars": len(text), "material_id": material.id}
        context.complete(db, result)
        return result

@router.get("/{material_id}/text")
def get_extracted_text(material_id: int, db: Session = Depends(get_db),
                       user=Depends(get_current_user)):
    material = db.query(Material).filter(
        Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    return {
        "id": material.id,
        "filename": material.filename,
        "processed": material.processed,
        "text": material.extracted_text or "",
    }


def material_public(material):
    return {key: getattr(material, key) for key in (
        "id", "subject_id", "topic_id", "filename", "file_type", "size", "processed", "created_at")}


class MaterialUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    filename: str | None = Field(default=None, min_length=1, max_length=180)
    subject_id: int | None = None
    topic_id: int | None = None


@router.patch("/{material_id}")
def update_material(material_id: int, data: MaterialUpdate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    material = db.query(Material).filter(Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    values = data.model_dump(exclude_unset=True)
    validate_relations(db, values.get("subject_id", material.subject_id), values.get("topic_id", material.topic_id))
    if "filename" in values:
        name = (values["filename"] or "").strip()
        if not name or any(char in name for char in ("/", "\\", "\r", "\n")):
            raise HTTPException(422, "Некорректное название файла")
        # Renaming never changes the actual stored type or extension.
        ext = os.path.splitext(material.filename)[1]
        values["filename"] = name if name.lower().endswith(ext.lower()) else name + ext
    for key, value in values.items():
        setattr(material, key, value)
    db.commit()
    return material_public(material)
