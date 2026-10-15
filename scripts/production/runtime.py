"""Container entry point and operational commands with redacted configuration errors."""
import argparse
from contextlib import closing
from getpass import getpass
import json
from pathlib import Path
import sqlite3
import sys


class HostAccountError(ValueError):
    """An actionable host setup failure whose text contains no account values."""


def _account_engine():
    from app.database import engine
    return engine


def _account_database(engine) -> Path:
    # Home hosting uses the application's file-backed SQLite database. Opening
    # a separate read-only connection must never initialize a missing database.
    database = engine.url.database
    if engine.dialect.name != "sqlite" or not database or database == ":memory:" or database.startswith("file:"):
        raise HostAccountError("QStudy: first administrator setup requires the prepared file-backed SQLite database.")
    return Path(database).resolve()


def _read_account_database(path: Path):
    return sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=30)


def _account_summary(connection) -> dict:
    row = connection.execute("""SELECT COUNT(*), COALESCE(MAX(CASE
        WHEN role = 'admin' AND is_active = 1 THEN 1 ELSE 0 END), 0)
        FROM users""").fetchone()
    return {"active_admin_exists": bool(row[1]), "account_count": int(row[0])}


def account_status(engine=None) -> dict:
    engine = engine if engine is not None else _account_engine()
    path = _account_database(engine)
    if not path.exists():
        return {"active_admin_exists": False, "account_count": 0}
    with closing(_read_account_database(path)) as connection:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone() is None:
            return {"active_admin_exists": False, "account_count": 0}
        return _account_summary(connection)


def first_admin(email: str, name: str = "Администратор", engine=None) -> dict:
    engine = engine if engine is not None else _account_engine()
    existing = account_status(engine)
    if existing["active_admin_exists"]:
        return {"status": "existing_admin_unchanged", **existing}
    path = _account_database(engine)
    if not path.is_file():
        raise HostAccountError("QStudy: the production database is not prepared. Run prepare before creating the first administrator.")
    from pydantic import EmailStr, TypeAdapter
    try:
        email = str(TypeAdapter(EmailStr).validate_python(email)).strip().lower()
    except ValueError:
        raise HostAccountError("QStudy: supply a valid email for the first administrator.") from None
    name = name.strip()
    if not 1 <= len(name) <= 120 or any(ord(character) < 32 or ord(character) == 127 for character in name):
        raise HostAccountError("QStudy: the administrator name must contain 1 to 120 characters without control characters.")
    # Reject an existing email before prompting. This operation cannot promote,
    # reactivate, reset the password or revoke sessions of any existing account.
    with closing(_read_account_database(path)) as connection:
        if connection.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'").fetchone() is None:
            raise HostAccountError("QStudy: the production database is not prepared. Run prepare before creating the first administrator.")
        if connection.execute("SELECT 1 FROM users WHERE lower(email) = ? LIMIT 1", (email,)).fetchone() is not None:
            raise HostAccountError("QStudy: that email already belongs to an account. Choose an unused email or manage the existing account explicitly.")
    from app.auth import hash_password, validate_password
    from app.models import User
    try:
        password = validate_password(getpass("First administrator password (10+ chars, letter + digit): "))
        if password != getpass("Repeat password: "):
            raise HostAccountError("QStudy: passwords do not match. No account was changed.")
    except HostAccountError:
        raise
    except ValueError:
        raise HostAccountError("QStudy: the password must contain 10 to 128 characters, a letter and a digit. No account was changed.") from None
    password_hash = hash_password(password)
    del password
    # Do not hold a writer lock while someone types. After the prompt, serialize
    # the final check and insertion so two concurrent launchers cannot each
    # create a first administrator or overwrite an account created meanwhile.
    with engine.connect() as connection:
        connection.exec_driver_sql("BEGIN IMMEDIATE")
        try:
            row = connection.exec_driver_sql("""SELECT COUNT(*), COALESCE(MAX(CASE
                WHEN role = 'admin' AND is_active = 1 THEN 1 ELSE 0 END), 0)
                FROM users""").fetchone()
            summary = {"active_admin_exists": bool(row[1]), "account_count": int(row[0])}
            if summary["active_admin_exists"]:
                connection.rollback()
                return {"status": "existing_admin_unchanged", **summary}
            if connection.exec_driver_sql("SELECT 1 FROM users WHERE lower(email) = ? LIMIT 1", (email,)).fetchone() is not None:
                raise HostAccountError("QStudy: that email already belongs to an account. Choose an unused email or manage the existing account explicitly.")
            connection.execute(User.__table__.insert().values(email=email, name=name, hashed_password=password_hash,
                               role="admin", is_active=True, token_version=0, group_id=None))
            connection.commit()
        except Exception:
            connection.rollback()
            raise
    return {"status": "created", "active_admin_exists": True, "account_count": summary["account_count"] + 1}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("serve", "backup", "verify", "restore", "mail-check", "mail-check-if-enabled", "account-status", "first-admin"))
    parser.add_argument("archive", nargs="?", help="Backup basename, or the email with first-admin")
    parser.add_argument("--name", default="Администратор", help="Display name for first-admin")
    parser.add_argument("--stopped", action="store_true", help="Restore only after Manage-QStudy.sh has stopped all services")
    arguments = parser.parse_args(argv)
    try:
        if arguments.command == "account-status":
            print(json.dumps(account_status()))
            return 0
        if arguments.command == "first-admin":
            if not arguments.archive:
                raise HostAccountError("QStudy: supply an email with first-admin. An existing administrator is never changed.")
            print(json.dumps(first_admin(arguments.archive, arguments.name)))
            return 0
        if arguments.command == "serve":
            import uvicorn
            from app.main import app
            # A single process owns the SQLite-backed queue and scheduled backups.
            uvicorn.run(app, host="0.0.0.0", port=8000, access_log=False, proxy_headers=False, ws_max_size=24 * 1024, ws_max_queue=16)
            return 0
        if arguments.command in ("mail-check", "mail-check-if-enabled"):
            from app.config import settings
            from app.services.password_recovery import _mail_sender, recovery_mode
            from check_mail import check_mail
            if arguments.command == "mail-check-if-enabled" and recovery_mode() != "smtp":
                print(json.dumps({"ok": True, "stage": "disabled", "mail_sent": False}))
                return 0
            report = check_mail(settings, recovery_mode, _mail_sender)
            print(json.dumps(report))
            return 0 if report["ok"] else 1
        if arguments.command == "restore" and not arguments.stopped:
            print("Restore requires stopped services. Use Manage-QStudy.sh restore rather than a direct command in a running backend.", file=sys.stderr)
            return 1
        from app.services.backups import get_backup_service, restore_backup, verify_backup
        service = get_backup_service()
        if arguments.command == "backup":
            result = service.create("production-cli")
            print(json.dumps({"status": "created", "name": result["name"], "upload_count": result["upload_count"]}))
            return 0
        if not arguments.archive or Path(arguments.archive).name != arguments.archive or "\\" in arguments.archive:
            raise ValueError("Supply a backup basename already present in the private backup folder")
        archive = service.archive_path(arguments.archive)
        if arguments.command == "verify":
            verified = verify_backup(archive)
            result = {"status": "verified", "created_at": verified["created_at"], "upload_count": verified["upload_count"]}
        else:
            result = restore_backup(archive, service.database, service.uploads, service.directory)
        print(json.dumps(result))
        return 0
    except HostAccountError as error:
        print(str(error), file=sys.stderr)
        return 1
    except Exception as error:
        print("QStudy production command failed (" + type(error).__name__ + "). Check configuration, backup validity and private file permissions. Credentials were not printed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
