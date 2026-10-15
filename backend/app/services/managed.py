"""Admin settings and authenticated, one-shot requests to the native supervisor."""
from __future__ import annotations
import ctypes
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from dotenv import dotenv_values
from app.config import BACKEND_DIR, Settings, settings


class ManagementError(Exception):
    """A deliberately public explanation; never includes environment values."""


EDITABLE = frozenset({
    "SMTP_HOST", "SMTP_PORT", "SMTP_USERNAME", "SMTP_FROM", "SMTP_SECURITY", "RECOVERY_DELIVERY",
    "SMTP_PASSWORD", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_WEB_MODEL", "WEB_RESEARCH_ENABLED",
    "REGISTRATION_ENABLED", "BACKUPS_ENABLED", "BACKUP_INTERVAL_HOURS", "BACKUP_RETENTION_COUNT",
})
SECRET_FIELDS = frozenset({"SMTP_PASSWORD", "GEMINI_API_KEY"})
_settings_lock = threading.Lock()
_request_lock = threading.Lock()


def utc_now():
    return datetime.now(timezone.utc)


def iso_now():
    return utc_now().isoformat().replace("+00:00", "Z")


def ordinary_path(path: Path) -> Path:
    """Reject links before resolving: resolving first would hide an escape."""
    path = Path(os.path.abspath(path))
    for parent in (path, *path.parents):
        if parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()):
            raise ManagementError("QStudy: папки управления не должны содержать ссылки или junction")
    return path


def project_root() -> Path:
    value = os.environ.get("QSTUDY_PROJECT_ROOT", "")
    root = ordinary_path(Path(value) if value else BACKEND_DIR.parent)
    if not root.is_dir():
        raise ManagementError("QStudy: папка проекта недоступна")
    return root


def inside_root(path: Path, root: Path | None = None) -> Path:
    root = project_root() if root is None else ordinary_path(root)
    result = ordinary_path(path)
    if result == root or not result.is_relative_to(root):
        raise ManagementError("QStudy: путь выходит за пределы проекта")
    return result


