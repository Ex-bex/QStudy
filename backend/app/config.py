from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from pathlib import Path, PureWindowsPath
from sqlalchemy.engine import make_url
from typing import Literal
from urllib.parse import urlsplit
import ipaddress


BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    SECRET_KEY: str
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = Field(default=720, ge=5, le=10080)
    # Keep this filename to preserve existing installations and records.
    DATABASE_URL: str = "sqlite:///./studyhub.db"
    UPLOAD_DIR: str = "./uploads"
    GEMINI_API_KEY: str = ""
    GEMINI_MODEL: str = "gemini-3.6-flash"
    WEB_RESEARCH_ENABLED: bool = True
    GEMINI_WEB_MODEL: str = ""
    WEB_RESEARCH_TIMEOUT_SECONDS: int = Field(default=35, ge=5, le=90)
    WEB_RESEARCH_MAX_SOURCES: int = Field(default=8, ge=1, le=8)
    CORS_ORIGINS: str = "http://localhost:3000,http://127.0.0.1:3000"
    MAX_UPLOAD_BYTES: int = Field(default=25 * 1024 * 1024, ge=1024, le=100 * 1024 * 1024)
    REGISTRATION_ENABLED: bool = True
    RATE_LIMIT_ENABLED: bool = True
    BACKUPS_ENABLED: bool = True
    BACKUP_DIR: str = str(BACKEND_DIR.parent / ".backups" / "automatic")
    BACKUP_INTERVAL_HOURS: int = Field(default=24, ge=1, le=168)
    BACKUP_RETENTION_COUNT: int = Field(default=14, ge=2, le=90)
    JOB_WORKERS: int = Field(default=2, ge=1, le=4)
    JOB_LEASE_SECONDS: int = Field(default=90, ge=15, le=600)
    JOB_TIMEOUT_SECONDS: int = Field(default=600, ge=30, le=1800)
    JOB_MAX_ATTEMPTS: int = Field(default=3, ge=1, le=5)
    PUBLIC_BASE_URL: str = "http://127.0.0.1:3000"
    RECOVERY_DELIVERY: Literal["auto", "smtp", "local", "disabled"] = "auto"
    PASSWORD_RESET_MINUTES: int = Field(default=30, ge=5, le=60)
    SMTP_HOST: str = ""
    SMTP_PORT: int = Field(default=587, ge=1, le=65535)
    SMTP_USERNAME: str = ""
    SMTP_PASSWORD: str = ""
    SMTP_FROM: str = ""
    SMTP_SECURITY: Literal["starttls", "ssl"] = "starttls"
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", extra="ignore")

    @field_validator("UPLOAD_DIR")
    @classmethod
    def absolute_upload_directory(cls, value: str) -> str:
        path = Path(value).expanduser()
        return str((path if path.is_absolute() else BACKEND_DIR / path).resolve())

    @field_validator("BACKUP_DIR")
    @classmethod
    def absolute_backup_directory(cls, value: str) -> str:
        path = Path(value).expanduser()
        return str((path if path.is_absolute() else BACKEND_DIR.parent / path).resolve())

    @field_validator("PUBLIC_BASE_URL")
    @classmethod
    def valid_site_origin(cls, value: str) -> str:
        parsed = urlsplit(value)
        if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ("", "/"):
            raise ValueError("PUBLIC_BASE_URL must be a site origin without a path or credentials")
        if parsed.scheme == "http" and parsed.hostname != "localhost":
            try:
                local = ipaddress.ip_address(parsed.hostname).is_private or ipaddress.ip_address(parsed.hostname).is_loopback
            except ValueError:
                local = False
            if not local:
                raise ValueError("Public PUBLIC_BASE_URL requires HTTPS")
        _ = parsed.port
        return value.rstrip("/")

    @field_validator("DATABASE_URL")
    @classmethod
    def database_relative_to_backend(cls, value: str) -> str:
        url = make_url(value)
        if url.get_backend_name() == "sqlite" and url.database and url.database != ":memory:":
            path = Path(url.database).expanduser()
            # Absolute Windows SQLite URLs also stay absolute if inspected on another OS.
            if not path.is_absolute() and not PureWindowsPath(url.database).is_absolute():
                url = url.set(database=str((BACKEND_DIR / path).resolve()))
                return url.render_as_string(hide_password=False)
        return value

    @field_validator("SECRET_KEY")
    @classmethod
    def strong_secret(cls, value: str) -> str:
        if len(value) < 32 or value.lower().startswith(("change", "replace", "your_")):
            raise ValueError("SECRET_KEY must be a randomly generated secret of at least 32 characters")
        return value


settings = Settings()
