"""Container entry point and operational commands with redacted configuration errors."""
import argparse
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("serve", "backup", "verify", "restore", "mail-check", "mail-check-if-enabled"))
    parser.add_argument("archive", nargs="?")
    parser.add_argument("--stopped", action="store_true", help="Restore only after Manage-QStudy.sh has stopped all services")
    arguments = parser.parse_args()
    try:
        if arguments.command == "serve":
            import uvicorn
            from app.main import app
            # A single process owns the SQLite-backed queue and scheduled backups.
            uvicorn.run(app, host="0.0.0.0", port=8000, access_log=False, proxy_headers=False)
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
    except Exception as error:
        print("QStudy production command failed (" + type(error).__name__ + "). Check configuration, backup validity and private file permissions. Credentials were not printed.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
