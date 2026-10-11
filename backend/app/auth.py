from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
import jwt
from jwt.exceptions import InvalidTokenError
from passlib.context import CryptContext
from sqlalchemy.orm import Session
from app.config import settings
from app.database import get_db
from app.models import User, AcademicSetting
import math

# Existing bcrypt hashes remain valid. New hashes avoid bcrypt's 72-byte truncation.
pwd_context = CryptContext(schemes=["pbkdf2_sha256", "bcrypt"], deprecated="auto", pbkdf2_sha256__rounds=600_000)
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/api/auth/login")


def validate_password(password: str) -> str:
    if not 10 <= len(password) <= 128 or not any(c.isalpha() for c in password) or not any(c.isdigit() for c in password):
        raise ValueError("Пароль: от 10 до 128 символов, минимум одна буква и одна цифра")
    return password


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(plain: str, hashed: str) -> bool:
    if len(plain) > 128:
        return False
    try:
        return pwd_context.verify(plain, hashed)
    except (ValueError, TypeError):
        return False


def create_access_token(user_id: int, token_version: int = 0) -> str:
    now = datetime.now(timezone.utc)
    return jwt.encode({"sub": str(user_id), "ver": token_version, "iat": now.timestamp(),
                       "exp": now + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES),
                       "iss": "qstudy", "aud": "qstudy-web"}, settings.SECRET_KEY, algorithm="HS256")


def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    error = HTTPException(status_code=status.HTTP_401_UNAUTHORIZED,
                          detail="Сессия истекла. Войдите снова", headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, settings.SECRET_KEY, algorithms=["HS256"],
                             issuer="qstudy", audience="qstudy-web",
                             options={"require": ["exp", "sub", "iat"]})
        user_id = int(payload["sub"])
        version = payload.get("ver")
        if user_id <= 0 or type(version) is not int:
            raise error
    except (InvalidTokenError, ValueError, TypeError, KeyError, OverflowError):
        raise error
    user = db.get(User, user_id)
    if user is None or not user.is_active or user.token_version != version:
        raise error
    issued_at = payload.get("iat")
    cutoff = db.get(AcademicSetting, "auth_min_iat")
    if type(issued_at) not in (int, float) or not math.isfinite(issued_at):
        raise error
    if cutoff:
        try:
            if issued_at <= float(cutoff.value):
                raise error
        except (ValueError, TypeError):
            raise error
    return user


def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "Доступно только администратору")
    return user


def user_public(user: User) -> dict:
    return {"id": user.id, "email": user.email, "name": user.name, "role": user.role,
            "is_active": user.is_active, "group_id": user.group_id, "created_at": user.created_at}
