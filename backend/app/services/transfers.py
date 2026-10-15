"""Explicit administrator transfers. Ordinary application startup never restores data.

Uploaded source files are verified for a portable bundle but are NEVER installed.
Only an offline supervisor may replace the active database and private uploads.
"""
from __future__ import annotations
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import unicodedata
import uuid
import zipfile
from contextlib import closing
from datetime import timedelta
from pathlib import Path, PurePosixPath, PureWindowsPath
from sqlalchemy.engine import make_url
from app.config import settings
from app.services import managed
from app.services.backups import BackupService, BackupError, _invalidate_restored_credentials
from app.storage import resolve_upload_path


class TransferError(Exception):
    pass


_ID = re.compile(r"^[a-f0-9]{32}$")
_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_guard = threading.Lock()
MAX_FILES = 100000
MAX_EXPANDED = 20 * 1024 ** 3
MAX_MANIFEST = 8 * 1024 ** 2
MAX_SETTINGS = 128 * 1024
EXPIRES_HOURS = 24
_SOURCE_ROOTS = {"frontend", "scripts", "docs", "assets", ".github"}
_ROOT_FILES = {"README.md", "LICENSE", ".gitignore", ".gitattributes", ".dockerignore", "Install-QStudy.cmd", "Start-QStudy.cmd", "Start-QStudy-LAN.cmd", "Start-QStudy-Internet.cmd"}
_EXCLUDED = {"node_modules", ".next", ".venv", "venv", "__pycache__", ".git", ".local", ".backups", "data", "uploads", "output", "local-documents", "build", "dist", "out"}
_COUNT_TABLES = {"accounts": "users", "groups": "student_groups", "courses": "courses", "documents": "syllabus_documents"}


def directory():
    root = managed.project_root()
    path = managed.inside_root(root / ".local" / "transfers", root)
    path.mkdir(parents=True, exist_ok=True)
    managed.make_private(path, directory=True)
    return path


def _stage(transfer_id, *, read_only=False):
    if not isinstance(transfer_id, str) or not _ID.fullmatch(transfer_id):
        raise TransferError("Передача не найдена")
    store = managed.inside_root(managed.project_root() / ".local" / "transfers") if read_only else directory()
    return managed.inside_root(store / ("import-" + transfer_id))


def _paths():
    url = make_url(settings.DATABASE_URL)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise TransferError("Перенос поддерживает файловую базу SQLite")
    database = managed.inside_root(Path(url.database))
    uploads = managed.inside_root(Path(settings.UPLOAD_DIR))
    if database.is_relative_to(uploads) or database == uploads:
        raise TransferError("База и папка загрузок должны быть раздельными")
    return database, uploads


def _hash(path):
    value = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def _save_state(stage, state):
    managed.atomic_private(stage / "state.json", json.dumps(state, ensure_ascii=False).encode())


def _read_state(transfer_id, *, ready=True):
    stage = _stage(transfer_id, read_only=True)
    path = managed.inside_root(stage / "state.json")
    try:
        if not path.is_file() or path.stat().st_size > 65536:
            raise ValueError()
        value = json.loads(path.read_text(encoding="utf-8"))
        expiration = managed.utc_now().fromisoformat(value["expires_at"].replace("Z", "+00:00"))
        if value.get("transfer_id") != transfer_id or expiration < managed.utc_now() or (ready and value.get("status") != "prepared"):
            raise ValueError()
        return stage, value
    except (OSError, ValueError, TypeError, KeyError) as error:
        raise TransferError("Подготовленная передача недоступна или устарела. Загрузите ZIP заново") from error


def read_import_receipt(transfer_id: str):
    """Safe durable outcome for the supervisor; no expiration for crash guards."""
    stage = _stage(transfer_id, read_only=True)
    path = managed.inside_root(stage / "state.json")
    try:
        if not path.is_file() or path.stat().st_size > 65536:
            raise ValueError()
        value = json.loads(path.read_text(encoding="utf-8"))
        if (value.get("version") != 1 or value.get("transfer_id") != transfer_id
                or value.get("status") not in ("prepared", "applying", "applied", "failed_rolled_back")):
            raise ValueError()
        return {"transfer_id": transfer_id, "status": value["status"]}
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise TransferError("Не удалось подтвердить результат передачи данных. Запуск остановлен для сохранности данных") from error


