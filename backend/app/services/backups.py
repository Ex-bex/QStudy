"""Verified SQLite online backups with private uploads and bounded retention."""
import asyncio
import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import threading
import time
import uuid
import zipfile
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from sqlalchemy.engine import make_url
from app.config import BACKEND_DIR, settings
from app.storage import resolve_upload_path

_NAME = re.compile(r"^qstudy-\d{8}-\d{6}-[a-f0-9]{8}\.zip$")
_scheduler = None
_service = None
_service_key = None


class BackupError(Exception):
    pass


def _now():
    return datetime.now(timezone.utc)


def _iso(value):
    return value.isoformat().replace("+00:00", "Z")


def _digest(path):
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def _verify_backup(archive: Path, *, extract_to: Path | None = None):
    """Verify every entry before a stopped-server restore; never extract blindly."""
    with zipfile.ZipFile(archive) as source:
        manifest = json.loads(source.read("manifest.json"))
        if manifest.get("format") != 1 or manifest.get("application") != "QStudy":
            raise BackupError("Архив не является резервной копией QStudy")
        files = manifest.get("files", {})
        if not isinstance(files, dict) or "database.sqlite3" not in files or len(files) > 100000:
            raise BackupError("Некорректный список файлов резервной копии")
        if set(source.namelist()) != set(files) | {"manifest.json"} or len(source.namelist()) != len(files) + 1:
            raise BackupError("Архив содержит неожиданные или повторяющиеся файлы")
        total = 0
        for name, metadata in files.items():
            parts = Path(name).parts
            if name != "database.sqlite3" and (not name.startswith("uploads/") or "\\" in name or ":" in name or ".." in parts or name.startswith("/")):
                raise BackupError("Путь файла в архиве выходит за пределы данных QStudy")
            info = source.getinfo(name)
            if not isinstance(metadata, dict) or info.file_size != metadata.get("size") or info.file_size < 0:
                raise BackupError("Размер файла резервной копии не совпадает")
            total += info.file_size
            if total > 20 * 1024 ** 3 or stat.S_ISLNK(info.external_attr >> 16):
                raise BackupError("Архив слишком велик или содержит ссылки")
            digest = hashlib.sha256()
            destination = None
            if extract_to is not None:
                target = (extract_to / name).resolve()
                if not target.is_relative_to(extract_to.resolve()):
                    raise BackupError("Недопустимый путь восстановления")
                target.parent.mkdir(parents=True, exist_ok=True)
                destination = target.open("xb")
            try:
                with source.open(name) as item:
                    for chunk in iter(lambda: item.read(1024 * 1024), b""):
                        digest.update(chunk)
                        if destination is not None:
                            destination.write(chunk)
            finally:
                if destination is not None:
                    destination.close()
            if digest.hexdigest() != metadata.get("sha256"):
                raise BackupError("Контрольная сумма резервной копии не совпадает")
        if extract_to is not None:
            with closing(sqlite3.connect(str(extract_to / "database.sqlite3"))) as db:
                if db.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise BackupError("База в резервной копии повреждена")
        return manifest


def verify_backup(archive: Path, *, extract_to: Path | None = None):
    try:
        return _verify_backup(archive, extract_to=extract_to)
    except (zipfile.BadZipFile, KeyError, TypeError, ValueError, OSError, sqlite3.DatabaseError) as error:
        raise BackupError("Не удалось проверить архив. Проверьте резервную копию, доступ и свободное место") from error


