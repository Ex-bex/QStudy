"""Repository checks protect production state and SQLite rollback pages too."""
import importlib.util
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location("repository_guard", Path(__file__).resolve().parents[2] / "scripts" / "check_repository.py")
guard = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(guard)


class RepositoryGuardTests(unittest.TestCase):
    def test_private_runtime_and_secrets_are_denied(self):
        paths = ["backend/.env", "deployment/.env", "frontend/.env.production.local", "private.pem", "server.key",
                 "deployment/data/backups/archive.zip", "deployment/data/backend/file.txt", ".local/state.json",
                 "backend/uploads/document.pdf", "local-documents/source.pdf"]
        for suffix in (".db", ".sqlite", ".sqlite3"):
            paths.extend("backend/fixture" + suffix + extra for extra in ("", "-wal", "-shm", "-journal"))
        for path in paths:
            with self.subTest(path=path):
                self.assertTrue(guard.private_path(path))

    def test_source_and_configuration_examples_remain_trackable(self):
        for path in ("backend/.env.example", "deployment/.env.example", "frontend/.env.production.example",
                     "deployment/compose.yml", "scripts/production/configure.py", "docs/user-guide.md"):
            with self.subTest(path=path):
                self.assertFalse(guard.private_path(path))


if __name__ == "__main__":
    unittest.main()