def assert_no_incomplete_imports():
    """Read-only boot guard: never replays, repairs or rolls back an import."""
    store = managed.inside_root(managed.project_root() / ".local" / "transfers")
    if not store.exists():
        return
    if not store.is_dir():
        raise TransferError("Папка передач данных недоступна. Запуск остановлен для сохранности данных")
    for stage in store.iterdir():
        if re.fullmatch(r"import-[a-f0-9]{32}", stage.name):
            managed.ordinary_path(stage)
            if (stage / "state.json").exists():
                if read_import_receipt(stage.name[len("import-"):])["status"] == "applying":
                    raise TransferError("Предыдущее восстановление прервалось. Запуск остановлен; данные не восстанавливаются автоматически. Сохраните папку проекта для проверки")


def _safe_name(name):
    if (not isinstance(name, str) or not name or len(name) > 500 or "\\" in name or ":" in name or name.startswith("/")
            or unicodedata.normalize("NFC", name) != name or any(ord(c) < 32 or ord(c) == 127 for c in name)):
        raise TransferError("Архив содержит недопустимый путь")
    parts = name.split("/")
    if any(p in ("", ".", "..") or p.endswith((".", " ")) or p.split(".")[0].upper() in {"CON", "PRN", "AUX", "NUL", *("COM" + str(i) for i in range(1, 10)), *("LPT" + str(i) for i in range(1, 10))} for p in parts):
        raise TransferError("Архив содержит недопустимый путь")
    return name


def _manifest(source):
    entries = source.infolist()
    if not entries or len(entries) > MAX_FILES + 1:
        raise TransferError("Архив содержит слишком много файлов")
    names = [item.filename for item in entries]
    folded = set()
    total = 0
    for item in entries:
        _safe_name(item.filename)
        key = item.filename.casefold()
        mode = item.external_attr >> 16
        if (key in folded or item.is_dir() or stat.S_ISLNK(mode) or (stat.S_IFMT(mode) not in (0, stat.S_IFREG))
                or item.flag_bits & 1 or item.file_size < 0):
            raise TransferError("Архив содержит ссылки, повторяющиеся или неподдерживаемые записи")
        folded.add(key)
        total += item.file_size
        if total > MAX_EXPANDED or (item.file_size > 1024 ** 2 and item.file_size > max(1, item.compress_size) * 1000):
            raise TransferError("Архив слишком велик после распаковки")
    standard = "manifest.json" in names
    portable_names = [name for name in names if name == "qstudy-transfer.json" or name == "QStudy/qstudy-transfer.json"]
    if standard and portable_names or len(portable_names) > 1 or (not standard and not portable_names):
        raise TransferError("ZIP не является резервной копией или переносимым проектом QStudy")
    manifest_name = "manifest.json" if standard else portable_names[0]
    if source.getinfo(manifest_name).file_size > MAX_MANIFEST:
        raise TransferError("Описание архива слишком велико")
    try:
        manifest = json.loads(source.read(manifest_name))
    except (ValueError, UnicodeError) as error:
        raise TransferError("Описание архива повреждено") from error
    if not isinstance(manifest, dict) or manifest.get("application") != "QStudy" or type(manifest.get("format")) is not int or manifest.get("format") != (1 if standard else 2):
        raise TransferError("Неизвестный формат архива QStudy")
    files = manifest.get("files")
    if not isinstance(files, dict) or not files or len(files) > MAX_FILES or set(names) != set(files) | {manifest_name}:
        raise TransferError("Список файлов архива не совпадает с описанием")
    prefix = "QStudy/" if manifest_name.startswith("QStudy/") else ""
    database_name = "database.sqlite3" if standard else prefix + "backend/studyhub.db"
    uploads_prefix = "uploads/" if standard else prefix + "backend/uploads/"
    settings_name = None if standard else prefix + "backend/.env"
    if database_name not in files or (not standard and settings_name not in files):
        raise TransferError("В архиве отсутствует база или настройки переносимого проекта")
    for name, metadata in files.items():
        _safe_name(name)
        if not standard and prefix and not name.startswith(prefix):
            raise TransferError("Переносимый проект содержит файлы вне папки QStudy")
        if standard and name != database_name and not name.startswith(uploads_prefix):
            raise TransferError("Резервная копия содержит посторонние файлы")
        if not isinstance(metadata, dict) or type(metadata.get("size")) is not int or metadata["size"] != source.getinfo(name).file_size or not isinstance(metadata.get("sha256"), str) or not _DIGEST.fullmatch(metadata["sha256"]):
            raise TransferError("Метаданные файла в архиве повреждены")
    return manifest, database_name, uploads_prefix, settings_name


