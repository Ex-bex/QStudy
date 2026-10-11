from fastapi import APIRouter, Depends, HTTPException, Request, BackgroundTasks
from fastapi.security import OAuth2PasswordRequestForm
from sqlalchemy.orm import Session
from sqlalchemy import func, update, text
from sqlalchemy.exc import IntegrityError
from pydantic import BaseModel, EmailStr, Field, ConfigDict, field_validator
from app.database import get_db
from app.models import User, StudentGroup
from app.auth import (hash_password, verify_password, create_access_token, get_current_user,
                      user_public, validate_password, pwd_context)
from app.config import settings
from app.security import rate_limit, client_key
from app.services import password_recovery
import hashlib
import time

router = APIRouter(prefix="/auth", tags=["auth"])
# Equal-cost password verification for unknown accounts.
_DUMMY_HASH = hash_password("dummy-timing-password-391")


class RegisterData(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    name: str = Field(default="", max_length=120)
    _password = field_validator("password")(validate_password)


class ProfileUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=120)


class PasswordChange(BaseModel):
    model_config = ConfigDict(extra="forbid")
    current_password: str = Field(max_length=128)
    new_password: str = Field(min_length=10, max_length=128)
    _password = field_validator("new_password")(validate_password)


class RecoveryRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr


class RecoveryReset(BaseModel):
    model_config = ConfigDict(extra="forbid")
    token: str = Field(min_length=40, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    new_password: str = Field(min_length=10, max_length=128)
    _password = field_validator("new_password")(validate_password)


@router.get("/recovery-options")
def recovery_options():
    mode = password_recovery.recovery_mode()
    return {"delivery": mode, "expires_minutes": settings.PASSWORD_RESET_MINUTES}


@router.post("/forgot-password")
def forgot_password(data: RecoveryRequest, request: Request, tasks: BackgroundTasks, db: Session = Depends(get_db)):
    started = time.monotonic()
    email = str(data.email).strip().lower()
    rate_limit("recovery-ip:" + client_key(request), 10)
    rate_limit("recovery-account:" + hashlib.sha256(email.encode()).hexdigest(), 3)
    mode = password_recovery.recovery_mode()
    if mode == "disabled":
        raise HTTPException(503, "Восстановление по почте пока не настроено. Обратитесь к администратору.")
    issued = password_recovery.issue_reset(db, email)
    if issued:
        record_id, recipient, token = issued
        tasks.add_task(password_recovery.deliver_reset, db.get_bind(), record_id, recipient, token, mode)
    time.sleep(max(0, 0.25 - (time.monotonic() - started)))
    return {"ok": True, "message": password_recovery.GENERIC_MESSAGE, "delivery": mode}


@router.post("/reset-password")
def reset_password(data: RecoveryReset, request: Request, db: Session = Depends(get_db)):
    rate_limit("reset-ip:" + client_key(request), 20)
    password_recovery.complete_reset(db, data.token, data.new_password)
    return {"ok": True, "message": "Пароль изменён. Войдите с новым паролем; предыдущие сессии закрыты."}


def session_response(user):
    return {"access_token": create_access_token(user.id, user.token_version),
            "token_type": "bearer", "user": user_public(user)}


@router.post("/register", status_code=201)
def register(data: RegisterData, request: Request, db: Session = Depends(get_db)):
    if not settings.REGISTRATION_ENABLED:
        raise HTTPException(403, "Регистрация закрыта. Обратитесь к администратору")
    rate_limit("register:" + client_key(request), 8)
    email = str(data.email).strip().lower()
    if db.query(User).filter(func.lower(User.email) == email).first():
        raise HTTPException(409, "Этот email уже используется")
    default_group = db.query(StudentGroup).filter(StudentGroup.name == "ИП-26-3кс").first()
    user = User(email=email, name=data.name.strip(), hashed_password=hash_password(data.password),
                role="student", group_id=default_group.id if default_group else None)
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(409, "Этот email уже используется")
    db.refresh(user)
    result = session_response(user)
    return {**user_public(user), **result, "token": result["access_token"]}


@router.post("/login")
def login(request: Request, form: OAuth2PasswordRequestForm = Depends(), db: Session = Depends(get_db)):
    email = form.username.strip().lower()
    rate_limit("login-ip:" + client_key(request), 40)
    rate_limit("login-account:" + email[:320], 12)
    user = db.query(User).filter(func.lower(User.email) == email).first()
    valid = verify_password(form.password, user.hashed_password if user else _DUMMY_HASH)
    if not user or not valid or not user.is_active:
        raise HTTPException(401, "Неверный email или пароль", headers={"WWW-Authenticate": "Bearer"})
    if pwd_context.needs_update(user.hashed_password):
        user.hashed_password = hash_password(form.password)
        db.commit()
    return session_response(user)


@router.get("/me")
def me(user=Depends(get_current_user)):
    return user_public(user)


@router.patch("/me")
def update_me(data: ProfileUpdate, db: Session = Depends(get_db), user=Depends(get_current_user)):
    if not data.name.strip():
        raise HTTPException(422, "Укажите имя")
    user.name = data.name.strip()
    db.commit()
    return user_public(user)


@router.post("/password")
def change_password(data: PasswordChange, db: Session = Depends(get_db), user=Depends(get_current_user)):
    rate_limit(f"password:{user.id}", 8)
    if db.get_bind().dialect.name == "sqlite":
        db.execute(text("BEGIN IMMEDIATE"))
    else:
        db.query(User).filter(User.id == user.id).with_for_update().first()
    db.refresh(user)
    if not verify_password(data.current_password, user.hashed_password):
        raise HTTPException(400, "Текущий пароль неверный")
    db.execute(update(User).where(User.id == user.id).values(
        hashed_password=hash_password(data.new_password), token_version=User.token_version + 1),
        execution_options={"synchronize_session": False})
    db.commit()
    db.refresh(user)
    return session_response(user)


@router.post("/logout")
def logout(db: Session = Depends(get_db), user=Depends(get_current_user)):
    db.execute(update(User).where(User.id == user.id).values(token_version=User.token_version + 1),
               execution_options={"synchronize_session": False})
    db.commit()
    return {"ok": True}
