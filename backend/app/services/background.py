"""SQLite-backed AI jobs with leases, restart recovery and atomic output commits.

Handlers receive only JSON payloads, never request sessions or coroutine closures.
AI responses can be checkpointed before applying results. A lease fence commits
the resource changes and job completion in one transaction, preventing duplicate
results when another worker recovered an interrupted job.
"""
import asyncio
import hashlib
import json
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException
from sqlalchemy import func, insert, literal, select, update
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.database import SessionLocal
from app.job_models import AIJob
from app.models import User

logger = logging.getLogger(__name__)
ACTIVE = ("queued", "running")
TERMINAL = ("done", "error")
HANDLERS = {}
FAILURE_HANDLERS = {}
WORKERS = set()
_wake = None
_instance = uuid.uuid4().hex


class JobPermanentError(Exception):
    """Safe public failure that cannot be corrected by an automatic retry."""


class JobCancelled(JobPermanentError):
    pass


class LeaseLost(Exception):
    """Another worker or cancellation owns this job; never apply its output."""


def _setting(name, default, minimum, maximum):
    try:
        return max(minimum, min(int(getattr(settings, name, default)), maximum))
    except (ValueError, TypeError):
        return default


def _json(value, limit=1024 * 1024):
    if not isinstance(value, dict):
        raise ValueError("Job data must be a JSON object")
    encoded = json.dumps(value, ensure_ascii=False, allow_nan=False)
    if len(encoded.encode("utf-8")) > limit:
        raise HTTPException(413, "Материал задачи ИИ превышает допустимый объём")
    return encoded


def _decode(value):
    try:
        result = json.loads(value or "{}")
        return result if isinstance(result, dict) else {}
    except (ValueError, TypeError):
        return {}


def _timestamp(value):
    return value.replace(tzinfo=timezone.utc).isoformat() if value else None


def job_public(job):
    # Payloads contain private document text; never expose them or lease details.
    return {"id": job.id, "kind": job.kind, "title": job.title,
            "status": job.status, "error": job.error,
            "result": _decode(job.result_json), "attempts": job.attempts,
            "created_at": _timestamp(job.created_at),
            "finished_at": _timestamp(job.finished_at)}


def register_handler(kind, *, on_error=None):
    def decorate(handler):
        HANDLERS[kind] = handler
        if on_error is not None:
            FAILURE_HANDLERS[kind] = on_error
        return handler
    return decorate


def enqueue_job(db, user_id, kind, title, payload, resource_key=None):
    if kind not in HANDLERS:
        raise HTTPException(400, "Этот тип задачи ИИ не поддерживается")
    owner = db.get(User, user_id)
    if not owner or not owner.is_active:
        raise HTTPException(403, "Аккаунт недоступен")
    encoded = _json(payload, 512 * 1024)
    job_id = uuid.uuid4().hex
    now = datetime.utcnow()
    active_key = hashlib.sha256(f"{user_id}:{kind}:{resource_key}".encode()).hexdigest() if resource_key else None
    if active_key and db.query(AIJob.id).filter(AIJob.active_key == active_key).first():
        raise HTTPException(409, "Эта задача ИИ уже выполняется")
    values = {"id": job_id, "user_id": user_id, "kind": kind, "title": title[:300],
              "status": "queued", "resource_key": resource_key, "active_key": active_key,
              "payload_json": encoded, "checkpoint_json": "{}", "result_json": "{}",
              "error": "", "attempts": 0,
              "max_attempts": _setting("JOB_MAX_ATTEMPTS", 3, 1, 5),
              "available_at": now, "lease_owner": None, "lease_expires_at": None,
              "created_at": now, "updated_at": now, "finished_at": None, "acknowledged_at": None}
    # INSERT ... SELECT checks the cap under the same SQLite write lock as the
    # insert, including requests from other processes. A preflight COUNT alone
    # would allow concurrent requests to exceed the per-user limit.
    active_count = select(func.count(AIJob.id)).where(AIJob.user_id == user_id, AIJob.status.in_(ACTIVE)).scalar_subquery()
    statement = insert(AIJob).from_select(list(values), select(*(literal(value) for value in values.values())).where(active_count < 3), include_defaults=False)
    try:
        result = db.execute(statement)
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Эта задача ИИ уже выполняется") from None
    if result.rowcount != 1:
        raise HTTPException(429, "Дождитесь завершения текущих задач ИИ")
    return db.get(AIJob, job_id)


def wake_worker():
    if _wake is not None:
        _wake.set()