def _normalize_database(database, upload_names, source_upload_root=None):
    """Normalize the snapshot only; never search or read arbitrary host files."""
    references = set()
    with closing(sqlite3.connect(database, timeout=30)) as connection, connection:
        connection.execute("PRAGMA trusted_schema=OFF")
        if connection.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
            raise TransferError("База в архиве повреждена")
        tables = {name: sql for name, sql in connection.execute("SELECT name,sql FROM sqlite_master WHERE type='table'")}
        if "users" not in tables or any((sql or "").lstrip().upper().startswith("CREATE VIRTUAL TABLE") for sql in tables.values()):
            raise TransferError("Архив не содержит поддерживаемую базу QStudy")
        counts = {}
        for label, table in _COUNT_TABLES.items():
            counts[label] = connection.execute('SELECT COUNT(*) FROM "' + table + '"').fetchone()[0] if table in tables else 0
        user_columns = {row[1] for row in connection.execute('PRAGMA table_info("users")')}
        if not {"id", "role", "hashed_password"} <= user_columns:
            raise TransferError("Структура аккаунтов в архиве не поддерживается")
        active = " AND is_active=1" if "is_active" in user_columns else ""
        if not connection.execute("SELECT 1 FROM users WHERE role='admin'" + active + " LIMIT 1").fetchone():
            raise TransferError("Архив должен содержать хотя бы одного активного администратора")
        for table in tables:
            if table.startswith("sqlite_"):
                continue
            quoted = '"' + table.replace('"', '""') + '"'
            columns = {row[1] for row in connection.execute(f"PRAGMA table_info({quoted})")}
            if "filepath" not in columns:
                continue
            for (value,) in connection.execute(f"SELECT DISTINCT filepath FROM {quoted} WHERE filepath IS NOT NULL AND filepath != ''").fetchall():
                if not isinstance(value, str) or "\x00" in value:
                    raise TransferError("База содержит недопустимую ссылку на документ")
                normalized = value.replace("\\", "/")
                path = PurePosixPath(normalized)
                if path.is_absolute() or PureWindowsPath(value).is_absolute():
                    roots = [str(settings.UPLOAD_DIR)]
                    if source_upload_root:
                        roots.append(source_upload_root)
                    relative = None
                    for root in roots:
                        base = str(root).replace("\\", "/").rstrip("/") + "/"
                        if normalized.casefold().startswith(base.casefold()):
                            relative = normalized[len(base):]
                            break
                    if relative is None:
                        raise TransferError("Архив содержит абсолютные пути старого компьютера. Создайте переносимый экспорт через админку")
                else:
                    relative = normalized
                    if relative.startswith("uploads/") and relative not in upload_names:
                        relative = relative[len("uploads/"):]
                _safe_name(relative)
                if relative not in upload_names:
                    raise TransferError("В архиве отсутствует документ, указанный в базе")
                references.add(relative)
                if value != relative:
                    connection.execute(f"UPDATE {quoted} SET filepath=? WHERE filepath=?", (relative, value))
        connection.commit()
        return counts