class BackupService:
    def __init__(self, database: Path, uploads: Path, directory: Path, *, interval_hours=24, keep=14, enabled=True, audit_callback=None):
        self.database = Path(database).resolve()
        self.uploads = Path(uploads).resolve()
        self.directory = Path(directory).resolve()
        if self.directory == self.uploads or self.directory.is_relative_to(self.uploads) or self.database.is_relative_to(self.uploads):
            raise BackupError("Папка резервных копий и база должны находиться вне папки загрузок")
        self.interval_hours, self.keep, self.enabled = int(interval_hours), max(2, int(keep)), bool(enabled)
        self.audit_callback = audit_callback
        self._guard = threading.Lock()
        self._thread = None
        self._error = ""
        self._last_attempt = None

    def archive_path(self, name):
        if not isinstance(name, str) or not _NAME.fullmatch(name):
            raise BackupError("Резервная копия не найдена")
        path = self.directory / name
        if path.is_symlink() or not path.is_file() or path.resolve().parent != self.directory:
            raise BackupError("Резервная копия не найдена")
        return path

    def archives(self):
        result = []
        if not self.directory.exists():
            return result
        for path in sorted(self.directory.glob("qstudy-*.zip"), reverse=True):
            if not _NAME.fullmatch(path.name) or path.is_symlink():
                continue
            try:
                with zipfile.ZipFile(path) as archive:
                    manifest = json.loads(archive.read("manifest.json"))
                if manifest.get("application") != "QStudy" or manifest.get("format") != 1:
                    continue
                result.append({"name": path.name, "created_at": manifest["created_at"], "reason": manifest["reason"],
                               "size_bytes": path.stat().st_size, "upload_count": manifest["upload_count"],
                               "warnings": manifest.get("warnings", [])})
            except (OSError, ValueError, KeyError, zipfile.BadZipFile):
                continue
        return sorted(result, key=lambda item: item["created_at"], reverse=True)

    def status(self):
        archives = self.archives()
        last = archives[0] if archives else None
        next_due = None
        if last:
            next_due = datetime.fromisoformat(last["created_at"].replace("Z", "+00:00")) + timedelta(hours=self.interval_hours)
        return {"enabled": self.enabled, "running": self._guard.locked(), "interval_hours": self.interval_hours,
                "retention_count": self.keep, "archive_count": len(archives), "last_success": last,
                "next_due_at": _iso(next_due) if next_due else None, "last_error": self._error,
                "last_attempt_at": self._last_attempt, "includes_environment": False}

    def due(self):
        state = self.status()
        if not self.enabled or state["running"]:
            return False
        if self._last_attempt and _now() - datetime.fromisoformat(self._last_attempt.replace("Z", "+00:00")) < timedelta(minutes=10):
            return False
        return not state["next_due_at"] or _now() >= datetime.fromisoformat(state["next_due_at"].replace("Z", "+00:00"))

    def _snapshot(self, destination):
        if not self.database.is_file():
            raise BackupError("База ещё не создана: резервное копирование станет доступно после первого запуска")
        with closing(sqlite3.connect(self.database.as_uri() + "?mode=ro", uri=True, timeout=30)) as source, closing(sqlite3.connect(destination)) as target:
            source.backup(target, pages=256, sleep=0.05)
            if target.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise BackupError("Проверка целостности базы не прошла")
            references = set()
            for (table,) in target.execute("SELECT name FROM sqlite_master WHERE type='table'"):
                quoted = '"' + table.replace('"', '""') + '"'
                columns = {item[1] for item in target.execute(f"PRAGMA table_info({quoted})")}
                if "filepath" in columns:
                    for (value,) in target.execute(f"SELECT filepath FROM {quoted} WHERE filepath IS NOT NULL AND filepath != ''"):
                        try:
                            path = resolve_upload_path(value, self.uploads)
                            references.add(path.relative_to(self.uploads).as_posix())
                        except ValueError as error:
                            raise BackupError("В базе есть файл вне настроенной папки загрузок. Сначала выполните перенос данных") from error
            return references

    def _copy_uploads(self, destination, references):
        files = {}
        warnings = []
        if self.uploads.exists():
            for current, folders, names in os.walk(self.uploads, followlinks=False):
                for folder in list(folders):
                    child = Path(current) / folder
                    if child.is_symlink() or child.is_junction():
                        raise BackupError("Папка загрузок содержит ссылку на внешние файлы")
                for name in names:
                    path = Path(current) / name
                    relative = path.relative_to(self.uploads).as_posix()
                    if path.is_symlink() or not path.resolve().is_relative_to(self.uploads):
                        raise BackupError("Папка загрузок содержит ссылку на внешние файлы")
                    target = destination / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    try:
                        with path.open("rb") as source, target.open("wb") as output:
                            before = os.fstat(source.fileno())
                            if not stat.S_ISREG(before.st_mode):
                                raise BackupError("Папка загрузок содержит нестандартный файл")
                            shutil.copyfileobj(source, output, 1024 * 1024)
                            after = os.fstat(source.fileno())
                        if before.st_size != after.st_size or before.st_mtime_ns != after.st_mtime_ns or target.stat().st_size != before.st_size:
                            raise BackupError("Файл изменился во время копирования. Повторите резервное копирование")
                        files[relative] = target
                    except FileNotFoundError:
                        target.unlink(missing_ok=True)
                        if relative in references:
                            raise BackupError("Связанный файл удалён во время копирования. Повторите резервное копирование")
                        warnings.append("Пропущен удалённый несвязанный файл")
        if references - set(files):
            raise BackupError("Не все файлы, указанные в базе, доступны. Резервная копия не опубликована")
        return files, sorted(set(warnings))

    def _perform(self, reason, actor_id):
        self._last_attempt = _iso(_now())
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(prefix=".creating-", dir=self.directory) as temporary:
                stage = Path(temporary)
                snapshot = stage / "database.sqlite3"
                last_error = None
                for attempt in range(2):
                    try:
                        references = self._snapshot(snapshot)
                        uploads = stage / "uploads"
                        if uploads.exists():
                            shutil.rmtree(uploads)
                        files, warnings = self._copy_uploads(uploads, references)
                        break
                    except BackupError as error:
                        last_error = error
                        snapshot.unlink(missing_ok=True)
                else:
                    raise last_error
                created = _now()
                name = f"qstudy-{created:%Y%m%d-%H%M%S}-{uuid.uuid4().hex[:8]}.zip"
                entries = {"database.sqlite3": snapshot, **{"uploads/" + relative: path for relative, path in files.items()}}
                manifest = {"format": 1, "application": "QStudy", "created_at": _iso(created), "reason": reason,
                            "upload_count": len(files), "warnings": warnings,
                            "files": {entry: {"size": path.stat().st_size, "sha256": _digest(path)} for entry, path in entries.items()}}
                archive = stage / name
                with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED, compresslevel=6) as target:
                    for entry, path in entries.items():
                        target.write(path, entry)
                    target.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False))
                verify_backup(archive)
                os.replace(archive, self.directory / name)
                for old in self.archives()[self.keep:]:
                    try:
                        self.archive_path(old["name"]).unlink()
                    except OSError:
                        pass  # An in-progress download can keep an old Windows file open.
                self._error = ""
                result = next(item for item in self.archives() if item["name"] == name)
                if self.audit_callback:
                    self.audit_callback(actor_id, result, reason)
                return result
        except BackupError as error:
            self._error = str(error)
            raise
        except Exception as error:
            self._error = "Не удалось создать резервную копию. Проверьте свободное место и доступ к файлам"
            raise BackupError(self._error) from error

    def create(self, reason="manual", actor_id=None):
        if not self._guard.acquire(blocking=False):
            raise BackupError("Резервное копирование уже выполняется")
        try:
            return self._perform(reason, actor_id)
        finally:
            self._guard.release()

    def queue(self, reason="manual", actor_id=None):
        if not self._guard.acquire(blocking=False):
            raise BackupError("Резервное копирование уже выполняется")
        def worker():
            try:
                self._perform(reason, actor_id)
            except BackupError:
                pass  # Safe error is exposed by status; no credential or content logging.
            finally:
                self._guard.release()
        self._thread = threading.Thread(target=worker, name="qstudy-backup", daemon=True)
        self._thread.start()
        return {"status": "started"}