def make_private(path: Path, *, directory: bool = False):
    """Private files on both supported OSes, without logging OS error details."""
    try:
        if os.name != "nt":
            path.chmod(0o700 if directory else 0o600)
            return
        # OW grants the file owner, SYSTEM and Administrators; inheritance is
        # removed. No account names, shell invocation or broad Users ACEs.
        advapi = ctypes.WinDLL("advapi32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        descriptor = ctypes.c_void_p()
        convert = advapi.ConvertStringSecurityDescriptorToSecurityDescriptorW
        convert.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
        convert.restype = ctypes.c_int
        setter = advapi.SetFileSecurityW
        setter.argtypes = [ctypes.c_wchar_p, ctypes.c_ulong, ctypes.c_void_p]
        setter.restype = ctypes.c_int
        inheritance = "OICI" if directory else ""
        sddl = "D:P" + "".join("(A;" + inheritance + ";FA;;;" + sid + ")" for sid in ("OW", "SY", "BA"))
        if not convert(sddl, 1, ctypes.byref(descriptor), None):
            raise OSError()
        try:
            if not setter(str(path), 0x80000004, descriptor):
                raise OSError()
        finally:
            kernel.LocalFree.argtypes = [ctypes.c_void_p]
            kernel.LocalFree(descriptor)
    except OSError as error:
        raise ManagementError("QStudy: не удалось закрыть доступ к приватному файлу") from error


def atomic_private(path: Path, data: bytes, *, replace=True):
    path = inside_root(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_relative_to(project_root() / ".local"):
        make_private(path.parent, directory=True)
    temporary = path.with_name(".pending-" + uuid.uuid4().hex)
    try:
        with temporary.open("xb") as target:
            make_private(temporary)
            target.write(data)
            target.flush()
            os.fsync(target.fileno())
        if replace:
            os.replace(temporary, path)
        else:
            # Publish a complete, fsynced file without replacing a queued
            # request. Windows rename uses MoveFileEx without REPLACE_EXISTING;
            # POSIX link is the exclusive atomic publication primitive.
            if os.name == "nt":
                os.rename(temporary, path)
            else:
                os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def settings_file() -> Path:
    root = project_root()
    value = os.environ.get("QSTUDY_ENV_FILE", "") if os.environ.get("QSTUDY_MANAGED_RUNTIME") == "1" else ""
    path = inside_root(Path(value) if value else root / "backend" / ".env", root)
    if path not in (root / "backend" / ".env", root / "deployment" / ".env"):
        raise ManagementError("QStudy: выбран неизвестный файл настроек")
    return path


def _env_text(path):
    if not path.exists():
        return ""
    if not path.is_file() or path.stat().st_size > 128 * 1024:
        raise ManagementError("QStudy: файл настроек недоступен или слишком велик")
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            return source.read()
    except (OSError, UnicodeError) as error:
        raise ManagementError("QStudy: не удалось прочитать настройки") from error


def _validated(values: dict):
    try:
        return Settings(_env_file=None, **{**settings.model_dump(), **values})
    except Exception as error:
        # Pydantic errors can contain passwords/API keys in input_value.
        raise ManagementError("Проверьте типы и допустимые значения настроек QStudy") from error


def editable_model():
    path = settings_file()
    _env_text(path)
    try:
        values = dotenv_values(path, interpolate=False) if path.exists() else {}
        return _validated({key: value for key, value in values.items() if key in EDITABLE and value is not None})
    except ManagementError:
        raise
    except Exception as error:
        raise ManagementError("Не удалось проверить настройки QStudy") from error


def settings_public(model=None, *, restart_required=None):
    model = editable_model() if model is None else model
    if restart_required is None:
        restart_required = any(getattr(model, key) != getattr(settings, key) for key in EDITABLE)
    values = {key: getattr(model, key) for key in sorted(EDITABLE - SECRET_FIELDS)}
    values.update(has_smtp_password=bool(model.SMTP_PASSWORD), has_gemini_api_key=bool(model.GEMINI_API_KEY), restart_required=restart_required)
    return values


def prepare_settings_update(changes: dict) -> tuple[dict, bytes]:
    if not isinstance(changes, dict) or set(changes) - EDITABLE:
        raise ManagementError("Изменять можно только перечисленные настройки QStudy")
    clean = {}
    for key, value in changes.items():
        if key in SECRET_FIELDS and (value is None or value == ""):
            continue
        if type(value) not in (str, int, bool) or (isinstance(value, str) and (len(value) > 4096 or any(ord(c) < 32 or ord(c) == 127 for c in value))):
            raise ManagementError("Настройки не должны содержать управляющие символы или слишком длинные значения")
        clean[key] = value
    model = _validated({**editable_model().model_dump(), **clean})
    path = settings_file()
    text = _env_text(path)
    if not clean:
        return model.model_dump(), path.read_bytes() if path.exists() else b""
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()
    for key in sorted(clean):
        value = getattr(model, key)
        encoded = json.dumps(str(value).lower() if type(value) is bool else str(value), ensure_ascii=False)
        assignment = key + "=" + encoded
        matches = [i for i, line in enumerate(lines) if re.match(r"^\s*(?:export\s+)?" + re.escape(key) + r"\s*=", line)]
        if len(matches) > 1:
            raise ManagementError("Файл настроек содержит повторяющиеся параметры; исправьте его перед сохранением")
        if matches:
            lines[matches[0]] = assignment
        else:
            lines.append(assignment)
    prefix = b"\xef\xbb\xbf" if path.exists() and path.read_bytes().startswith(b"\xef\xbb\xbf") else b""
    return model.model_dump(), prefix + (newline.join(lines) + newline).encode("utf-8")


def update_settings(changes: dict):
    with _settings_lock:
        values, payload = prepare_settings_update(changes)
        atomic_private(settings_file(), payload)
        return settings_public(_validated(values))


def managed_status():
    unavailable = {"managed": False, "control_ready": False, "status": "unavailable", "mode": "", "public_url": settings.PUBLIC_BASE_URL,
                   "ports": {}, "data_source": "", "checked_utc": None}
    try:
        if os.environ.get("QSTUDY_MANAGED_RUNTIME") != "1" or len(os.environ.get("QSTUDY_CONTROL_TOKEN", "")) < 32:
            return unavailable
        root = project_root()
        directory = inside_root(Path(os.environ.get("QSTUDY_CONTROL_DIR", "")), root)
        if directory != root / ".local" / "managed":
            return unavailable
        path = inside_root(directory / "status.json", root)
        if not path.is_file() or path.stat().st_size > 16384:
            return unavailable
        report = json.loads(path.read_text(encoding="utf-8-sig"))
        checked = datetime.fromisoformat(str(report.get("checked_utc", report.get("updated_at", ""))).replace("Z", "+00:00"))
        age = (utc_now() - checked).total_seconds()
        if report.get("version") != 1 or not -5 <= age <= 15 or report.get("root_owner", str(root)) != str(root):
            return unavailable
        ready = report.get("control_ready", report.get("control_available")) is True
        ports = report.get("ports", {"frontend": report.get("frontend_port"), "backend": report.get("backend_port")})
        if not isinstance(ports, dict) or any(type(ports.get(k)) is not int or not 1 <= ports[k] <= 65535 for k in ("frontend", "backend")):
            return unavailable
        generation = report.get("generation")
        last_action = report.get("last_action")
        clean_action = None
        if (isinstance(last_action, dict) and re.fullmatch(r"[a-f0-9]{32}", str(last_action.get("id", "")))
                and last_action.get("action") in ("restart", "stop", "apply-import") and last_action.get("status") in ("running", "complete", "failed")):
            clean_action = {key: last_action[key] for key in ("id", "action", "status")}
            if last_action.get("code") in ("explicit_import_failed", "import_interrupted", "import_state_unknown", "restart_failed"):
                clean_action["code"] = last_action["code"]
        return {"managed": True, "control_ready": ready, "status": str(report.get("state", "running")) if report.get("state", "running") in ("running", "starting", "stopped", "failed") else "running",
                "mode": str(report.get("mode", ""))[:30], "public_url": settings.PUBLIC_BASE_URL,
                "ports": {"frontend": ports["frontend"], "backend": ports["backend"]}, "data_source": str(report.get("data_source", ""))[:100], "checked_utc": checked.isoformat(),
                "generation": generation if type(generation) is int and generation >= 0 else None, "last_action": clean_action}
    except (OSError, ValueError, TypeError, ManagementError):
        return unavailable


def request_control(action: str, actor_id: int, payload=None):
    if action not in ("restart", "stop", "apply-import") or type(actor_id) is not int or actor_id <= 0:
        raise ManagementError("Недопустимая команда управления QStudy")
    payload = {} if payload is None else payload
    if action == "apply-import":
        if (not isinstance(payload, dict) or set(payload) != {"transfer_id", "include_settings"}
                or not re.fullmatch(r"[a-f0-9]{32}", str(payload.get("transfer_id", ""))) or type(payload.get("include_settings")) is not bool):
            raise ManagementError("Недопустимые параметры восстановления")
    elif payload:
        raise ManagementError("Команда не принимает дополнительные параметры")
    if not managed_status()["control_ready"]:
        raise ManagementError("Для управления запуском откройте QStudy через обновлённую кнопку Start-QStudy.cmd")
    request = {"version": 1, "id": uuid.uuid4().hex, "action": action, "payload": payload, "requested_by": actor_id, "issued_at": iso_now()}
    token = os.environ.get("QSTUDY_CONTROL_TOKEN", "")
    request["signature"] = hmac.new(token.encode(), json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(), hashlib.sha256).hexdigest()
    path = inside_root(project_root() / ".local" / "managed" / "request.json")
    try:
        with _request_lock:
            atomic_private(path, json.dumps(request, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode(), replace=False)
    except FileExistsError as error:
        raise ManagementError("Другая команда уже ожидает выполнения; дождитесь её завершения") from error
    except OSError as error:
        raise ManagementError("Не удалось передать команду управления QStudy") from error
    return {"status": "requested", "request_id": request["id"], "action": action,
            "message": "Команда принята. Приложение выполнит её после безопасной остановки процессов."}
