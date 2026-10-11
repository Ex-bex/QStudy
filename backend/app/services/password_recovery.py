"""One-time hashed reset tokens; delivery never exposes a token through the API."""
import hashlib
import ipaddress
import json
import os
import secrets
import smtplib
import ssl
import tempfile
from datetime import datetime, timedelta, timezone
from email.message import EmailMessage
from email.headerregistry import Address
from pathlib import Path
from urllib.parse import urlsplit
import re

from sqlalchemy import func, update
from sqlalchemy.orm import Session
from fastapi import HTTPException
from pydantic import EmailStr, TypeAdapter, ValidationError

from app.auth import hash_password
from app.config import settings, BACKEND_DIR
from app.models import PasswordResetToken, User

LOCAL_OUTBOX = BACKEND_DIR.parent / ".local" / "recovery"
GENERIC_MESSAGE = "Если активный аккаунт с такой почтой существует, ссылка восстановления будет отправлена выбранным способом."


def now():
    return datetime.now(timezone.utc).replace(tzinfo=None)


def recovery_mode():
    mode = settings.RECOVERY_DELIVERY
    if mode == "auto":
        mode = "smtp" if settings.SMTP_HOST and settings.SMTP_FROM else "local"
    host = urlsplit(settings.PUBLIC_BASE_URL).hostname
    try:
        private = ipaddress.ip_address(host).is_private or ipaddress.ip_address(host).is_loopback
    except ValueError:
        private = host == "localhost"
    if mode == "local" and not private:
        return "disabled"
    if mode == "smtp" and (not settings.SMTP_HOST or not settings.SMTP_FROM):
        return "disabled"
    return mode


def issue_reset(db: Session, email: str):
    # Generate an equal-cost random value even for an unknown account.
    token = secrets.token_urlsafe(48)
    digest = hashlib.sha256(token.encode()).hexdigest()
    user = db.query(User).filter(func.lower(User.email) == email, User.is_active.is_(True)).first()
    if user is None:
        return None
    db.query(PasswordResetToken).filter(PasswordResetToken.user_id == user.id,
                                       PasswordResetToken.used_at.is_(None)).update({"used_at": now()})
    record = PasswordResetToken(user_id=user.id, token_hash=digest, token_version=user.token_version,
                                expires_at=now() + timedelta(minutes=settings.PASSWORD_RESET_MINUTES))
    db.add(record)
    db.commit()
    return record.id, user.email, token


def _mail_sender(value: str) -> Address:
    """Use the product name by default and allow one valid sender mailbox."""
    if not value or any(ord(character) < 32 or ord(character) == 127 for character in value):
        raise ValueError("Invalid mail sender")
    try:
        probe = EmailMessage()
        probe["From"] = value
        header = probe["From"]
        if header.defects or len(header.addresses) != 1 or any(group.display_name is not None for group in header.groups):
            raise ValueError("Invalid mail sender")
        sender = header.addresses[0]
        mailbox = str(TypeAdapter(EmailStr).validate_python(sender.addr_spec))
        return Address(display_name=sender.display_name or "QStudy", addr_spec=mailbox)
    except (ValueError, TypeError, IndexError, ValidationError) as error:
        raise ValueError("Invalid mail sender") from error


def _send_email(email: str, content: str, subject: str):
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = _mail_sender(settings.SMTP_FROM)
    message["To"] = email
    message.set_content(content)
    context = ssl.create_default_context()
    constructor = smtplib.SMTP_SSL if settings.SMTP_SECURITY == "ssl" else smtplib.SMTP
    kwargs = {"timeout": 15}
    if settings.SMTP_SECURITY == "ssl":
        kwargs["context"] = context
    with constructor(settings.SMTP_HOST, settings.SMTP_PORT, **kwargs) as server:
        if settings.SMTP_SECURITY == "starttls":
            server.ehlo()
            server.starttls(context=context)
            server.ehlo()
        if settings.SMTP_USERNAME:
            server.login(settings.SMTP_USERNAME, settings.SMTP_PASSWORD)
        server.send_message(message)


def _local_outbox_is_direct():
    """Reject filesystem redirects, while accepting Windows 8.3 path aliases."""
    directory = LOCAL_OUTBOX.absolute()
    try:
        # resolve() also expands ordinary short names such as RUNNER~1. That is
        # canonical spelling, not a symlink; inspect the actual path ancestors.
        return not any(path.is_symlink() or path.is_junction()
                       for path in (directory, *directory.parents))
    except OSError:
        return False


