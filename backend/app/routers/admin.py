from typing import Literal
from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator
from sqlalchemy import func, update, delete, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from app.database import get_db, Base
from app.models import User, Subject, StudentGroup, Material, Note, Task, Flashcard, Lecture, ChatSession, ExamSession, TestSession
from app.auth import require_admin, hash_password, validate_password, user_public
from app.security import safe_upload_path
from app.operational_models import AuditLog
from app.services.audit import record_audit, audit_public
from app.services.backups import get_backup_service, BackupError

router = APIRouter(prefix="/admin", tags=["administration"], dependencies=[Depends(require_admin)])


class UserCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    name: str = Field(default="", max_length=120)
    role: Literal["admin", "student"] = "student"
    is_active: bool = True
    group_id: int | None = Field(default=None, gt=0)
    _password = field_validator("password")(validate_password)


class UserUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr | None = None
    name: str | None = Field(default=None, max_length=120)
    role: Literal["admin", "student"] | None = None
    is_active: bool | None = None
    group_id: int | None = Field(default=None, gt=0)


class PasswordReset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    password: str = Field(min_length=10, max_length=128)
    _password = field_validator("password")(validate_password)


def _user(db, user_id):
    user = db.get(User, user_id)
    if not user:
        raise HTTPException(404, "Аккаунт не найден")
    return user


def _group(db, group_id):
    if group_id is not None and not db.get(StudentGroup, group_id):
        raise HTTPException(404, "Группа не найдена")


def _protect_admin(db, user):
    if user.role == "admin" and user.is_active and db.query(User).filter(
            User.role == "admin", User.is_active == True).count() <= 1:
        raise HTTPException(409, "Нельзя удалить, отключить или понизить последнего администратора")


def _lock_accounts(db, admin):
    # Serialize changes affecting the last active administrator, including across workers.
    if db.get_bind().dialect.name == "sqlite":
        db.execute(text("BEGIN IMMEDIATE"))
    else:
        db.query(User).filter(User.role == "admin").with_for_update().all()
    db.refresh(admin)
    if not admin.is_active or admin.role != "admin":
        raise HTTPException(403, "Права администратора отозваны")


def _save(db):
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Этот email уже используется или запись связана с другими данными")


@router.get("/stats")
def stats(db: Session = Depends(get_db)):
    from app.models import Course, WorkSubmission
    return {"users": db.query(User).count(), "students": db.query(User).filter(User.role == "student").count(),
            "admins": db.query(User).filter(User.role == "admin").count(),
            "active_users": db.query(User).filter(User.is_active == True).count(),
            "groups": db.query(StudentGroup).count(), "courses": db.query(Course).count(),
            "submissions": db.query(WorkSubmission).count()}


@router.get("/users")
def users(q: str = Query(default="", max_length=120), db: Session = Depends(get_db)):
    query = db.query(User)
    if q.strip():
        term = "%" + q.strip().replace("%", "\\%").replace("_", "\\_") + "%"
        query = query.filter(User.email.ilike(term, escape="\\") | User.name.ilike(term, escape="\\"))
    return [user_public(u) for u in query.order_by(User.created_at.desc()).all()]


@router.post("/users", status_code=201)
def create_user(data: UserCreate, db: Session = Depends(get_db), admin=Depends(require_admin)):
    _group(db, data.group_id)
    email = str(data.email).strip().lower()
    if db.query(User).filter(func.lower(User.email) == email).first():
        raise HTTPException(409, "Этот email уже используется")
    user = User(**data.model_dump(exclude={"password", "email", "name"}), email=email,
                name=data.name.strip(), hashed_password=hash_password(data.password))
    db.add(user)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Этот email уже используется или запись связана с другими данными")
    record_audit(db, admin, "user.create", "user", user.id, fields=("email", "name", "role", "group_id", "is_active"), metadata={"role": user.role, "is_active": user.is_active})
    _save(db)
    db.refresh(user)
    return user_public(user)


