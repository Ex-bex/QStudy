from sqlalchemy import create_engine, event
from sqlalchemy.orm import sessionmaker, declarative_base
from app.config import settings

engine = create_engine(
    settings.DATABASE_URL,
    connect_args={"check_same_thread": False, "timeout": 30} if settings.DATABASE_URL.startswith("sqlite") else {},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine, expire_on_commit=False)
Base = declarative_base()


if engine.dialect.name == "sqlite":
    @event.listens_for(engine, "connect")
    def _sqlite_foreign_keys(connection, record):
        connection.execute("PRAGMA foreign_keys=ON")


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
