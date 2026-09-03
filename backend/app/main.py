from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import Base, engine
from app.routers import auth_routes, subjects, notes, files, tasks, chat, exam, cards, search, tests, notifications, lectures
from sqlalchemy import text as _sqltext


def _migrate():
    """Добавляем новые колонки в существующие таблицы (SQLite ALTER)."""
    with engine.connect() as conn:
        for table, col in [
            ("exam_sessions", "subject_ids_json"),
            ("exam_sessions", "topic_ids_json"),
        ]:
            cols = [r[1] for r in conn.execute(_sqltext(f"PRAGMA table_info({table})"))]
            if cols and col not in cols:
                conn.execute(_sqltext(f"ALTER TABLE {table} ADD COLUMN {col} TEXT DEFAULT ''"))
        conn.commit()


_migrate()

Base.metadata.create_all(bind=engine)

app = FastAPI(title="StudyHub API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(lectures.router, prefix="/api")
app.include_router(auth_routes.router, prefix="/api")
app.include_router(subjects.router, prefix="/api")
app.include_router(notes.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(tasks.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(exam.router, prefix="/api")
app.include_router(cards.router, prefix="/api")
app.include_router(search.router, prefix="/api")
app.include_router(tests.router, prefix="/api")
app.include_router(notifications.router, prefix="/api")
@app.get("/api/health")
def health():
    return {"status": "ok"}