def _audit_success(actor_id, archive, reason):
    from app.database import SessionLocal
    from app.services.audit import record_audit
    with SessionLocal() as db:
        record_audit(db, actor_id, "backup.create", "backup", archive["name"], metadata={"source": reason, "count": archive["upload_count"], "size_bytes": archive["size_bytes"]})
        db.commit()


def get_backup_service():
    global _service, _service_key
    url = make_url(settings.DATABASE_URL)
    if url.get_backend_name() != "sqlite" or not url.database or url.database == ":memory:":
        raise BackupError("Резервное копирование поддерживает файловую базу SQLite")
    directory = Path(getattr(settings, "BACKUP_DIR", BACKEND_DIR.parent / ".backups" / "automatic"))
    key = (url.database, settings.UPLOAD_DIR, str(directory), getattr(settings, "BACKUP_INTERVAL_HOURS", 24), getattr(settings, "BACKUP_RETENTION_COUNT", 14), getattr(settings, "BACKUPS_ENABLED", True))
    if _service_key != key:
        _service = BackupService(Path(url.database), Path(settings.UPLOAD_DIR), directory, interval_hours=key[3], keep=key[4], enabled=key[5], audit_callback=_audit_success)
        _service_key = key
    return _service


async def start_backup_scheduler():
    global _scheduler
    service = get_backup_service()
    if service.due():
        service.queue("startup")
    async def loop():
        while True:
            await asyncio.sleep(60)
            if service.due():
                try:
                    service.queue("scheduled")
                except BackupError:
                    pass
    _scheduler = asyncio.create_task(loop())


async def stop_backup_scheduler():
    global _scheduler
    if _scheduler:
        _scheduler.cancel()
        try:
            await _scheduler
        except asyncio.CancelledError:
            pass
        _scheduler = None
    if _service and _service._thread and _service._thread.is_alive():
        await asyncio.to_thread(_service._thread.join, 30)


