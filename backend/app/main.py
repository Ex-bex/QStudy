from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.database import Base, engine
from app.routers import auth_routes, subjects, notes, files, tasks, chat, exam, cards, search

Base.metadata.create_all(bind=engine)

app = FastAPI(title="StudyHub API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_routes.router, prefix="/api")
app.include_router(subjects.router, prefix="/api")
app.include_router(notes.router, prefix="/api")
app.include_router(files.router, prefix="/api")
app.include_router(tasks.router, prefix="/api")
app.include_router(chat.router, prefix="/api")
app.include_router(exam.router, prefix="/api")
app.include_router(cards.router, prefix="/api")
app.include_router(search.router, prefix="/api")

@app.get("/api/health")
def health():
    return {"status": "ok"}