@dataclass(frozen=True)
class JobContext:
    job_id: str
    user_id: int
    kind: str
    lease_owner: str

    def session(self):
        return SessionLocal()

    def require_current(self, db):
        job = db.get(AIJob, self.job_id, populate_existing=True)
        if not job or job.user_id != self.user_id or job.status != "running" or job.lease_owner != self.lease_owner or not job.lease_expires_at or job.lease_expires_at <= datetime.utcnow():
            raise LeaseLost()
        owner = db.get(User, self.user_id, populate_existing=True)
        if not owner or not owner.is_active:
            raise JobCancelled("Аккаунт недоступен; задача остановлена")
        return job

    def get_checkpoint(self):
        with self.session() as db:
            return _decode(self.require_current(db).checkpoint_json)

    def save_checkpoint(self, data):
        encoded = _json(data)
        with self.session() as db:
            self.require_current(db)
            changed = db.execute(update(AIJob).where(
                AIJob.id == self.job_id, AIJob.status == "running", AIJob.lease_owner == self.lease_owner,
                AIJob.lease_expires_at > datetime.utcnow()).values(checkpoint_json=encoded, updated_at=datetime.utcnow()))
            if changed.rowcount != 1:
                db.rollback()
                raise LeaseLost()
            db.commit()

    def complete(self, db, result):
        encoded = _json(result)
        self.require_current(db)
        now = datetime.utcnow()
        # Acquire the write lock and fence the lease before flushing resource
        # changes. Both changes then commit together or both roll back.
        changed = db.execute(update(AIJob).where(
            AIJob.id == self.job_id, AIJob.status == "running", AIJob.lease_owner == self.lease_owner,
            AIJob.lease_expires_at > now,
            select(User.id).where(User.id == self.user_id, User.is_active.is_(True)).exists()).values(status="done", result_json=encoded,
                error="", finished_at=now, updated_at=now, active_key=None,
                lease_owner=None, lease_expires_at=None))
        if changed.rowcount != 1:
            db.rollback()
            raise LeaseLost()
        db.flush()
        db.commit()


def _safe_error(error):
    from app.services.ai import AIError
    if isinstance(error, (AIError, JobPermanentError)):
        return str(error)[:300] or "Не удалось завершить задачу"
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return "ИИ не завершил задачу вовремя. Повторите попытку"
    return "Не удалось завершить задачу. Повторите попытку"


def _failure_hook(db, job):
    callback = FAILURE_HANDLERS.get(job.kind)
    if callback:
        callback(db, job.user_id, _decode(job.payload_json))


def recover_expired_jobs():
    now = datetime.utcnow()
    with SessionLocal() as db:
        expired = db.query(AIJob).filter(AIJob.status == "running", AIJob.lease_expires_at <= now).all()
        for job in expired:
            exhausted = job.attempts >= job.max_attempts
            changed = db.execute(update(AIJob).where(AIJob.id == job.id, AIJob.status == "running",
                AIJob.lease_expires_at <= now).values(status="error" if exhausted else "queued",
                    error="Задача была прервана несколько раз. Повторите попытку" if exhausted else "",
                    active_key=None if exhausted else job.active_key, lease_owner=None, lease_expires_at=None,
                    available_at=now, updated_at=now, finished_at=now if exhausted else None))
            if changed.rowcount == 1 and exhausted:
                _failure_hook(db, job)
        db.commit()


def _claim_next():
    recover_expired_jobs()
    now = datetime.utcnow()
    with SessionLocal() as db:
        job = db.query(AIJob).filter(AIJob.status == "queued", AIJob.available_at <= now).order_by(AIJob.created_at, AIJob.id).first()
        if job is None:
            return None
        owner = db.get(User, job.user_id)
        if not owner or not owner.is_active or job.kind not in HANDLERS or job.attempts >= job.max_attempts:
            job.status = "error"
            job.error = "Аккаунт или тип задачи недоступен; задача остановлена"
            job.finished_at = now; job.updated_at = now; job.active_key = None
            _failure_hook(db, job)
            db.commit()
            return None
        token = _instance + ":" + uuid.uuid4().hex
        changed = db.execute(update(AIJob).where(AIJob.id == job.id, AIJob.status == "queued").values(
            status="running", lease_owner=token,
            lease_expires_at=now + timedelta(seconds=_setting("JOB_LEASE_SECONDS", 90, 15, 300)),
            attempts=AIJob.attempts + 1, updated_at=now))
        if changed.rowcount != 1:
            db.rollback()
            return None
        context = JobContext(job.id, job.user_id, job.kind, token)
        payload = _decode(job.payload_json)
        db.commit()
        return context, payload


async def _heartbeat(context):
    lease = _setting("JOB_LEASE_SECONDS", 90, 15, 300)
    while True:
        await asyncio.sleep(max(3, lease / 3))
        with context.session() as db:
            changed = db.execute(update(AIJob).where(AIJob.id == context.job_id,
                AIJob.status == "running", AIJob.lease_owner == context.lease_owner).values(
                    lease_expires_at=datetime.utcnow() + timedelta(seconds=lease), updated_at=datetime.utcnow()))
            db.commit()
            if changed.rowcount != 1:
                return


