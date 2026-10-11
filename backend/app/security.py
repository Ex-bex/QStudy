"""Shared limits, relation validation and safe private upload storage."""
from collections import defaultdict, deque
from pathlib import Path
from threading import Lock
from time import monotonic
from uuid import uuid4
import zipfile
import ipaddress
import secrets
from fastapi import HTTPException, UploadFile, Request
from app.config import settings
from app.storage import relative_upload_path, resolve_upload_path

_lock = Lock()
_attempts = defaultdict(deque)


def rate_limit(key: str, limit: int = 10, seconds: int = 900):
    if not settings.RATE_LIMIT_ENABLED:
        return
    now = monotonic()
    with _lock:
        # Bound memory; all retained windows are at most fifteen minutes.
        if len(_attempts) > 5000:
            for old_key in list(_attempts):
                if not _attempts[old_key] or _attempts[old_key][-1] < now - 900:
                    _attempts.pop(old_key, None)
            if len(_attempts) > 10000:
                raise HTTPException(429, "Слишком много запросов. Повторите позже", headers={"Retry-After": "60"})
        attempts = _attempts[key]
        while attempts and attempts[0] <= now - seconds:
            attempts.popleft()
        if len(attempts) >= limit:
            raise HTTPException(429, "Слишком много запросов. Повторите позже", headers={"Retry-After": str(seconds)})
        attempts.append(now)


def client_key(request: Request) -> str:
    # Only the BFF with a shared private key can supply the IP set by our edge proxy.
    key = request.headers.get("x-qstudy-proxy-key", "")
    if settings.BFF_PROXY_SECRET and secrets.compare_digest(key.encode(), settings.BFF_PROXY_SECRET.encode()):
        forwarded = request.headers.get("x-qstudy-client-ip", "")
        try:
            return str(ipaddress.ip_address(forwarded))
        except ValueError:
            pass
    return request.client.host if request.client else "unknown"


def validate_relations(db, subject_id=None, topic_id=None):
    from app.models import Subject, Topic
    if subject_id is not None and not db.get(Subject, subject_id):
        raise HTTPException(404, "Предмет не найден")
    if topic_id is not None:
        topic = db.get(Topic, topic_id)
        if not topic:
            raise HTTPException(404, "Тема не найдена")
        if subject_id is not None and topic.subject_id != subject_id:
            raise HTTPException(422, "Тема не принадлежит выбранному предмету")


def validate_selection(db, subject_ids, topic_ids):
    from app.models import Subject, Topic
    ids = set(subject_ids)
    subjects = db.query(Subject).filter(Subject.id.in_(ids)).all()
    if len(subjects) != len(ids):
        raise HTTPException(404, "Предмет не найден")
    if topic_ids:
        topics = db.query(Topic).filter(Topic.id.in_(set(topic_ids)), Topic.subject_id.in_(ids)).all()
        if len(topics) != len(set(topic_ids)):
            raise HTTPException(422, "Темы должны принадлежать выбранным предметам")
    return subjects


def safe_upload_path(value: str) -> Path:
    try:
        return resolve_upload_path(value, settings.UPLOAD_DIR)
    except ValueError:
        raise HTTPException(400, "Некорректный путь файла")


async def save_upload(file: UploadFile, allowed: set[str], max_bytes: int | None = None):
    name = (file.filename or "file").replace("\\", "/").rsplit("/", 1)[-1]
    name = "".join(c for c in name if c.isprintable())[:180]
    ext = Path(name).suffix.lower().lstrip(".")
    if ext not in allowed:
        raise HTTPException(400, "Неподдерживаемый формат")
    root = Path(settings.UPLOAD_DIR).resolve()
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{uuid4().hex}.{ext}"
    size = 0
    try:
        with path.open("xb") as output:
            while chunk := await file.read(64 * 1024):
                size += len(chunk)
                if size > (max_bytes or settings.MAX_UPLOAD_BYTES):
                    raise HTTPException(413, "Файл превышает допустимый размер")
                output.write(chunk)
        if not size:
            raise HTTPException(400, "Файл пустой")
        with path.open("rb") as source:
            header = source.read(8)
        if ext == "pdf" and not header.startswith(b"%PDF-"):
            raise HTTPException(400, "Файл не является PDF-документом")
        if ext in {"docx", "xlsx", "pptx"}:
            try:
                with zipfile.ZipFile(path) as archive:
                    entries = archive.infolist()
                    if len(entries) > 10000 or sum(i.file_size for i in entries) > 100 * 1024 * 1024:
                        raise HTTPException(413, "Документ слишком велик после распаковки")
                    if "[Content_Types].xml" not in archive.namelist():
                        raise HTTPException(400, "Некорректный формат Office")
            except zipfile.BadZipFile:
                raise HTTPException(400, "Документ повреждён")
        return name, relative_upload_path(path, root), size
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    finally:
        await file.close()


class BodySizeLimitMiddleware:
    """Enforce bounds even when a caller omits Content-Length / uses chunked transfer."""
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        received = 0
        content_type = dict(scope.get('headers', [])).get(b'content-type', b'')
        limit = settings.MAX_UPLOAD_BYTES + 1024 * 1024 if b'multipart/form-data' in content_type else 1024 * 1024
        if scope.get('method') == 'PUT' and scope.get('path', '').startswith('/api/branding/'):
            from app.services.branding import MAX_LOGO_BYTES
            # One logo plus bounded multipart overhead, including streamed requests.
            limit = min(limit, MAX_LOGO_BYTES + 64 * 1024)

        async def limited_receive():
            nonlocal received
            message = await receive()
            if message['type'] == 'http.request':
                received += len(message.get('body', b''))
                if received > limit:
                    raise HTTPException(413, 'Запрос превышает допустимый размер')
            return message
        await self.app(scope, limited_receive, send)