def _verify_extract(archive, destination):
    try:
        destination.mkdir(parents=True, exist_ok=False)
        managed.make_private(destination, directory=True)
        with zipfile.ZipFile(archive) as source:
            manifest, database_name, uploads_prefix, settings_name = _manifest(source)
            uploads = set()
            upload_bytes = 0
            for name, metadata in manifest["files"].items():
                target = None
                if name == database_name:
                    target = destination / "database.sqlite3"
                elif name.startswith(uploads_prefix):
                    relative = name[len(uploads_prefix):]
                    _safe_name(relative)
                    uploads.add(relative)
                    target = destination / "uploads" / relative
                    upload_bytes += metadata["size"]
                elif name == settings_name:
                    if metadata["size"] > MAX_SETTINGS:
                        raise TransferError("Файл настроек в архиве слишком велик")
                    target = destination / "import.env"
                digest = hashlib.sha256()
                output = None
                if target:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    output = target.open("xb")
                    managed.make_private(target)
                length = 0
                try:
                    with source.open(name) as item:
                        while chunk := item.read(1024 * 1024):
                            length += len(chunk)
                            if length > metadata["size"]:
                                raise TransferError("Файл превышает заявленный размер")
                            digest.update(chunk)
                            if output:
                                output.write(chunk)
                finally:
                    if output:
                        output.close()
                if length != metadata["size"] or digest.hexdigest() != metadata["sha256"]:
                    raise TransferError("Контрольная сумма файла в архиве не совпадает")
        counts = _normalize_database(destination / "database.sqlite3", uploads, manifest.get("original_upload_root"))
        counts["uploads"] = len(uploads)
        imported = {}
        if settings_name:
            from dotenv import dotenv_values
            imported = {key: value for key, value in dotenv_values(destination / "import.env", interpolate=False).items() if key in managed.EDITABLE and value is not None}
            managed.prepare_settings_update(imported)
        return {"format": "backup" if manifest["format"] == 1 else "portable", "created_at": str(manifest.get("created_at", ""))[:100],
                "counts": counts, "upload_bytes": upload_bytes, "has_settings": bool(settings_name), "settings_keys": sorted(imported),
                "warnings": (["Программные файлы из ZIP проверены, но при импорте не устанавливаются"] if settings_name else []), "imported_settings": imported}
    except (TransferError, managed.ManagementError):
        raise
    except (OSError, ValueError, TypeError, KeyError, sqlite3.Error, zipfile.BadZipFile, RuntimeError) as error:
        raise TransferError("Не удалось проверить ZIP. Проверьте формат, свободное место и целостность архива") from error


async def receive_import(request, actor_id):
    transfer_id = uuid.uuid4().hex
    stage = _stage(transfer_id)
    stage.mkdir(parents=True, exist_ok=False)
    managed.make_private(stage, directory=True)
    archive = stage / "incoming.zip"
    size = 0
    try:
        with archive.open("xb") as target:
            managed.make_private(archive)
            async for chunk in request.stream():
                size += len(chunk)
                if size > settings.MAX_TRANSFER_BYTES:
                    raise TransferError("ZIP превышает допустимый размер 2 ГБ")
                target.write(chunk)
            target.flush()
            os.fsync(target.fileno())
        if not size:
            raise TransferError("ZIP пустой")
        import asyncio
        preview = await asyncio.to_thread(_verify_extract, archive, stage / "verified")
        # Preview extraction is disposable. Keep the original verified archive,
        # not a second expanded copy; apply verifies it again while stopped.
        shutil.rmtree(stage / "verified")
        preview.pop("imported_settings", None)
        state = {**preview, "version": 1, "transfer_id": transfer_id, "status": "prepared", "expires_at": (managed.utc_now() + timedelta(hours=EXPIRES_HOURS)).isoformat(),
                 "archive_sha256": _hash(archive), "actor_id": actor_id}
        _save_state(stage, state)
        return preview_import(transfer_id)
    except BaseException:
        shutil.rmtree(stage, ignore_errors=True)
        raise


def preview_import(transfer_id):
    _, value = _read_state(transfer_id)
    keys = ("transfer_id", "format", "created_at", "counts", "upload_bytes", "has_settings", "settings_keys", "warnings", "status", "expires_at")
    return {key: value[key] for key in keys}


def queue_import(transfer_id, actor_id, include_settings=True):
    stage, state = _read_state(transfer_id)
    if _hash(stage / "incoming.zip") != state.get("archive_sha256"):
        raise TransferError("Подготовленный ZIP изменился. Загрузите архив заново")
    return managed.request_control("apply-import", actor_id, {"transfer_id": transfer_id, "include_settings": bool(include_settings)})