def _finish_error(context, error, permanent=False):
    now = datetime.utcnow()
    with context.session() as db:
        job = db.get(AIJob, context.job_id)
        if not job or job.status != "running" or job.lease_owner != context.lease_owner:
            return
        terminal = permanent or job.attempts >= job.max_attempts
        changed = db.execute(update(AIJob).where(AIJob.id == job.id, AIJob.status == "running", AIJob.lease_owner == context.lease_owner).values(
            status="error" if terminal else "queued", error=_safe_error(error) if terminal else "",
            lease_owner=None, lease_expires_at=None, active_key=None if terminal else job.active_key,
            available_at=now + timedelta(seconds=min(60, 2 ** job.attempts * 2)),
            finished_at=now if terminal else None, updated_at=now))
        if changed.rowcount == 1 and terminal:
            _failure_hook(db, job)
        db.commit()


def _release_interrupted(context):
    with context.session() as db:
        db.execute(update(AIJob).where(AIJob.id == context.job_id, AIJob.status == "running",
            AIJob.lease_owner == context.lease_owner).values(status="queued", lease_owner=None,
                lease_expires_at=None, available_at=datetime.utcnow(), updated_at=datetime.utcnow()))
        db.commit()


async def process_one_job():
    """Process one durable job. Exposed for deterministic offline restart tests."""
    claim = _claim_next()
    if claim is None:
        return False
    context, payload = claim
    heartbeat = asyncio.create_task(_heartbeat(context))
    try:
        result = await asyncio.wait_for(HANDLERS[context.kind](context, payload),
            timeout=_setting("JOB_TIMEOUT_SECONDS", 600, 10, 1800))
        with context.session() as db:
            job = db.get(AIJob, context.job_id)
            if job and job.status == "running" and job.lease_owner == context.lease_owner:
                context.complete(db, result or {})
    except asyncio.CancelledError:
        _release_interrupted(context)
        raise
    except LeaseLost:
        pass
    except Exception as error:
        permanent = isinstance(error, JobPermanentError) or isinstance(error, HTTPException) and error.status_code in (400, 403, 404, 409, 413)
        _finish_error(context, error, permanent=permanent)
    finally:
        heartbeat.cancel()
        await asyncio.gather(heartbeat, return_exceptions=True)
    return True


async def _worker():
    while True:
        try:
            if await process_one_job():
                continue
        except asyncio.CancelledError:
            raise
        except Exception:
            # Do not log exceptions containing provider responses or private text.
            logger.error("AI queue storage operation failed; the worker will retry")
        try:
            await asyncio.wait_for(_wake.wait(), timeout=2)
        except asyncio.TimeoutError:
            pass
        _wake.clear()


async def start_workers():
    global _wake
    if WORKERS:
        return
    _wake = asyncio.Event()
    recover_expired_jobs()
    for _ in range(_setting("JOB_WORKERS", 2, 1, 4)):
        task = asyncio.create_task(_worker())
        WORKERS.add(task)
        task.add_done_callback(WORKERS.discard)


async def stop_workers():
    tasks = list(WORKERS)
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)
    WORKERS.clear()


def claim_notifications(user_id, db=None):
    """Compatibility name: reads now persist until explicit acknowledgement."""
    if db is None:
        with SessionLocal() as own_db:
            return claim_notifications(user_id, own_db)
    rows = db.query(AIJob).filter(AIJob.user_id == user_id, AIJob.status.in_(TERMINAL),
        AIJob.acknowledged_at.is_(None)).order_by(AIJob.finished_at.desc()).limit(100).all()
    return [job_public(job) for job in rows]


def retry_job(db, job):
    if job.status != "error":
        raise HTTPException(409, "Повторить можно только завершившуюся с ошибкой задачу")
    payload = _decode(job.payload_json)
    replacement = enqueue_job(db, job.user_id, job.kind, job.title, payload, job.resource_key)
    replacement.checkpoint_json = job.checkpoint_json
    return replacement


async def await_job_result(job_id, user_id, timeout_seconds=150):
    """Keep legacy immediate-result APIs while the actual work is durable.

    Cancelling or disconnecting this request does not cancel the stored job.
    The notification and its stored resource remain available after restart.
    """
    wake_worker()
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while asyncio.get_running_loop().time() < deadline:
        with SessionLocal() as db:
            job = db.query(AIJob).filter(AIJob.id == job_id, AIJob.user_id == user_id).first()
            if not job:
                raise HTTPException(404, "Задача ИИ больше недоступна")
            if job.status == "done":
                return _decode(job.result_json)
            if job.status == "error":
                raise HTTPException(502, job.error or "Не удалось завершить задачу ИИ")
        await asyncio.sleep(0.3)
    raise HTTPException(503, "Задача сохранена в очереди и продолжает выполняться. Результат появится на странице и в уведомлениях")