def _write_private_message(email: str, token: str, link: str):
    if not _local_outbox_is_direct():
        raise ValueError("Local recovery storage must not be a redirected directory")
    LOCAL_OUTBOX.mkdir(parents=True, exist_ok=True)
    # Keep links outside uploads/static directories; never send paths in responses.
    current = now()
    for path in LOCAL_OUTBOX.glob("*.json"):
        if path.is_symlink():
            continue
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if datetime.fromisoformat(data["expires_at"]) <= current:
                path.unlink()
        except (OSError, ValueError, KeyError, TypeError):
            continue
    descriptor, filename = tempfile.mkstemp(prefix="reset-", suffix=".json", dir=LOCAL_OUTBOX)
    try:
        os.chmod(filename, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            json.dump({"recipient": email, "link": link, "expires_at":
                       (now() + timedelta(minutes=settings.PASSWORD_RESET_MINUTES)).isoformat()}, output, ensure_ascii=False)
    except Exception:
        Path(filename).unlink(missing_ok=True)
        raise


def deliver_reset(bind, reset_id: int, email: str, token: str, mode: str):
    with Session(bind=bind) as db:
        record = db.get(PasswordResetToken, reset_id)
        user = db.get(User, record.user_id) if record else None
        if not record or record.used_at is not None or record.expires_at <= now() or not user or not user.is_active or user.token_version != record.token_version:
            return
    link = settings.PUBLIC_BASE_URL + "/reset-password#token=" + token
    delivered = False
    try:
        if mode == "smtp":
            _send_email(email, f"Для восстановления пароля QStudy откройте ссылку:\n{link}\n\n"
                        f"Ссылка действует {settings.PASSWORD_RESET_MINUTES} минут и только один раз. "
                        "Если вы не запрашивали восстановление, проигнорируйте письмо.", "QStudy — восстановление пароля")
        elif mode == "local":
            _write_private_message(email, token, link)
        else:
            raise ValueError("Recovery delivery disabled")
        delivered = True
    except Exception:
        # Never log the email, token, provider error or credentials.
        pass
    with Session(bind=bind) as db:
        record = db.get(PasswordResetToken, reset_id)
        if record:
            record.delivery_status = "delivered" if delivered else "failed"
            db.commit()


def find_local_reset_link(db: Session, email: str, site_url: str):
    if not _local_outbox_is_direct():
        return None
    candidates = []
    for path in LOCAL_OUTBOX.glob("*.json"):
        try:
            if not path.is_symlink():
                candidates.append((path.stat().st_mtime, path))
        except OSError:
            # Expired messages may be removed by a concurrent delivery.
            continue
    for _, path in sorted(candidates, reverse=True):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            if data["recipient"].lower() != email.lower():
                continue
            fragment = urlsplit(data["link"]).fragment
            if not re.fullmatch(r"token=[A-Za-z0-9_-]{40,128}", fragment):
                continue
            token = fragment[6:]
            record = db.query(PasswordResetToken).filter_by(token_hash=hashlib.sha256(token.encode()).hexdigest()).first()
            user = db.get(User, record.user_id) if record else None
            if not record or record.used_at is not None or record.expires_at <= now() or not user or not user.is_active or user.token_version != record.token_version:
                continue
            if user.email.lower() != email.lower():
                continue
            return site_url.rstrip("/") + "/reset-password#token=" + token
        except (OSError, KeyError, ValueError, TypeError):
            continue
    return None


def complete_reset(db: Session, token: str, new_password: str):
    digest = hashlib.sha256(token.encode()).hexdigest()
    # The token claim and session invalidation share one transaction.
    record = db.query(PasswordResetToken).filter(PasswordResetToken.token_hash == digest,
              PasswordResetToken.used_at.is_(None), PasswordResetToken.expires_at > now()).first()
    error = HTTPException(400, "Ссылка недействительна, уже использована или истекла. Запросите новую.")
    if not record:
        raise error
    user = db.get(User, record.user_id)
    if not user or not user.is_active or user.token_version != record.token_version:
        raise error
    encoded_password = hash_password(new_password)
    claimed = db.execute(update(PasswordResetToken).where(PasswordResetToken.id == record.id,
              PasswordResetToken.used_at.is_(None), PasswordResetToken.expires_at > now()).values(used_at=now()))
    if claimed.rowcount != 1:
        db.rollback()
        raise error
    changed = db.execute(update(User).where(User.id == user.id, User.is_active.is_(True),
                User.token_version == record.token_version).values(hashed_password=encoded_password,
                token_version=User.token_version + 1), execution_options={"synchronize_session": False})
    if changed.rowcount != 1:
        db.rollback()
        raise error
    db.query(PasswordResetToken).filter(PasswordResetToken.user_id == user.id,
              PasswordResetToken.used_at.is_(None)).update({"used_at": now()})
    if user.role == "admin":
        from app.services.audit import record_audit
        record_audit(db, user, "auth.password_reset", "user", user.id)
    db.commit()
    return user.email