def create_pre_upgrade_backup():
    """Back up existing data once for each schema-source revision, before migration."""
    service = get_backup_service()
    if not service.enabled or not service.database.is_file() or not service.database.stat().st_size:
        return None
    sha = hashlib.sha256()
    for filename in ("main.py", "models.py", "operational_models.py", "job_models.py"):
        path = BACKEND_DIR / "app" / filename
        if path.exists():
            sha.update(filename.encode())
            sha.update(path.read_bytes())
    fingerprint = sha.hexdigest()
    marker = service.directory / ".upgrade.json"
    try:
        previous = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        previous = {}
    if previous.get("fingerprint") == fingerprint:
        return None
    # Old installations do not have the audit table yet. The verified archive
    # precedes migration; subsequent scheduled/manual backups record their audit.
    temporary_service = BackupService(service.database, service.uploads, service.directory, keep=service.keep, enabled=service.enabled)
    archive = temporary_service.create("upgrade")
    pending = marker.with_suffix(".pending.json")
    pending.write_text(json.dumps({"fingerprint": fingerprint, "archive": archive["name"]}), encoding="utf-8")
    os.replace(pending, marker)
    return archive


def _invalidate_restored_credentials(database):
    with closing(sqlite3.connect(database)) as db:
        db.execute("CREATE TABLE IF NOT EXISTS academic_settings (key VARCHAR(100) PRIMARY KEY, value TEXT NOT NULL DEFAULT '')")
        db.execute("INSERT INTO academic_settings(key,value) VALUES('auth_min_iat',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (str(time.time()),))
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        now = _now().replace(tzinfo=None).isoformat(sep=" ")
        if "password_reset_tokens" in tables:
            db.execute("UPDATE password_reset_tokens SET used_at=? WHERE used_at IS NULL", (now,))
        if "ai_jobs" in tables:
            db.execute("UPDATE ai_jobs SET status='queued', lease_owner=NULL, lease_expires_at=NULL, attempts=0, available_at=?, updated_at=?, error='' WHERE status='running'", (now, now))
        db.commit()


def restore_backup(archive: Path, database: Path, uploads: Path, directory: Path):
    """Called only by Restore-QStudy.ps1 while the launcher lock is held and stopped."""
    service = BackupService(database, uploads, directory, audit_callback=None)
    verify_backup(Path(archive))
    service.directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".restore-", dir=service.directory) as temporary:
        stage = Path(temporary)
        manifest = verify_backup(Path(archive), extract_to=stage)
        _invalidate_restored_credentials(stage / "database.sqlite3")
        # Extract the selected backup before retention can remove an old archive.
        if service.database.exists():
            service.create("pre-restore")
        replacement_db = service.database.with_name(".restore-" + uuid.uuid4().hex + ".db")
        replacement_uploads = service.uploads.with_name(".restore-" + uuid.uuid4().hex)
        retired = service.directory / ("pre-restore-" + uuid.uuid4().hex)
        retired.mkdir()
        old_db = retired / "database.sqlite3"
        old_uploads = retired / "uploads"
        installed_db = installed_uploads = False
        try:
            replacement_uploads.mkdir(parents=True)
            shutil.copy2(stage / "database.sqlite3", replacement_db)
            if (stage / "uploads").exists():
                shutil.copytree(stage / "uploads", replacement_uploads, dirs_exist_ok=True)
            if service.database.exists():
                shutil.move(str(service.database), old_db)
            for suffix in ("-wal", "-shm", "-journal"):
                sidecar = Path(str(service.database) + suffix)
                if sidecar.exists():
                    shutil.move(str(sidecar), retired / sidecar.name)
            if service.uploads.exists():
                shutil.move(str(service.uploads), old_uploads)
            os.replace(replacement_db, service.database)
            installed_db = True
            os.replace(replacement_uploads, service.uploads)
            installed_uploads = True
        except Exception:
            if installed_db:
                service.database.unlink()
            if installed_uploads:
                shutil.move(str(service.uploads), retired / "failed-uploads")
            if old_db.exists():
                shutil.move(str(old_db), service.database)
            for suffix in ("-wal", "-shm", "-journal"):
                sidecar = retired / (service.database.name + suffix)
                if sidecar.exists():
                    shutil.move(str(sidecar), Path(str(service.database) + suffix))
            if old_uploads.exists():
                shutil.move(str(old_uploads), service.uploads)
            raise
        finally:
            # Keep incomplete generated replacements in the private recovery area.
            for path, label in ((replacement_db, "unused-database.sqlite3"), (replacement_uploads, "unused-uploads")):
                if path.exists():
                    try:
                        shutil.move(str(path), retired / label)
                    except OSError:
                        pass
        return {"created_at": manifest["created_at"], "upload_count": manifest["upload_count"], "status": "restored"}