@router.patch("/users/{user_id}")
def update_user(user_id: int, data: UserUpdate, db: Session = Depends(get_db), admin=Depends(require_admin)):
    _lock_accounts(db, admin)
    user = _user(db, user_id)
    values = data.model_dump(exclude_unset=True)
    if any(value is None and key != "group_id" for key, value in values.items()):
        raise HTTPException(422, "Поля аккаунта не могут быть пустыми")
    if "group_id" in values:
        _group(db, values["group_id"])
    if values.get("role", user.role) != "admin" or values.get("is_active", user.is_active) is False:
        _protect_admin(db, user)
    if user.id == admin.id and (values.get("is_active") is False or values.get("role", "admin") != "admin"):
        raise HTTPException(409, "Изменить собственные права или отключить себя нельзя")
    if "email" in values:
        values["email"] = str(values["email"]).strip().lower()
        existing = db.query(User).filter(func.lower(User.email) == values["email"], User.id != user.id).first()
        if existing:
            raise HTTPException(409, "Этот email уже используется")
    revoke = any(key in values and values[key] != getattr(user, key) for key in ("role", "is_active", "email"))
    for key, value in values.items():
        setattr(user, key, value.strip() if key == "name" else value)
    if revoke:
        user.token_version += 1
    record_audit(db, admin, "user.update", "user", user.id, fields=values.keys())
    _save(db)
    return user_public(user)


@router.post("/users/{user_id}/password")
def reset_password(user_id: int, data: PasswordReset, db: Session = Depends(get_db), admin=Depends(require_admin)):
    user = _user(db, user_id)
    db.execute(update(User).where(User.id == user.id).values(
        hashed_password=hash_password(data.password), token_version=User.token_version + 1),
        execution_options={"synchronize_session": False})
    record_audit(db, admin, "user.password_reset", "user", user.id)
    _save(db)
    return {"ok": True, "sessions_revoked": True}


@router.delete("/users/{user_id}")
def delete_user(user_id: int, db: Session = Depends(get_db), admin=Depends(require_admin)):
    _lock_accounts(db, admin)
    user = _user(db, user_id)
    if user.id == admin.id:
        raise HTTPException(409, "Нельзя удалить собственный аккаунт")
    _protect_admin(db, user)
    paths = [m.filepath for m in db.query(Material).filter(Material.user_id == user_id)]
    # ORM cascades remove messages and exam/test questions as well.
    for model in (ChatSession, ExamSession, TestSession, Material, Note, Task, Flashcard, Lecture):
        for row in db.query(model).filter(model.user_id == user_id):
            db.delete(row)
    db.query(Subject).filter(Subject.user_id == user_id).update({"user_id": None})
    # Academic authorship remains on shared records; personal submissions are removed.
    for table in Base.metadata.sorted_tables:
        if table.name in {"users", "subjects", "materials", "notes", "tasks", "flashcards", "lectures", "chat_sessions", "exam_sessions", "test_sessions"}:
            continue
        for column in table.columns:
            if any(fk.target_fullname == "users.id" for fk in column.foreign_keys):
                if table.name in {"work_submissions", "week_progress"}:
                    db.execute(delete(table).where(column == user_id))
                elif column.nullable:
                    db.execute(update(table).where(column == user_id).values({column.name: None}))
    db.delete(user)
    record_audit(db, admin, "user.delete", "user", user_id)
    _save(db)
    for value in paths:
        try:
            safe_upload_path(value).unlink(missing_ok=True)
        except (HTTPException, OSError):
            pass
    return {"ok": True}


@router.get("/audit")
def audit_log(limit: int = Query(default=30, ge=1, le=100), offset: int = Query(default=0, ge=0),
              action: str = Query(default="", max_length=100), db: Session = Depends(get_db)):
    query = db.query(AuditLog)
    if action:
        query = query.filter(AuditLog.action == action)
    total = query.count()
    rows = query.order_by(AuditLog.id.desc()).offset(offset).limit(limit).all()
    return {"items": [audit_public(row) for row in rows], "total": total, "offset": offset, "limit": limit}


@router.get("/backups")
def backups():
    try:
        service = get_backup_service()
        return {"status": service.status(), "items": service.archives()}
    except BackupError as error:
        raise HTTPException(503, str(error))


@router.post("/backups", status_code=202)
def create_manual_backup(admin=Depends(require_admin)):
    try:
        return get_backup_service().queue("manual", admin.id)
    except BackupError as error:
        raise HTTPException(409, str(error))


@router.get("/backups/{name}/download")
def download_backup(name: str):
    try:
        path = get_backup_service().archive_path(name)
        return FileResponse(path, media_type="application/zip", filename=path.name)
    except BackupError as error:
        raise HTTPException(404, str(error))
