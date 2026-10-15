from contextlib import asynccontextmanager
import asyncio
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import inspect, text
from app.database import Base, engine, SessionLocal
from app.config import settings
from app.security import rate_limit, client_key, BodySizeLimitMiddleware
from app.job_models import AIJob
from app import operational_models, lumaball_models, lumaball_room_models
from app.services import background, backups
from app.services.audit import initialize_operations
from app.routers import (auth_routes, admin, academic, subjects, notes, files, tasks, chat,
                         exam, cards, search, tests, notifications, lectures, learning, developers, branding, system,
                         lumaball_identity, lumaball_rooms)
from app.services import lumaball_realtime


def initialize_database():
    """Idempotent, additive upgrade of existing SQLite installations."""
    Base.metadata.create_all(bind=engine)
    with engine.begin() as conn:
        columns = {
            "users": {"name": "VARCHAR(120) NOT NULL DEFAULT ''", "role": "VARCHAR(20) NOT NULL DEFAULT 'student'",
                      "is_active": "BOOLEAN NOT NULL DEFAULT TRUE", "token_version": "INTEGER NOT NULL DEFAULT 0",
                      "group_id": "INTEGER REFERENCES student_groups(id)"},
            "exam_sessions": {"subject_ids_json": "TEXT DEFAULT ''", "topic_ids_json": "TEXT DEFAULT ''", "source_context_json": "TEXT DEFAULT '{}'"},
            "test_sessions": {"source_context_json": "TEXT DEFAULT '{}'"},
            "tasks": {"source_context_json": "TEXT DEFAULT '{}'"},
            "flashcards": {"source_context_json": "TEXT DEFAULT '{}'"},
            "lectures": {"source_context_json": "TEXT DEFAULT '{}'"},
            "chat_messages": {"source_context_json": "TEXT DEFAULT '{}'"},
            "lumaball_rooms": {"match_started_at": "DATETIME"},
            "syllabus_documents": {"source_restricted": "BOOLEAN NOT NULL DEFAULT FALSE", "source_sha256": "VARCHAR(64) DEFAULT ''"},
            "student_groups": {"program": "VARCHAR(300) DEFAULT ''", "study_year": "INTEGER", "semester": "INTEGER", "warnings_json": "TEXT DEFAULT '[]'"},
            "schedule_entries": {"start_times_json": "TEXT DEFAULT '[]'", "teacher": "VARCHAR(200) DEFAULT ''", "notes": "TEXT DEFAULT ''",
                                 "source_container": "VARCHAR(255) DEFAULT ''", "source_container_sha256": "VARCHAR(64) DEFAULT ''",
                                 "source_file": "VARCHAR(255) DEFAULT ''", "source_sheet": "VARCHAR(200) DEFAULT ''", "source_cell": "VARCHAR(100) DEFAULT ''",
                                 "source_row_id": "VARCHAR(200) DEFAULT ''", "source_sha256": "VARCHAR(64) DEFAULT ''", "source_updated_at": "VARCHAR(100) DEFAULT ''",
                                 "source_raw": "TEXT DEFAULT ''", "warnings_json": "TEXT DEFAULT '[]'"},
        }
        for table, definitions in columns.items():
            existing = {c["name"] for c in inspect(conn).get_columns(table)}
            for name, definition in definitions.items():
                if name not in existing:
                    conn.execute(text(f'ALTER TABLE "{table}" ADD COLUMN "{name}" {definition}'))
        if engine.dialect.name == "sqlite":
            duplicate = conn.execute(text("SELECT 1 FROM syllabus_documents WHERE source_sha256 <> '' GROUP BY course_id, source_sha256 HAVING COUNT(*) > 1 LIMIT 1")).first()
            if duplicate is None:
                conn.execute(text("CREATE UNIQUE INDEX IF NOT EXISTS uq_syllabus_course_source ON syllabus_documents(course_id, source_sha256) WHERE source_sha256 <> ''"))
            uniques = inspect(conn).get_unique_constraints("lectures")
            if any(u["column_names"] == ["topic_id"] for u in uniques):
                conn.execute(text("CREATE TABLE lectures_upgrade (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), topic_id INTEGER REFERENCES topics(id), content TEXT, status VARCHAR, materials_hash VARCHAR, source_context_json TEXT DEFAULT '{}', created_at DATETIME, updated_at DATETIME, CONSTRAINT uq_lecture_user_topic UNIQUE(user_id, topic_id))"))
                conn.execute(text('INSERT INTO lectures_upgrade SELECT id,user_id,topic_id,content,status,materials_hash,source_context_json,created_at,updated_at FROM lectures'))
                conn.execute(text('DROP TABLE lectures'))
                conn.execute(text('ALTER TABLE lectures_upgrade RENAME TO lectures'))
                conn.execute(text('CREATE INDEX ix_lectures_id ON lectures(id)'))
    from app.services.syllabus import seed_academic_defaults
    from app.services.reference_curriculum import seed_sourced_curriculum
    from app.services.reference_timetable import seed_sourced_timetable
    from app.services.developers import seed_developer_departments
    with SessionLocal() as db:
        from app.models import Lecture
        # Preserve work managed by the durable queue. Only legacy orphan jobs
        # lack the payload needed to resume and must be marked for retry.
        active_lecture_ids = {int(key[8:]) for (key,) in db.query(AIJob.resource_key).filter(
            AIJob.kind == "lecture", AIJob.status.in_(background.ACTIVE),
            AIJob.resource_key.like("lecture:%")).all() if key[8:].isdigit()}
        db.query(Lecture).filter(Lecture.status == "generating", ~Lecture.id.in_(active_lecture_ids)).update({"status": "error"})
        db.commit()
        seed_academic_defaults(db)
        seed_sourced_curriculum(db)
        seed_sourced_timetable(db)
        seed_developer_departments(db)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # A killed explicit import may leave a partial transaction. Never initialize
    # a replacement empty database, replay a ZIP or roll back at normal startup.
    from app.services.transfers import assert_no_incomplete_imports
    assert_no_incomplete_imports()
    await asyncio.to_thread(backups.create_pre_upgrade_backup)
    initialize_database()
    initialize_operations(engine)
    from app.services.lumaball_rooms import initialize_rooms
    from app.services.lumaball_identity import upgrade_default_brand
    with SessionLocal() as db:
        upgrade_default_brand(db)
        initialize_rooms(db)
    await lumaball_realtime.hub.start()
    await background.start_workers()
    try:
        await backups.start_backup_scheduler()
        yield
    finally:
        try:
            await backups.stop_backup_scheduler()
        finally:
            try:
                await background.stop_workers()
            finally:
                await lumaball_realtime.hub.stop()


