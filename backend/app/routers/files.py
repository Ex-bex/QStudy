import os
import uuid
import shutil
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

router = APIRouter(prefix="/files", tags=["files"])

ALLOWED = {
    "pdf": "pdf", "doc": "docx", "docx": "docx",
    "xls": "xlsx", "xlsx": "xlsx", "ppt": "pptx", "pptx": "pptx",
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
    file_type = detect_type(file.filename)
    if file_type == "other":
        raise HTTPException(400, "Неподдерживаемый формат")

    os.makedirs(settings.UPLOAD_DIR, exist_ok=True)
    safe_name = f"{uuid.uuid4().hex}_{file.filename}"
    filepath = os.path.join(settings.UPLOAD_DIR, safe_name)

    with open(filepath, "wb") as f:
        shutil.copyfileobj(file.file, f)

    material = Material(
        user_id=user.id, subject_id=subject_id, topic_id=topic_id,
        filename=file.filename, filepath=filepath,
        file_type=file_type, size=os.path.getsize(filepath),
    )
    db.add(material)
    db.commit()
    db.refresh(material)
    return material

@router.get("")
def list_files(db: Session = Depends(get_db), user=Depends(get_current_user)):
    return db.query(Material).filter(Material.user_id == user.id) \ .order_by(Material.created_at.desc()).all()

@router.delete("/{material_id}")
def delete_file(material_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    material = db.query(Material).filter(
        Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    if os.path.exists(material.filepath):
        os.remove(material.filepath)
    db.delete(material)
    db.commit()
    return {"ok": True}

@router.get("/{material_id}/download")
def download_file(material_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    material = db.query(Material).filter(
        Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    return FileResponse(material.filepath, filename=material.filename)

@router.post("/{material_id}/process")
async def process_material(material_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
    material = db.query(Material).filter(
        Material.id == material_id, Material.user_id == user.id).first()
    if not material:
        raise HTTPException(404, "Файл не найден")
    if not os.path.exists(material.filepath):
        raise HTTPException(404, "Файл отсутствует на диске")

    try:
        if material.file_type in ("image", "audio", "video"):
            mimes = MEDIA_MIME.get(material.file_type, {}).get(_ext(material.filepath), [])
            if not mimes:
                raise HTTPException(400, "Неизвестный медиаформат")
            text = await analyze_media(MEDIA_PROMPTS[material.file_type], material.filepath, mimes)
        else:
            text = extract_document(material.filepath, material.file_type)
    except AIError as e:
        raise HTTPException(502, str(e))
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(500, "Не удалось извлечь текст из файла")

    material.extracted_text = text
    material.processed = True
    db.commit()
    return {"ok": True, "chars": len(text)}

@router.get("/{material_id}/text")
def get_extracted_text(material_id: int, db: Session = Depends(get_db), user=Depends(get_current_user)):
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
