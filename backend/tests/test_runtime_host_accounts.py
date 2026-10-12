"""Host bootstrap checks use disposable SQLite files and never load a working dotenv."""
import importlib.util
import io
import json
import os
from contextlib import redirect_stderr, redirect_stdout
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from unittest.mock import patch

from pydantic_settings import BaseSettings
from sqlalchemy import create_engine, text


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("runtime_host_account_tests", ROOT / "scripts" / "production" / "runtime.py")
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

# Auth/model imports use test settings even if this file runs by itself. Never
# construct application settings with the backend's configured dotenv path.
_settings_init = BaseSettings.__init__


def _isolated_settings_init(settings, *args, **kwargs):
    kwargs["_env_file"] = None
    return _settings_init(settings, *args, **kwargs)


with patch.dict(os.environ, {"SECRET_KEY": "FixtureHostAccountSecret012345678901234567890"}, clear=True), \
        patch.object(BaseSettings, "__init__", _isolated_settings_init):
    from app.auth import verify_password
    from app.database import Base
    from app.models import User


class RuntimeHostAccountTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name).resolve() / "accounts.sqlite3"
        self.engine = create_engine("sqlite:///" + str(self.path), connect_args={"timeout": 30})
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        self.password = "FixtureOnlyPassword1459"
        self.hashed = "fixture-existing-hash-do-not-replace"

    def add_account(self, email="private-user@example.org", role="student", active=True):
        with self.engine.begin() as connection:
            result = connection.execute(User.__table__.insert().values(email=email, name="Private existing name",
                                        hashed_password=self.hashed, role=role, is_active=active, token_version=17))
            return result.inserted_primary_key[0]

    def accounts(self):
        with self.engine.connect() as connection:
            return [dict(row) for row in connection.execute(text("SELECT * FROM users ORDER BY id")).mappings()]

    def run_cli(self, arguments, passwords=None):
        output, errors = io.StringIO(), io.StringIO()
        with patch.object(runtime, "_account_engine", return_value=self.engine), \
                patch.object(runtime, "getpass", side_effect=passwords or AssertionError("Password prompt was unexpected")) as prompt, \
                redirect_stdout(output), redirect_stderr(errors):
            code = runtime.main(arguments)
        return code, output.getvalue(), errors.getvalue(), prompt

    def test_status_is_read_only_and_reports_only_counts_and_admin_presence(self):
        self.add_account(role="admin", active=False)
        self.add_account("disabled-student@example.org", active=False)
        before = self.path.read_bytes()
        real_connect = sqlite3.connect
        with patch.object(runtime.sqlite3, "connect", wraps=real_connect) as connect:
            self.assertEqual(runtime.account_status(self.engine), {"active_admin_exists": False, "account_count": 2})
        self.assertEqual(self.path.read_bytes(), before)
        self.assertTrue(connect.call_args.args[0].endswith("?mode=ro"))
        self.assertTrue(connect.call_args.kwargs["uri"])
        self.add_account("active-admin@example.org", role="admin")
        code, output, errors, prompt = self.run_cli(["account-status"])
        self.assertEqual(code, 0, errors)
        self.assertEqual(json.loads(output), {"active_admin_exists": True, "account_count": 3})
        self.assertEqual(errors, "")
        prompt.assert_not_called()
        self.assertNotIn("private-user", output)
        self.assertNotIn(self.hashed, output)

    def test_missing_database_status_does_not_create_any_file(self):
        self.engine.dispose()
        self.path.unlink()
        with patch.object(runtime.sqlite3, "connect", side_effect=AssertionError("Do not connect to a missing database")):
            self.assertEqual(runtime.account_status(self.engine), {"active_admin_exists": False, "account_count": 0})
        self.assertFalse(self.path.exists())

    def test_status_on_uninitialized_file_does_not_create_tables(self):
        self.engine.dispose()
        self.path.unlink()
        self.path.touch()
        before = self.path.read_bytes()
        self.assertEqual(runtime.account_status(self.engine), {"active_admin_exists": False, "account_count": 0})
        self.assertEqual(self.path.read_bytes(), before)

    def test_existing_active_admin_is_unchanged_without_prompt_or_input_validation(self):
        self.add_account(role="admin")
        before = self.accounts()
        code, output, errors, prompt = self.run_cli(["first-admin", "not-a-valid-email", "--name", ""])
        self.assertEqual(code, 0, errors)
        self.assertEqual(json.loads(output), {"status": "existing_admin_unchanged", "active_admin_exists": True, "account_count": 1})
        prompt.assert_not_called()
        self.assertEqual(self.accounts(), before)

    def test_new_admin_uses_validators_and_hashing_without_printing_credentials(self):
        self.add_account()
        before = self.accounts()[0]
        code, output, errors, prompt = self.run_cli(["first-admin", "NEW-admin@Example.ORG", "--name", " Новый администратор "],
                                                  [self.password, self.password])
        self.assertEqual(code, 0, errors)
        self.assertEqual(json.loads(output), {"status": "created", "active_admin_exists": True, "account_count": 2})
        self.assertEqual(prompt.call_count, 2)
        people = self.accounts()
        self.assertEqual(people[0], before)
        self.assertEqual(people[1]["email"], "new-admin@example.org")
        self.assertEqual(people[1]["name"], "Новый администратор")
        self.assertEqual(people[1]["role"], "admin")
        self.assertEqual(people[1]["is_active"], 1)
        self.assertEqual(people[1]["token_version"], 0)
        self.assertTrue(verify_password(self.password, people[1]["hashed_password"]))
        self.assertNotEqual(people[1]["hashed_password"], self.password)
        for private in (self.password, people[1]["hashed_password"], people[1]["email"], before["email"], self.hashed):
            self.assertNotIn(private, output + errors)

    def test_repeat_launch_never_requests_or_resets_admin_password(self):
        with patch.object(runtime, "getpass", side_effect=[self.password, self.password]):
            runtime.first_admin("first@example.org", engine=self.engine)
        before = self.accounts()
        with patch.object(runtime, "getpass", side_effect=AssertionError("Never prompt on a repeat launch")):
            self.assertEqual(runtime.first_admin("other@example.org", engine=self.engine)["status"], "existing_admin_unchanged")
        self.assertEqual(self.accounts(), before)

    def test_existing_email_cannot_promote_reactivate_reset_or_revoke_sessions(self):
        for role, active in (("student", True), ("student", False), ("admin", False)):
            with self.subTest(role=role, active=active):
                with self.engine.begin() as connection:
                    connection.execute(User.__table__.delete())
                self.add_account("Taken-Private@example.org", role=role, active=active)
                before = self.accounts()
                code, output, errors, prompt = self.run_cli(["first-admin", "TAKEN-private@EXAMPLE.org"])
                self.assertEqual(code, 1)
                self.assertEqual(output, "")
                self.assertIn("unused email", errors)
                self.assertNotIn("Taken-Private", errors)
                self.assertNotIn(self.hashed, errors)
                prompt.assert_not_called()
                self.assertEqual(self.accounts(), before)

    def test_first_admin_refuses_unprepared_database_without_creating_it(self):
        self.engine.dispose()
        self.path.unlink()
        code, output, errors, prompt = self.run_cli(["first-admin", "new@example.org"])
        self.assertEqual(code, 1)
        self.assertIn("Run prepare", errors)
        self.assertEqual(output, "")
        prompt.assert_not_called()
        self.assertFalse(self.path.exists())

    def test_bad_password_or_mismatch_preserves_every_account(self):
        self.add_account()
        before = self.accounts()
        for values in (("short1",), (self.password, "OtherFixturePassword2")):
            with self.subTest(values_count=len(values)):
                code, output, errors, _ = self.run_cli(["first-admin", "new@example.org"], values)
                self.assertEqual(code, 1)
                self.assertEqual(output, "")
                self.assertIn("No account was changed", errors)
                self.assertNotIn(self.password, errors)
                self.assertEqual(self.accounts(), before)

    def test_invalid_email_and_name_are_redacted_and_never_prompt(self):
        for arguments in (["first-admin", "private-invalid-email"],
                          ["first-admin", "new@example.org", "--name", ""],
                          ["first-admin", "new@example.org", "--name", "Private\nName"]):
            with self.subTest(argument_count=len(arguments)):
                code, output, errors, prompt = self.run_cli(arguments)
                self.assertEqual(code, 1)
                self.assertEqual(output, "")
                prompt.assert_not_called()
                self.assertNotIn("private-invalid-email", errors)
                self.assertEqual(self.accounts(), [])

    def test_admin_created_during_password_prompt_is_preserved_atomically(self):
        prompt_count = 0

        def password_prompt(_):
            nonlocal prompt_count
            prompt_count += 1
            if prompt_count == 2:
                self.add_account("other-private-admin@example.org", role="admin")
            return self.password

        with patch.object(runtime, "getpass", side_effect=password_prompt):
            result = runtime.first_admin("new@example.org", engine=self.engine)
        self.assertEqual(result, {"status": "existing_admin_unchanged", "active_admin_exists": True, "account_count": 1})
        person = self.accounts()[0]
        self.assertEqual(person["email"], "other-private-admin@example.org")
        self.assertEqual(person["hashed_password"], self.hashed)
        self.assertEqual(person["token_version"], 17)

    def test_email_created_during_password_prompt_is_never_overwritten(self):
        prompt_count = 0

        def password_prompt(_):
            nonlocal prompt_count
            prompt_count += 1
            if prompt_count == 2:
                self.add_account("NEW@example.org")
            return self.password

        with patch.object(runtime, "getpass", side_effect=password_prompt), self.assertRaisesRegex(runtime.HostAccountError, "unused email"):
            runtime.first_admin("new@example.org", engine=self.engine)
        person = self.accounts()[0]
        self.assertEqual(person["email"], "NEW@example.org")
        self.assertEqual(person["role"], "student")
        self.assertEqual(person["hashed_password"], self.hashed)
        self.assertEqual(person["token_version"], 17)

    def test_two_simultaneous_launchers_create_only_one_first_admin(self):
        ready = threading.Barrier(2)

        def password_prompt(prompt):
            if prompt == "Repeat password: ":
                ready.wait(timeout=10)
            return self.password

        with patch.object(runtime, "getpass", side_effect=password_prompt), ThreadPoolExecutor(max_workers=2) as executor:
            launches = [executor.submit(runtime.first_admin, email, engine=self.engine)
                        for email in ("first@example.org", "second@example.org")]
            results = [launch.result(timeout=20) for launch in launches]
        self.assertEqual(sorted(result["status"] for result in results), ["created", "existing_admin_unchanged"])
        self.assertEqual([result["account_count"] for result in results], [1, 1])
        self.assertEqual(len(self.accounts()), 1)
        self.assertTrue(runtime.account_status(self.engine)["active_admin_exists"])

    def test_read_only_status_does_not_follow_engine_into_unprepared_memory_database(self):
        memory_engine = create_engine("sqlite:///:memory:")
        self.addCleanup(memory_engine.dispose)
        with self.assertRaisesRegex(runtime.HostAccountError, "prepared file-backed SQLite"):
            runtime.account_status(memory_engine)


if __name__ == "__main__":
    unittest.main()