def apply_prepared_import(transfer_id: str, include_settings: bool = True):
    """Offline entry point. The supervisor must stop both application children.

    The one-shot state is consumed before replacement. Ordinary boot never calls
    this routine, and uploaded source code is never copied into the checkout.
    """
    if type(include_settings) is not bool:
        raise TransferError("Недопустимые параметры восстановления")
    if not _guard.acquire(blocking=False):
        raise TransferError("Другая передача данных уже выполняется")
    try:
        stage, state = _read_state(transfer_id)
        archive = stage / "incoming.zip"
        if _hash(archive) != state.get("archive_sha256"):
            raise TransferError("Подготовленный ZIP изменился")
        fresh = stage / ("apply-" + uuid.uuid4().hex)
        preview = _verify_extract(archive, fresh)
        database, uploads = _paths()
        env = managed.settings_file()
        env_data = None
        if include_settings and preview["has_settings"]:
            _, env_data = managed.prepare_settings_update(preview["imported_settings"])
        _invalidate_restored_credentials(fresh / "database.sqlite3")
        # Existing data moves within the same filesystem for this explicit
        # transaction; it is not a startup snapshot or an automatic restore.
        transaction = stage / ("transaction-" + uuid.uuid4().hex)
        transaction.mkdir()
        old_database = database.with_name(".transfer-old-" + uuid.uuid4().hex + ".db")
        old_uploads = uploads.with_name(".transfer-old-" + uuid.uuid4().hex)
        replacement_database = database.with_name(".transfer-new-" + uuid.uuid4().hex + ".db")
        replacement_uploads = uploads.with_name(".transfer-new-" + uuid.uuid4().hex)
        database.parent.mkdir(parents=True, exist_ok=True)
        uploads.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fresh / "database.sqlite3", replacement_database)
        managed.make_private(replacement_database)
        replacement_uploads.mkdir()
        managed.make_private(replacement_uploads, directory=True)
        if (fresh / "uploads").exists():
            shutil.copytree(fresh / "uploads", replacement_uploads, dirs_exist_ok=True)
        env_before = env.read_bytes() if env.exists() else None
        old_sidecars = []
        moved_database = moved_uploads = installed_database = installed_uploads = env_changed = False
        state["status"] = "applying"
        _save_state(stage, state)
        try:
            if database.exists():
                os.replace(database, old_database)
                moved_database = True
            for suffix in ("-wal", "-shm", "-journal"):
                sidecar = Path(str(database) + suffix)
                if sidecar.exists():
                    retired = transaction / ("database" + suffix)
                    os.replace(sidecar, retired)
                    old_sidecars.append((retired, sidecar))
            if uploads.exists():
                os.replace(uploads, old_uploads)
                moved_uploads = True
            os.replace(replacement_database, database)
            installed_database = True
            os.replace(replacement_uploads, uploads)
            installed_uploads = True
            if env_data is not None:
                managed.atomic_private(env, env_data)
                env_changed = True
            state["status"] = "applied"
            state["applied_at"] = managed.iso_now()
            _save_state(stage, state)
        except BaseException as error:
            if installed_database:
                database.unlink(missing_ok=True)
            if installed_uploads:
                shutil.rmtree(uploads)
            if moved_database:
                os.replace(old_database, database)
            if moved_uploads:
                os.replace(old_uploads, uploads)
            for retired, original in old_sidecars:
                if retired.exists():
                    os.replace(retired, original)
            if env_changed:
                if env_before is None:
                    env.unlink(missing_ok=True)
                else:
                    managed.atomic_private(env, env_before)
            state["status"] = "failed_rolled_back"
            _save_state(stage, state)
            raise TransferError("Восстановление не завершено. Исходные данные сохранены; ZIP можно загрузить повторно") from error
        finally:
            replacement_database.unlink(missing_ok=True)
            if replacement_uploads.exists():
                shutil.rmtree(replacement_uploads)
        # Success removes transaction-only former state. No recurring rollback.
        try:
            old_database.unlink(missing_ok=True)
            if old_uploads.exists():
                shutil.rmtree(old_uploads)
            shutil.rmtree(transaction)
            shutil.rmtree(fresh)
        except OSError:
            pass  # Durable applied state is authoritative; no recurring rollback.
        return {"status": "applied", "transfer_id": transfer_id, "settings_applied": env_data is not None}
    except (TransferError, managed.ManagementError):
        raise
    except (OSError, ValueError, sqlite3.Error) as error:
        raise TransferError("Не удалось выполнить передачу данных. Сохраните ZIP и текущие данные для проверки") from error
    finally:
        _guard.release()


