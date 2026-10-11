"""Reject private runtime files accidentally added to the Git index."""
from pathlib import PurePosixPath
import subprocess
import sys


def private_path(filename: str) -> bool:
    path = PurePosixPath(filename)
    name = path.name.lower()
    parts = tuple(part.lower() for part in path.parts)
    environment = (name == ".env" or name.startswith(".env.")) and not name.endswith(".example")
    database = any(name.endswith(suffix) for suffix in (
        ".db", ".db-wal", ".db-shm", ".db-journal", ".sqlite", ".sqlite3",
        ".sqlite-wal", ".sqlite-shm", ".sqlite-journal", ".sqlite3-wal", ".sqlite3-shm", ".sqlite3-journal",
    ))
    storage = any(part in {".local", ".backups", "local-documents", "uploads", ".venv", "venv", "node_modules", ".next"}
                  or part.startswith("backup-") or part.startswith(".restore-") for part in parts)
    production_data = len(parts) >= 2 and parts[:2] == ("deployment", "data")
    private_key = name.endswith((".pem", ".key"))
    return environment or database or storage or production_data or private_key or name == ".qstudy-admin-initial.txt"


def main() -> int:
    result = subprocess.run(["git", "ls-files", "-z"], check=True, capture_output=True)
    files = [item.decode("utf-8") for item in result.stdout.split(b"\0") if item]
    denied = [item for item in files if private_path(item)]
    if denied:
        print("Private runtime paths are tracked; remove them from the index:", file=sys.stderr)
        for item in denied:
            print(item, file=sys.stderr)
        return 1
    print(f"Repository file check passed ({len(files)} tracked files).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
