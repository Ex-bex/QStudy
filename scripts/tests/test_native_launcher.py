"""Native startup fixtures: no live accounts, processes, ports or environment files."""
from datetime import datetime, timedelta, timezone
import hashlib
import hmac
import importlib.util
import io
import json
import logging
import os
from pathlib import Path
import sys
import tempfile
import unittest
import asyncio
from unittest.mock import patch
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts/launcher"))
import data
import control
import diagnostics
import supervisor
import backend as native_backend
import docker_migration


class NativeRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="qstudy-native-fixture-")
        self.addCleanup(self.temporary.cleanup)
        # Windows CI exposes TEMP through RUNNER~1. Match the runtime's
        # canonical path rather than asserting an 8.3 alias is the data path.
        self.root = Path(self.temporary.name).resolve()
        for directory in ("backend/app", "deployment", ".local/managed"):
            (self.root / directory).mkdir(parents=True, exist_ok=True)
        (self.root / "backend/app/config.py").write_text("class Settings:\n SECRET_KEY: str\n BFF_PROXY_SECRET: str = ''\n SMTP_PASSWORD: str = ''\n GEMINI_API_KEY: str = ''\n PUBLIC_BASE_URL: str = ''\n ALLOW_PUBLIC_HTTP: bool = False\n DATABASE_URL: str = ''\n UPLOAD_DIR: str = ''\n BACKUP_DIR: str = ''\n CORS_ORIGINS: str = ''\n", encoding="utf-8")
        self.config = {"root": str(self.root), "data_source": "local", "mode": "local", "site_url": "http://127.0.0.1:3000",
                       "backend_port": 8000, "owner_sid": "S-1-5-21-111-222-333-1001", "control_token": "fixture-control-token-" * 3}
        self.settings = self.root / "backend/.env"
        self.original = b"\xef\xbb\xbf# Preserve comments and CRLF\r\nSECRET_KEY=fixture-existing-secret-0123456789abcdef\r\nBFF_PROXY_SECRET=fixture-existing-proxy-0123456789abcdef\r\nSMTP_PASSWORD=fixture-smtp-password\r\nGEMINI_API_KEY=fixture-ai-key\r\n"
        self.settings.write_bytes(self.original)

    def request(self, **changes):
        request = {"version": 1, "id": uuid.uuid4().hex, "action": "restart", "payload": {}, "requested_by": 5,
                   "issued_at": datetime.now(timezone.utc).isoformat()}
        request.update(changes)
        encoded = json.dumps(request, ensure_ascii=True, sort_keys=True, separators=(",", ":")).encode()
        request["signature"] = hmac.new(self.config["control_token"].encode(), encoded, hashlib.sha256).hexdigest()
        return request

    def test_all_modes_pin_the_same_existing_database_and_preserve_settings(self):
        original_database = self.root / "backend/studyhub.db"
        original_database.write_bytes(b"opaque-existing-accounts-never-parsed")
        for mode, url in (("local", "http://127.0.0.1:3000"), ("lan", "http://192.168.1.10:3000"), ("internet", "http://94.125.99.135:8080")):
            with self.subTest(mode=mode):
                config = {**self.config, "mode": mode, "site_url": url}
                environment = data.load_environment(config)
                self.assertEqual(environment["DATABASE_URL"], "sqlite:///" + original_database.as_posix())
                self.assertEqual(environment["PUBLIC_BASE_URL"], url)
                self.assertEqual(environment["QSTUDY_ACCESS_MODE"], mode)
                self.assertEqual(environment["ALLOW_PUBLIC_HTTP"], "true" if mode == "internet" else "false")
                self.assertEqual(environment["SMTP_PASSWORD"], "fixture-smtp-password")
                self.assertEqual(environment["SECRET_KEY"], "fixture-existing-secret-0123456789abcdef")
                self.assertEqual(self.settings.read_bytes(), self.original)
                self.assertEqual(original_database.read_bytes(), b"opaque-existing-accounts-never-parsed")

    def test_legacy_production_dataset_is_used_without_copy_or_new_local_settings(self):
        self.settings.unlink()
        production = self.root / "deployment/.env"
        production.write_bytes(self.original)
        environment = data.load_environment({**self.config, "data_source": "deployment"})
        self.assertEqual(environment["DATABASE_URL"], "sqlite:///" + (self.root / "deployment/data/backend/studyhub.db").as_posix())
        self.assertEqual(environment["QSTUDY_ENV_FILE"], str(production))
        self.assertFalse(self.settings.exists())
        self.assertFalse((self.root / "backend/studyhub.db").exists())
        self.assertEqual(production.read_bytes(), self.original)

    @unittest.skipUnless(os.name == "nt", "Windows 8.3 path aliases")
    def test_windows_short_path_alias_selects_the_same_existing_store(self):
        import ctypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        short_name = kernel.GetShortPathNameW
        short_name.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_ulong]
        short_name.restype = ctypes.c_ulong
        size = short_name(str(self.root), None, 0)
        if not size:
            self.skipTest("No short path is available on the fixture volume")
        buffer = ctypes.create_unicode_buffer(size)
        if not short_name(str(self.root), buffer, size) or buffer.value.casefold() == str(self.root).casefold():
            self.skipTest("8.3 aliases are disabled for the fixture directory")
        database = self.root / "backend/studyhub.db"
        database.write_bytes(b"existing-accounts-through-both-paths")
        environment = data.load_environment({**self.config, "root": buffer.value})
        self.assertEqual(environment["DATABASE_URL"], "sqlite:///" + database.as_posix())
        self.assertEqual(environment["QSTUDY_ENV_FILE"], str(self.settings))
        self.assertEqual(database.read_bytes(), b"existing-accounts-through-both-paths")
        self.assertEqual(self.settings.read_bytes(), self.original)

    def test_environment_file_cannot_inject_node_python_or_arbitrary_shell_settings(self):
        self.settings.write_bytes(self.original + b"NODE_OPTIONS=--inspect=0.0.0.0\r\nPYTHONPATH=attacker\r\nINJECTED_UNKNOWN=not-allowed\r\n")
        with patch.dict(os.environ, {"SMTP_PASSWORD": "stale-parent-password", "NODE_OPTIONS": "--inspect", "PYTHONHOME": "bad-home"}):
            environment = data.load_environment(self.config)
        self.assertEqual(environment["SMTP_PASSWORD"], "fixture-smtp-password")
        self.assertNotIn("NODE_OPTIONS", environment)
        self.assertNotIn("PYTHONPATH", environment)
        self.assertNotIn("PYTHONHOME", environment)
        self.assertNotIn("INJECTED_UNKNOWN", environment)

    def test_frontend_receives_only_the_proxy_secret_and_not_mail_ai_or_control_credentials(self):
        environment = data.load_environment(self.config)
        frontend = supervisor.frontend_environment(environment, self.root, "local")
        for key in ("SECRET_KEY", "SMTP_PASSWORD", "GEMINI_API_KEY", "QSTUDY_CONTROL_TOKEN", "QSTUDY_ENV_FILE"):
            self.assertNotIn(key, frontend)
        self.assertEqual(frontend["BFF_PROXY_SECRET"], environment["BFF_PROXY_SECRET"])
        self.assertEqual(frontend["QSTUDY_ACCESS_MODE"], "local")
        self.assertEqual(frontend["BACKEND_URL"], "http://127.0.0.1:8000")

    def test_missing_proxy_secret_is_added_once_without_rotating_other_values(self):
        before = self.original.replace(b"BFF_PROXY_SECRET=fixture-existing-proxy-0123456789abcdef\r\n", b"BFF_PROXY_SECRET=''\r\n")
        self.settings.write_bytes(before)
        with patch.object(data, "private_file") as protect:
            first = data.load_environment(self.config)
            protect.assert_called_once()
            after = self.settings.read_bytes()
            second = data.load_environment(self.config)
        self.assertGreaterEqual(len(first["BFF_PROXY_SECRET"]), 32)
        self.assertEqual(first["BFF_PROXY_SECRET"], second["BFF_PROXY_SECRET"])
        self.assertEqual(after, self.settings.read_bytes())
        self.assertTrue(after.startswith(b"\xef\xbb\xbf"))
        for line in before.splitlines(keepends=True):
            if not line.startswith(b"BFF_PROXY_SECRET="):
                self.assertIn(line, after)

    def test_invalid_existing_application_secret_is_never_replaced(self):
        invalid = b"SECRET_KEY=short\nSMTP_PASSWORD=fixture-unchanged\n"
        self.settings.write_bytes(invalid)
        with self.assertRaisesRegex(ValueError, "existing_secret_invalid"):
            data.load_environment(self.config)
        self.assertEqual(self.settings.read_bytes(), invalid)

    def test_control_requests_require_signature_recent_timestamp_and_single_use(self):
        request = self.request()
        self.assertTrue(supervisor.valid_request(request, self.config["control_token"], set()))
        self.assertFalse(supervisor.valid_request(request, "wrong-token", set()))
        self.assertFalse(supervisor.valid_request(request, self.config["control_token"], {request["id"]}))
        for modifications in ({"issued_at": (datetime.now(timezone.utc) - timedelta(minutes=5)).isoformat()}, {"payload": {"unexpected": "data"}},
                              {"requested_by": "5"}, {"action": "shell"}, {"id": "../private"}, {"version": 2}):
            with self.subTest(modifications=modifications):
                self.assertFalse(supervisor.valid_request(self.request(**modifications), self.config["control_token"], set()))
        request["action"] = "stop"
        self.assertFalse(supervisor.valid_request(request, self.config["control_token"], set()))

    def test_import_requires_explicit_signed_transfer_identity(self):
        valid = self.request(action="apply-import", payload={"transfer_id": uuid.uuid4().hex, "include_settings": True})
        self.assertTrue(supervisor.valid_request(valid, self.config["control_token"], set()))
        for payload in ({}, {"transfer_id": "../../backup", "include_settings": True}, {"transfer_id": uuid.uuid4().hex, "include_settings": "true"}):
            self.assertFalse(supervisor.valid_request(self.request(action="apply-import", payload=payload), self.config["control_token"], set()))

    def test_local_control_publishes_complete_request_without_overwriting_pending_action(self):
        config_path = self.root / ".local/managed/fixture-config.json"
        config_path.write_text(json.dumps(self.config), encoding="utf-8")
        target = self.root / ".local/managed/request.json"
        publish = os.rename if os.name == "nt" else os.link
        observed = []

        def observe(source, destination):
            observed.append(json.loads(Path(source).read_text()))
            self.assertFalse(target.exists())
            return publish(source, destination)

        with patch.object(control.os, "rename" if os.name == "nt" else "link", observe):
            self.assertEqual(control.main(["--config", str(config_path), "--action", "stop"]), 0)
        request = json.loads(target.read_text())
        self.assertEqual(request, observed[0])
        self.assertTrue(supervisor.valid_request(request, self.config["control_token"], set()))
        original = target.read_bytes()
        with patch("sys.stderr", io.StringIO()):
            self.assertEqual(control.main(["--config", str(config_path), "--action", "restart"]), 2)
        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(list(target.parent.glob(".control-*.tmp")), [])

    def test_safe_startup_diagnostics_never_print_exception_values_or_sql_parameters(self):
        error = PermissionError("FixtureSecretPasswordAndAccount")
        self.assertEqual(diagnostics.error_code(error), "storage_permission_denied")
        record = logging.LogRecord("uvicorn.error", logging.ERROR, "fixture", 1, "failed", (), (type(error), error, None))
        self.assertTrue(diagnostics.SafeStartupLog().filter(record))
        self.assertNotIn("FixtureSecret", record.getMessage())
        self.assertIsNone(record.exc_info)
        record = logging.LogRecord("uvicorn.error", logging.ERROR, "fixture", 1,
                                   "Traceback (most recent call last): FixtureSecret [parameters: (private,)]", (), None)
        diagnostics.SafeStartupLog().filter(record)
        self.assertNotIn("FixtureSecret", record.getMessage())
        self.assertNotIn("parameters", record.getMessage())

    def test_private_stop_files_are_instance_bound_and_never_delete_another_runtime_request(self):
        instance = uuid.uuid4().hex
        other = uuid.uuid4().hex
        other_file = supervisor.stop_files(self.root, other)["backend"]
        other_file.write_text('{"private":"other-instance-request"}', encoding="utf-8")
        children = [unittest.mock.Mock(), unittest.mock.Mock()]
        for child in children:
            child.poll.return_value = None
        supervisor.publish_child_stops(self.root, instance, children)
        for path in supervisor.stop_files(self.root, instance).values():
            self.assertEqual(json.loads(path.read_text()), {"version": 1, "instance": instance, "action": "stop"})
        supervisor.clear_child_stops(self.root, instance)
        self.assertTrue(other_file.exists())
        self.assertTrue(all(not path.exists() for path in supervisor.stop_files(self.root, instance).values()))
        with self.assertRaises((ValueError, AttributeError)):
            supervisor.stop_files(self.root, "../../other")

    def test_private_stop_wait_does_not_depend_on_a_windows_console_signal(self):
        child = unittest.mock.Mock()
        child.poll.return_value = None
        supervisor.stop_child(child, private_stop=True)
        child.wait.assert_called_once_with(timeout=20)
        child.send_signal.assert_not_called()
        child.terminate.assert_not_called()

    def test_backend_gracefully_finishes_when_its_own_private_stop_file_arrives(self):
        instance = uuid.uuid4().hex
        path = supervisor.stop_files(self.root, instance)["backend"]

        class Server:
            should_exit = False
            finished = False

            async def serve(self):
                while not self.should_exit:
                    await asyncio.sleep(0.01)
                self.finished = True

        server = Server()

        async def scenario():
            task = asyncio.create_task(native_backend.serve_with_private_stop(server, path, instance))
            data.atomic_json(path, {"version": 1, "instance": uuid.uuid4().hex, "action": "stop"})
            await asyncio.sleep(0.25)
            self.assertFalse(server.should_exit)
            data.atomic_json(path, {"version": 1, "instance": instance, "action": "stop"})
            await asyncio.wait_for(task, timeout=2)

        asyncio.run(scenario())
        self.assertTrue(server.finished)
        self.assertTrue(path.exists())

    def test_backend_ignores_malformed_or_oversized_stop_requests(self):
        instance = uuid.uuid4().hex
        path = supervisor.stop_files(self.root, instance)["backend"]
        for value in ('invalid json', 'x' * 4097, json.dumps({"version": 1, "instance": instance, "action": "restart"})):
            path.write_text(value)
            self.assertFalse(native_backend.stop_requested(path, instance))

    def test_native_start_does_not_require_or_start_docker_when_desktop_is_absent(self):
        with patch.object(docker_migration, "desktop_running", return_value=False), patch.object(docker_migration, "docker_path") as discover, patch.object(docker_migration, "call") as execute:
            self.assertEqual(docker_migration.stop_old_stack(r"C:\fixture\QStudy"), {"ok": True, "status": "docker_not_running", "stopped": 0})
        discover.assert_not_called()
        execute.assert_not_called()

    def test_legacy_container_proof_requires_exact_project_folder_and_compose_files(self):
        labels = {"com.docker.compose.project": "qstudy", "com.docker.compose.service": "backend",
                  "com.docker.compose.project.working_dir": r"C:\fixture\QStudy\deployment",
                  "com.docker.compose.project.config_files": r"C:\fixture\QStudy\deployment\compose.http.yml"}
        identifier = "abcdef012345"
        self.assertEqual(docker_migration.prove_containers(r"C:\fixture\QStudy", [(identifier, labels)]), [identifier])
        for key, value in (("com.docker.compose.project", "foreign"), ("com.docker.compose.service", "foreign"),
                           ("com.docker.compose.project.working_dir", r"C:\another-copy\deployment"),
                           ("com.docker.compose.project.config_files", r"C:\foreign\compose.yml")):
            with self.subTest(key=key), self.assertRaisesRegex(docker_migration.MigrationError, "legacy_container_not_owned"):
                docker_migration.prove_containers(r"C:\fixture\QStudy", [(identifier, {**labels, key: value})])

    def test_legacy_remote_context_is_never_queried_or_mutated(self):
        replies = ["remote-context", json.dumps("ssh://private-fixture-server")]
        with patch.object(docker_migration, "desktop_running", return_value=True), patch.object(docker_migration, "docker_path", return_value="fixture-docker.exe"), patch.object(docker_migration, "call", side_effect=replies) as execute:
            with self.assertRaisesRegex(docker_migration.MigrationError, "legacy_docker_context_not_local"):
                docker_migration.stop_old_stack(r"C:\fixture\QStudy")
        self.assertEqual(execute.call_count, 2)
        self.assertTrue(all("--host" not in call.args[0] and "stop" not in call.args[0] for call in execute.call_args_list))

    def test_legacy_local_containers_are_all_proved_before_their_single_bounded_stop(self):
        identifier = "abcdef012345"
        labels = {"com.docker.compose.project": "qstudy", "com.docker.compose.service": "backend",
                  "com.docker.compose.project.working_dir": r"C:\fixture\QStudy\deployment",
                  "com.docker.compose.project.config_files": r"C:\fixture\QStudy\deployment\compose.http.yml"}
        replies = ["desktop-linux", json.dumps("npipe:////./pipe/dockerDesktopLinuxEngine"), identifier,
                   json.dumps(labels), identifier, ""]
        with patch.object(docker_migration, "desktop_running", return_value=True), patch.object(docker_migration, "docker_path", return_value="fixture-docker.exe"), patch.object(docker_migration, "call", side_effect=replies) as execute:
            self.assertEqual(docker_migration.stop_old_stack(r"C:\fixture\QStudy")["stopped"], 1)
        commands = execute.call_args_list
        self.assertEqual(len(commands), 6)
        self.assertIn("{{json .Config.Labels}}", commands[3].args[0])
        self.assertEqual(commands[4].args[0][-4:], ["stop", "--time", "45", identifier])
        self.assertTrue(commands[4].kwargs["pinned"])
        self.assertEqual(commands[4].kwargs["timeout"], 100)
        self.assertTrue(all(".Config.Env" not in " ".join(call.args[0]) and "rm" not in call.args[0] for call in commands))
        replies = ["desktop-linux", json.dumps("npipe:////./pipe/dockerDesktopLinuxEngine"), identifier,
                   json.dumps({**labels, "com.docker.compose.project.working_dir": r"C:\another-copy\deployment"})]
        with patch.object(docker_migration, "desktop_running", return_value=True), patch.object(docker_migration, "docker_path", return_value="fixture-docker.exe"), patch.object(docker_migration, "call", side_effect=replies) as execute:
            with self.assertRaises(docker_migration.MigrationError):
                docker_migration.stop_old_stack(r"C:\fixture\QStudy")
        self.assertTrue(all("stop" not in call.args[0] for call in execute.call_args_list))


if __name__ == "__main__":
    unittest.main()
