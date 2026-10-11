"""Stdlib-only, conservative preflight for copying QStudy data between computers.

Run while QStudy is stopped. Dry-run is the default; --apply creates a verified
online SQLite backup before changing upload references or project-owned .env paths.
The launcher provides the previous workspace recorded by its local state.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys
import tempfile
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path, PureWindowsPath


class PreflightError(ValueError):
    pass


@contextmanager
def _connect(*args, **kwargs):
    connection = sqlite3.connect(*args, **kwargs)
    try:
        with connection:
            yield connection
    finally:
        connection.close()


def _absolute(value: str) -> bool:
    return Path(value).is_absolute() or PureWindowsPath(value).is_absolute()


def _path_parts(value: str, root: str | Path) -> tuple[str, ...] | None:
    """Compare recorded Windows paths without depending on the execution OS."""
    windows = bool(PureWindowsPath(str(root)).drive or PureWindowsPath(value).drive)
    constructor = PureWindowsPath if windows else Path
    try:
        relative = constructor(value).relative_to(constructor(str(root)))
    except ValueError:
        return None
    if not relative.parts or any(part in (".", "..") for part in relative.parts):
        return None
    return relative.parts


def _current_path_parts(value: str, root: Path) -> tuple[str, ...] | None:
    """Resolve current-machine aliases before checking private-root containment."""
    path = Path(value)
    if not path.is_absolute() or ".." in path.parts:
        return None
    try:
        relative = path.resolve().relative_to(root.resolve())
    except (OSError, ValueError):
        return None
    return relative.parts or None


def _dotenv(text: str) -> dict[str, str]:
    values = {}
    for line in text.splitlines():
        match = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z_0-9]*)\s*=\s*(.*?)\s*$", line)
        if not match:
            continue
        key, value = match.groups()
        if key not in ("DATABASE_URL", "UPLOAD_DIR"):
            continue
        if value.startswith(('"', "'")):
            quote = value[0]
            end = value.rfind(quote)
            suffix = value[end + 1:].strip()
            if end < 1 or suffix and not suffix.startswith("#"):
                raise PreflightError("Unsupported .env quoting; review configuration manually")
            value = value[1:end]
        else:
            value = re.split(r"\s+#", value, maxsplit=1)[0].strip()
        values[key] = value
    return values


def _replace_env(text: str, replacements: dict[str, str]) -> str:
    for key, value in replacements.items():
        pattern = re.compile(r"^(\s*(?:export\s+)?" + re.escape(key) + r"\s*=)[^\r\n]*", re.MULTILINE)
        text, count = pattern.subn(lambda match: match.group(1) + value, text)
        if count != 1:
            raise PreflightError("Configuration has duplicate or missing path keys")
    return text


def _atomic_text(path: Path, text: str) -> None:
    handle, temporary = tempfile.mkstemp(prefix=".qstudy-data-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="") as output:
            output.write(text)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _sqlite_backup(database: Path, destination: Path) -> None:
    if destination.exists():
        raise PreflightError("Backup destination already exists")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with _connect(database.as_uri() + "?mode=ro", uri=True, timeout=30) as source:
        if source.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
            raise PreflightError("SQLite integrity check failed; no data was changed")
        with _connect(destination) as backup:
            source.backup(backup)
            if backup.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise PreflightError("Backup integrity check failed; no data was changed")


def _digest(path: Path) -> str:
    sha = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            sha.update(chunk)
    return sha.hexdigest()


def preflight(project_root: str | Path, previous_project_root: str | Path | None = None,
              apply: bool = False, backup_to: str | Path | None = None) -> dict:
    project = Path(project_root).resolve()
    backend = project / "backend"
    if not backend.is_dir():
        raise PreflightError("Project backend directory was not found")
    location_path = backend / ".qstudy-location.json"
    if previous_project_root is None and location_path.is_file():
        try:
            location = json.loads(location_path.read_text(encoding="utf-8"))
            recorded = location.get("previous_project_root") or location.get("project_root")
            if location.get("version") == 1 and isinstance(recorded, str) and _absolute(recorded):
                previous_project_root = recorded
        except (ValueError, TypeError, AttributeError):
            pass
    env_path = backend / ".env"
    env_text = env_path.read_text(encoding="utf-8-sig") if env_path.is_file() else ""
    values = _dotenv(env_text)
    replacements = {}
    warnings = []
    previous_backend = str(previous_project_root).rstrip("/\\") + "/backend" if previous_project_root else None
    database_url = values.get("DATABASE_URL", "sqlite:///./studyhub.db")
    if not database_url.startswith("sqlite:///") or "?" in database_url:
        raise PreflightError("Portable preflight requires a local SQLite database URL")
    database_value = database_url[len("sqlite:///"):]
    if database_value == ":memory:":
        raise PreflightError("An in-memory database cannot be transferred")
    if _absolute(database_value):
        database = Path(database_value).resolve()
        if not database.is_relative_to(backend):
            prior_parts = _path_parts(database_value, previous_backend) if previous_backend else None
            if prior_parts and len(prior_parts) == 1 and Path(prior_parts[0]).suffix.lower() in (".db", ".sqlite", ".sqlite3"):
                database = backend / prior_parts[0]
                if not database.is_file():
                    raise PreflightError("Copied database is missing; copy the backend database before starting")
                replacements["DATABASE_URL"] = "sqlite:///./" + prior_parts[0]
            elif not database.is_file():
                raise PreflightError("Absolute database path is unavailable; previous workspace could not be verified")
            else:
                warnings.append({"kind": "external_database_configuration"})
    else:
        database = (backend / database_value).resolve()
        if not database.is_relative_to(backend):
            warnings.append({"kind": "external_database_configuration"})
    upload_value = values.get("UPLOAD_DIR", "./uploads")
    uploads = (Path(upload_value) if _absolute(upload_value) else backend / upload_value).resolve()
    if _absolute(upload_value) and not uploads.is_relative_to(backend):
        prior_parts = _path_parts(upload_value, previous_backend) if previous_backend else None
        if prior_parts == ("uploads",):
            uploads = (backend / "uploads").resolve()
            replacements["UPLOAD_DIR"] = "./uploads"
        elif not uploads.is_dir():
            raise PreflightError("Absolute uploads directory is unavailable; previous workspace could not be verified")
        else:
            warnings.append({"kind": "external_upload_configuration"})
    report = {"ok": True, "database_exists": database.is_file(), "backup": None,
              "planned_updates": 0, "updated": 0, "env_repaired": [],
              "missing_files": 0, "unresolved_files": 0, "warnings": warnings,
              "migration_applied": False}
    updates = []
    if database.is_file():
        with _connect(database.as_uri() + "?mode=ro", uri=True, timeout=30) as connection:
            connection.row_factory = sqlite3.Row
            if [tuple(row) for row in connection.execute("PRAGMA quick_check")] != [("ok",)]:
                raise PreflightError("SQLite integrity check failed; no data was changed")
            tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
            for table in ("materials", "syllabus_documents"):
                if table not in tables:
                    continue
                columns = {row[1] for row in connection.execute(f"PRAGMA table_info({table})")}
                if not {"id", "filepath", "size"}.issubset(columns):
                    warnings.append({"kind": "unsupported_upload_schema", "table": table})
                    continue
                hash_column = "source_sha256" if "source_sha256" in columns else "NULL AS source_sha256"
                for row in connection.execute(f"SELECT id, filepath, size, {hash_column} FROM {table}"):
                    value = row["filepath"] or ""
                    relative = None
                    if _absolute(value):
                        parts = _current_path_parts(value, uploads)
                        if parts is None and previous_backend:
                            parts = _path_parts(value, previous_backend + "/uploads")
                        if parts:
                            relative = Path(*parts).as_posix()
                    else:
                        relative = value
                    candidate = (uploads / relative).resolve() if relative else None
                    if relative and not _absolute(value):
                        parts = Path(relative).parts
                        if len(parts) > 1 and parts[0] == uploads.name and candidate and not candidate.exists():
                            relative = Path(*parts[1:]).as_posix()
                            candidate = (uploads / relative).resolve()
                    if not candidate or candidate == uploads or not candidate.is_relative_to(uploads):
                        report["unresolved_files"] += 1
                        warnings.append({"kind": "unverified_upload_path", "table": table, "id": row["id"]})
                        continue
                    if table == "syllabus_documents" and candidate.parent != uploads / "syllabi":
                        report["unresolved_files"] += 1
                        warnings.append({"kind": "invalid_syllabus_path", "table": table, "id": row["id"]})
                        continue
                    if not candidate.is_file():
                        report["missing_files"] += 1
                        warnings.append({"kind": "missing_upload", "table": table, "id": row["id"]})
                        continue
                    if row["size"] is None or candidate.stat().st_size != row["size"]:
                        report["unresolved_files"] += 1
                        warnings.append({"kind": "upload_size_mismatch", "table": table, "id": row["id"]})
                        continue
                    if row["source_sha256"] and _digest(candidate) != row["source_sha256"]:
                        report["unresolved_files"] += 1
                        warnings.append({"kind": "upload_hash_mismatch", "table": table, "id": row["id"]})
                        continue
                    if _absolute(value) or relative != value:
                        updates.append((table, row["id"], value, relative))
    report["planned_updates"] = len(updates)
    # Check .env changes before touching SQLite, preserving credentials verbatim.
    replacement_text = _replace_env(env_text, replacements) if replacements else env_text
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
    backup_directory = project / ".backups" / ("portability-" + stamp)
    if backup_to or apply and (updates or replacements):
        if database.is_file():
            destination = Path(backup_to).resolve() if backup_to else backup_directory / database.name
            _sqlite_backup(database, destination)
            report["backup"] = str(destination)
        elif backup_to:
            raise PreflightError("There is no existing database to back up")
    if apply and (updates or replacements):
        if env_path.is_file() and replacements:
            backup_directory.mkdir(parents=True, exist_ok=True)
            (backup_directory / ".env").write_bytes(env_path.read_bytes())
        if updates:
            with _connect(database, timeout=30) as connection:
                connection.execute("BEGIN IMMEDIATE")
                for table, record_id, old_value, relative in updates:
                    cursor = connection.execute(f"UPDATE {table} SET filepath=? WHERE id=? AND filepath=?",
                                                (relative, record_id, old_value))
                    report["updated"] += cursor.rowcount
                if connection.execute("PRAGMA quick_check").fetchall() != [("ok",)]:
                    raise PreflightError("SQLite integrity check failed; upload changes were rolled back")
        if replacements:
            _atomic_text(env_path, replacement_text)
            report["env_repaired"] = list(replacements)
        report["migration_applied"] = True
    if apply:
        location = {"version": 1, "project_root": str(project)}
        if previous_project_root and (report["missing_files"] or report["unresolved_files"]):
            location["previous_project_root"] = str(previous_project_root)
        _atomic_text(location_path, json.dumps(location, ensure_ascii=True, indent=2) + "\n")
        report["location_recorded"] = True
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project-root", default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument("--previous-project-root")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-to")
    args = parser.parse_args()
    try:
        report = preflight(args.project_root, args.previous_project_root, args.apply, args.backup_to)
    except (PreflightError, OSError, sqlite3.Error) as error:
        # Configuration values and file names must never appear in installer logs.
        message = str(error) if isinstance(error, PreflightError) else "Data preflight failed; check file access and disk space"
        print(json.dumps({"ok": False, "error": message}, ensure_ascii=True))
        return 1
    print(json.dumps(report, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