def _source_files(root):
    for current, folders, names in os.walk(root, followlinks=False):
        here = Path(current)
        relative_dir = here.relative_to(root)
        if relative_dir == Path("."):
            folders[:] = [name for name in folders if name in _SOURCE_ROOTS | {"backend", "deployment"}]
        elif relative_dir == Path("backend"):
            folders[:] = [name for name in folders if name == "app"]
        else:
            folders[:] = [name for name in folders if name not in _EXCLUDED and not name.startswith(".env")]
        for folder in folders:
            managed.ordinary_path(here / folder)
        for name in names:
            path = managed.ordinary_path(here / name)
            relative = path.relative_to(root)
            if relative_dir == Path(".") and name not in _ROOT_FILES:
                continue
            if name.startswith(".env") or name.endswith((".pyc", ".log", ".db", ".sqlite3", ".sqlite", ".tsbuildinfo", ".pem", ".key")):
                continue
            if relative.parts[0] == "backend" and len(relative.parts) == 2 and name not in ("requirements.txt", "requirements.lock.txt"):
                continue
            if not path.is_file() or path.stat().st_nlink != 1:
                raise TransferError("Исходные файлы проекта содержат неподдерживаемую запись")
            yield relative.as_posix(), path


def export_project():
    if not _guard.acquire(blocking=False):
        raise TransferError("Другая передача данных уже выполняется")
    try:
        root = managed.project_root()
        database, uploads = _paths()
        exports = directory() / "exports"
        exports.mkdir(exist_ok=True)
        managed.make_private(exports, directory=True)
        with tempfile.TemporaryDirectory(prefix="creating-", dir=exports) as temporary:
            stage = Path(temporary)
            managed.make_private(stage, directory=True)
            snapshot = stage / "database.sqlite3"
            service = BackupService(database, uploads, stage / "unused-backups", enabled=False)
            references = service._snapshot(snapshot)
            copied, warnings = service._copy_uploads(stage / "uploads", references)
            _normalize_database(snapshot, set(copied), str(uploads))
            values = managed.editable_model().model_dump()
            values.update(DATABASE_URL="sqlite:///./studyhub.db", UPLOAD_DIR="./uploads", BACKUP_DIR=".backups/automatic")
            env = stage / "backend.env"
            env.write_text("\n".join(key + "=" + json.dumps(str(value).lower() if type(value) is bool else str(value), ensure_ascii=False) for key, value in sorted(values.items())) + "\n", encoding="utf-8")
            managed.make_private(env)
            files = {"QStudy/" + name: path for name, path in _source_files(root)}
            files.update({"QStudy/backend/studyhub.db": snapshot, "QStudy/backend/.env": env})
            files.update({"QStudy/backend/uploads/" + name: path for name, path in copied.items()})
            if len(files) > MAX_FILES or sum(path.stat().st_size for path in files.values()) > MAX_EXPANDED:
                raise TransferError("Проект слишком велик для переносимого ZIP")
            created = managed.utc_now()
            manifest = {"application": "QStudy", "format": 2, "kind": "portable-project", "created_at": created.isoformat(),
                        "original_upload_root": str(uploads), "files": {name: {"size": path.stat().st_size, "sha256": _hash(path)} for name, path in files.items()}}
            name = f"qstudy-project-{created:%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}.zip"
            temporary_zip = stage / name
            with zipfile.ZipFile(temporary_zip, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as target:
                for entry, path in files.items():
                    target.write(path, entry)
                target.writestr("QStudy/qstudy-transfer.json", json.dumps(manifest, ensure_ascii=False))
            managed.make_private(temporary_zip)
            if temporary_zip.stat().st_size > settings.MAX_TRANSFER_BYTES:
                raise TransferError("Переносимый ZIP превышает допустимый размер 2 ГБ")
            # Validate the final portable package, without running any source.
            _verify_extract(temporary_zip, stage / "check")
            result = exports / name
            os.replace(temporary_zip, result)
            return result
    except (TransferError, managed.ManagementError):
        raise
    except BackupError as error:
        raise TransferError(str(error)) from error
    except (OSError, ValueError, sqlite3.Error, zipfile.BadZipFile) as error:
        raise TransferError("Не удалось собрать переносимый проект. Проверьте свободное место и доступ к файлам") from error
    finally:
        _guard.release()
