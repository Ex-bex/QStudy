"""Production initialization protects secrets and refuses unsafe origins/storage."""
import contextlib
import importlib.util
import io
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("production_configuration", ROOT / "scripts" / "production" / "configure.py")
configuration = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(configuration)


class ProductionConfigurationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name) / "deployment"
        self.base.mkdir()
        shutil.copyfile(ROOT / "deployment" / ".env.example", self.base / ".env.example")

    def initialize(self):
        return configuration.initialize(self.base, "qstudy.my-campus.org", "owner@my-campus.org")

    def replace(self, key, value):
        path = self.base / ".env"
        text = path.read_text(encoding="utf-8")
        import re
        text = re.sub(r"^" + re.escape(key) + r"=.*$", lambda _: key + "='" + value + "'", text, flags=re.MULTILINE)
        path.write_text(text, encoding="utf-8")

    def test_initialization_generates_distinct_secrets_without_printing_them(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = self.initialize()
        values = configuration.read_environment(self.base / ".env")
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(result["status"], "created")
        self.assertEqual(len(values["SECRET_KEY"]), 64)
        self.assertEqual(len(values["BFF_PROXY_SECRET"]), 64)
        self.assertNotEqual(values["SECRET_KEY"], values["BFF_PROXY_SECRET"])
        self.assertEqual(configuration.check(self.base, offline=True)["public_url"], "https://qstudy.my-campus.org")

    def test_reinitialization_preserves_passwords_keys_and_domain(self):
        self.initialize()
        self.replace("SMTP_PASSWORD", "PrivateValueWith$Literal")
        before = (self.base / ".env").read_bytes()
        self.assertEqual(self.initialize()["status"], "preserved")
        self.assertEqual((self.base / ".env").read_bytes(), before)
        with self.assertRaises(configuration.ConfigurationError):
            configuration.initialize(self.base, "another.my-campus.org", "owner@my-campus.org")
        self.assertEqual((self.base / ".env").read_bytes(), before)

    def test_configuration_requires_matching_https_origin(self):
        self.initialize()
        self.replace("PUBLIC_BASE_URL", "https://other.my-campus.org")
        with self.assertRaises(configuration.ConfigurationError):
            configuration.check(self.base, offline=True)

    def test_recovery_requires_complete_smtp_and_never_uses_local_outbox(self):
        self.initialize()
        self.replace("RECOVERY_DELIVERY", "local")
        with self.assertRaises(configuration.ConfigurationError):
            configuration.check(self.base, offline=True)
        self.replace("RECOVERY_DELIVERY", "smtp")
        with self.assertRaises(configuration.ConfigurationError):
            configuration.check(self.base, offline=True)
        for key in ("SMTP_HOST", "SMTP_USERNAME", "SMTP_PASSWORD", "SMTP_FROM"):
            self.replace(key, "test-value")
        self.assertTrue(configuration.check(self.base, offline=True)["mail_enabled"])

    def test_domain_rejects_url_ip_and_path_injection(self):
        for value in ("https://campus.org", "127.0.0.1", "example.org/path", "../escape", "campus.org:443", "localhost", "campus.org\nmalicious"):
            with self.subTest(value=value), self.assertRaises(configuration.ConfigurationError):
                configuration.normalized_domain(value)

    def test_duplicate_environment_values_are_rejected(self):
        self.initialize()
        with (self.base / ".env").open("a", encoding="utf-8") as target:
            target.write("SECRET_KEY='different-private-value'\n")
        with self.assertRaises(configuration.ConfigurationError):
            configuration.check(self.base, offline=True)

    def test_single_quoted_dollar_is_literal_but_compose_interpolation_is_rejected(self):
        self.initialize()
        self.replace("SMTP_PASSWORD", "Literal$Dollar${not_an_environment_variable}")
        self.assertEqual(configuration.read_environment(self.base / ".env")["SMTP_PASSWORD"], "Literal$Dollar${not_an_environment_variable}")
        for line in ('SMTP_PASSWORD="Literal$Dollar"', 'SMTP_PASSWORD=Literal$Dollar'):
            with self.subTest(line=line):
                path = self.base / ".env"
                path.write_text(line + "\n", encoding="utf-8")
                with self.assertRaises(configuration.ConfigurationError):
                    configuration.read_environment(path)

    def test_ambiguous_quotes_and_double_quoted_escapes_are_rejected(self):
        for line in ("SMTP_PASSWORD='can't-parse-this'", r'SMTP_PASSWORD="escaped\nvalue"', r'SMTP_PASSWORD="escaped\"quote"', r'SMTP_PASSWORD="escaped\\slash"', "SMTP_PASSWORD='final\\'"):
            with self.subTest(line=line):
                path = self.base / ".env"
                path.write_text(line + "\n", encoding="utf-8")
                with self.assertRaises(configuration.ConfigurationError):
                    configuration.read_environment(path)

    def test_dns_rejects_private_and_mixed_addresses(self):
        self.initialize()
        with patch.object(configuration.socket, "getaddrinfo", return_value=[(2, 1, 6, "", ("127.0.0.1", 443))]):
            with self.assertRaises(configuration.ConfigurationError):
                configuration.check(self.base)

    def test_storage_cannot_escape_deployment_directory(self):
        with self.assertRaises(configuration.ConfigurationError):
            configuration.safe_path(self.base, "../outside")
        outside = Path(self.temporary.name) / "outside"
        outside.mkdir()
        try:
            (self.base / "linked").symlink_to(outside, target_is_directory=True)
        except OSError:
            self.skipTest("Creating test links needs Windows developer mode")
        with self.assertRaises(configuration.ConfigurationError):
            configuration.safe_path(self.base, "linked/private")

    def test_main_redacts_unexpected_exception_text(self):
        output = io.StringIO()
        with patch.object(configuration.sys, "argv", ["configure.py", "check", "--offline"]), patch.object(configuration, "deployment_directory", return_value=self.base), patch.object(configuration, "check", side_effect=OSError("PRIVATE_VALUE_MUST_NOT_APPEAR")), contextlib.redirect_stderr(output):
            self.assertEqual(configuration.main(), 1)
        self.assertNotIn("PRIVATE_VALUE_MUST_NOT_APPEAR", output.getvalue())
        self.assertIn("OSError", output.getvalue())


if __name__ == "__main__":
    unittest.main()
