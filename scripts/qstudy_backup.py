"""Restore/verify entry point used by the stopped-server PowerShell wrapper."""
import argparse
import json
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser(description="Verify or restore a QStudy data backup")
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--archive", required=True)
    parser.add_argument("--verify-only", action="store_true")
    parser.add_argument("--stopped", action="store_true", help="Set only by Restore-QStudy.ps1 after checking owned processes")
    args = parser.parse_args()
    root = Path(args.project_root).resolve()
    sys.path.insert(0, str(root / "backend"))
    from app.services.backups import BackupError, get_backup_service, restore_backup, verify_backup
    try:
        archive = Path(args.archive).resolve()
        if args.verify_only:
            result = verify_backup(archive)
            print(json.dumps({"status": "verified", "created_at": result["created_at"], "upload_count": result["upload_count"]}))
        else:
            if not args.stopped:
                raise BackupError("Используйте Restore-QStudy.cmd: восстановление требует остановленного сайта")
            service = get_backup_service()
            result = restore_backup(archive, service.database, service.uploads, service.directory)
            print(json.dumps(result))
    except (BackupError, OSError, ValueError) as error:
        print("Восстановление не выполнено: " + (str(error) if isinstance(error, BackupError) else "Проверьте файл архива, права доступа и свободное место"), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