app = FastAPI(title="QStudy API", version="2.0.0", lifespan=lifespan)
app.add_middleware(BodySizeLimitMiddleware)
app.add_middleware(CORSMiddleware,
                   allow_origins=[value.strip() for value in settings.CORS_ORIGINS.split(",") if value.strip()],
                   allow_credentials=False, allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
                   allow_headers=["Authorization", "Content-Type"])


@app.middleware("http")
async def request_security(request: Request, call_next):
    from app.services.branding import IMMUTABLE_CACHE, MAX_LOGO_BYTES
    limit = settings.MAX_UPLOAD_BYTES + 1024 * 1024
    if request.method == "POST" and request.url.path == "/api/admin/system/imports":
        limit = settings.MAX_TRANSFER_BYTES
    if request.method == "PUT" and (request.url.path.startswith("/api/branding/") or request.url.path == "/api/admin/lumaball/logo"):
        limit = min(limit, MAX_LOGO_BYTES + 64 * 1024)
    length = request.headers.get("content-length")
    if length:
        try:
            if int(length) > limit or int(length) < 0:
                return JSONResponse({"detail": "Запрос превышает допустимый размер"}, status_code=413)
        except ValueError:
            return JSONResponse({"detail": "Некорректный размер запроса"}, status_code=400)
    from fastapi import HTTPException
    try:
        rate_limit("api:" + client_key(request), 300, 60)
        if request.method == "POST" and any(part in request.url.path for part in ("/generate", "/chat/send", "/process", "/transcribe", "/start", "/analyze", "/retry")):
            rate_limit("ai:" + client_key(request), 40, 60)
    except HTTPException as error:
        return JSONResponse({"detail": error.detail}, status_code=error.status_code, headers=error.headers)
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    if not (request.method == "GET" and request.url.path.startswith("/api/branding/assets/")
            and response.status_code in (200, 304) and response.headers.get("Cache-Control") == IMMUTABLE_CACHE):
        response.headers["Cache-Control"] = "no-store"
    return response


for router in (lectures, auth_routes, admin, academic, subjects, notes, files, tasks, chat,
               exam, cards, search, tests, notifications, learning, developers, branding, system, lumaball_identity, lumaball_rooms):
    app.include_router(router.router, prefix="/api")
app.include_router(lumaball_realtime.router, prefix="/api")


@app.get("/api/health")
def health():
    return {"status": "ok", "service": "QStudy"}
