"""SMTP diagnostics never read real configuration, connect, or send messages."""
import importlib.util
import io
import json
import smtplib
import ssl
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, call, patch


_spec = importlib.util.spec_from_file_location(
    "qstudy_mail_check", Path(__file__).resolve().parents[2] / "scripts" / "check_mail.py"
)
checker = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(checker)


class MailCheckTests(unittest.TestCase):
    def setUp(self):
        self.config = SimpleNamespace(
            SMTP_HOST="smtp.fixture.example", SMTP_PORT=587, SMTP_SECURITY="starttls",
            SMTP_USERNAME="private-fixture-user", SMTP_PASSWORD="private-fixture-password",
            SMTP_FROM="QStudy <private-fixture-sender@fixture.example>"
        )
        self.mode = Mock(return_value="smtp")
        self.sender = Mock()
        self.smtp_patch = patch.object(checker.smtplib, "SMTP")
        self.ssl_patch = patch.object(checker.smtplib, "SMTP_SSL")
        self.smtp = self.smtp_patch.start()
        self.smtp_ssl = self.ssl_patch.start()
        self.addCleanup(self.smtp_patch.stop)
        self.addCleanup(self.ssl_patch.stop)
        for constructor in (self.smtp, self.smtp_ssl):
            server = constructor.return_value.__enter__.return_value
            server.ehlo.return_value = (250, b"PRIVATE_EHLO_PROVIDER_REPLY")
            server.starttls.return_value = (220, b"PRIVATE_TLS_PROVIDER_REPLY")
            server.login.return_value = (235, b"PRIVATE_AUTH_PROVIDER_REPLY")

    def check(self):
        return checker.check_mail(self.config, self.mode, self.sender)

    def assert_no_mail(self, server):
        for method in ("sendmail", "send_message", "mail", "rcpt", "data"):
            getattr(server, method).assert_not_called()

    def assert_private(self, report):
        serialized = json.dumps(report)
        for value in (self.config.SMTP_HOST, self.config.SMTP_USERNAME,
                      self.config.SMTP_PASSWORD, self.config.SMTP_FROM,
                      "PRIVATE_", "https://private.invalid/reset-password#token=private"):
            if value:
                self.assertNotIn(value, serialized)

    def test_starttls_verifies_certificates_and_authenticates_only_after_tls(self):
        result = self.check()
        self.assertEqual(result, {"ok": True, "stage": "complete", "connect": True,
                                 "tls": True, "auth": "authenticated", "smtp_code": 235})
        server = self.smtp.return_value.__enter__.return_value
        context = server.starttls.call_args.kwargs["context"]
        self.assertTrue(context.check_hostname)
        self.assertEqual(context.verify_mode, ssl.CERT_REQUIRED)
        self.assertEqual(server.method_calls,
            [call.ehlo(), call.starttls(context=context), call.ehlo(),
             call.login(self.config.SMTP_USERNAME, self.config.SMTP_PASSWORD)])
        self.smtp.assert_called_once_with(self.config.SMTP_HOST, 587, timeout=15)
        self.smtp_ssl.assert_not_called()
        self.mode.assert_called_once_with()
        self.sender.assert_called_once_with(self.config.SMTP_FROM)
        self.assert_no_mail(server)
        self.assert_private(result)

    def test_ssl_uses_verified_context_and_does_not_issue_starttls(self):
        self.config.SMTP_SECURITY = "ssl"
        self.config.SMTP_PORT = 465
        result = self.check()
        self.assertTrue(result["ok"])
        options = self.smtp_ssl.call_args.kwargs
        self.assertEqual(options["timeout"], 15)
        self.assertTrue(options["context"].check_hostname)
        self.assertEqual(options["context"].verify_mode, ssl.CERT_REQUIRED)
        server = self.smtp_ssl.return_value.__enter__.return_value
        server.starttls.assert_not_called()
        self.smtp.assert_not_called()
        self.assert_no_mail(server)
        self.assert_private(result)

    def test_relay_without_authentication_keeps_tls_and_skips_login(self):
        self.config.SMTP_USERNAME = self.config.SMTP_PASSWORD = ""
        result = self.check()
        self.assertTrue(result["ok"])
        self.assertTrue(result["tls"])
        self.assertEqual(result["auth"], "not_configured")
        self.assertNotIn("smtp_code", result)
        server = self.smtp.return_value.__enter__.return_value
        server.login.assert_not_called()
        self.assert_no_mail(server)

    def test_invalid_sender_is_rejected_before_opening_transport(self):
        self.sender.side_effect = ValueError(self.config.SMTP_FROM)
        result = self.check()
        self.assertEqual(result["stage"], "config")
        self.assertEqual(result["error"], "ValueError")
        self.assertFalse(result["ok"])
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()
        self.assert_private(result)

    def test_effective_recovery_mode_must_use_smtp(self):
        for mode in ("local", "disabled", "auto"):
            with self.subTest(mode=mode):
                self.mode.return_value = mode
                result = self.check()
                self.assertEqual(result["stage"], "config")
                self.assertEqual(result["error"], "ValueError")
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_gmail_requires_both_credentials_and_no_partial_auth_config_is_accepted(self):
        for host in ("SMTP.GMAIL.COM.", "smtp.googlemail.com", "smtp.fixture.example"):
            for username, password in (("", "private"), ("private", "")):
                with self.subTest(host=host, credentials_present=(bool(username), bool(password))):
                    self.config.SMTP_HOST = host
                    self.config.SMTP_USERNAME, self.config.SMTP_PASSWORD = username, password
                    result = self.check()
                    self.assertEqual(result["stage"], "config")
                    self.assertFalse(result["ok"])
                    self.assert_private(result)
        self.config.SMTP_HOST = "smtp.gmail.com"
        self.config.SMTP_USERNAME = self.config.SMTP_PASSWORD = ""
        self.assertFalse(self.check()["ok"])
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_certificate_failure_never_attempts_login_and_stays_private(self):
        server = self.smtp.return_value.__enter__.return_value
        server.starttls.side_effect = ssl.SSLCertVerificationError(self.config.SMTP_HOST)
        result = self.check()
        self.assertFalse(result["ok"])
        self.assertTrue(result["connect"])
        self.assertFalse(result["tls"])
        self.assertEqual(result["stage"], "tls")
        self.assertEqual(result["error"], "SSLCertVerificationError")
        server.login.assert_not_called()
        self.assert_no_mail(server)
        self.assert_private(result)

    def test_authentication_failure_exposes_only_numeric_code_and_class(self):
        server = self.smtp.return_value.__enter__.return_value
        server.login.side_effect = smtplib.SMTPAuthenticationError(
            535, (self.config.SMTP_PASSWORD + " PRIVATE_ https://private.invalid/reset-password#token=private").encode()
        )
        result = self.check()
        self.assertFalse(result["ok"])
        self.assertTrue(result["tls"])
        self.assertEqual(result["stage"], "auth")
        self.assertEqual(result["error"], "SMTPAuthenticationError")
        self.assertEqual(result["smtp_code"], 535)
        self.assertEqual(result["auth"], "failed")
        self.assert_no_mail(server)
        self.assert_private(result)

    def test_ehlo_rejection_does_not_upgrade_or_authenticate(self):
        server = self.smtp.return_value.__enter__.return_value
        server.ehlo.return_value = (501, b"PRIVATE_EHLO_REJECTION")
        result = self.check()
        self.assertEqual(result["smtp_code"], 501)
        self.assertEqual(result["stage"], "connect")
        self.assertFalse(result["ok"])
        server.starttls.assert_not_called()
        server.login.assert_not_called()
        self.assert_private(result)

    def test_connection_failure_returns_safe_stage_without_traceback(self):
        self.smtp.side_effect = TimeoutError(self.config.SMTP_PASSWORD)
        result = self.check()
        self.assertFalse(result["connect"])
        self.assertFalse(result["tls"])
        self.assertEqual(result["stage"], "connect")
        self.assertEqual(result["error"], "TimeoutError")
        self.assert_private(result)

    def test_main_success_emits_one_safe_json_report_and_zero_exit_status(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(checker, "_load_runtime", return_value=(self.config, self.mode, self.sender)), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            code = checker.main([])
        self.assertEqual(code, 0)
        self.assertEqual(stderr.getvalue(), "")
        result = json.loads(stdout.getvalue())
        self.assertTrue(result["ok"])
        self.assert_private(result)

    def test_config_load_failure_is_redacted_and_returns_nonzero(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(checker, "_load_runtime", side_effect=ValueError(self.config.SMTP_PASSWORD)), \
                redirect_stdout(stdout), redirect_stderr(stderr):
            code = checker.main([])
        self.assertEqual(code, 1)
        self.assertEqual(stderr.getvalue(), "")
        result = json.loads(stdout.getvalue())
        self.assertEqual(result["stage"], "config")
        self.assertEqual(result["error"], "ValueError")
        self.assert_private(result)
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()

    def test_bad_cli_argument_is_not_echoed_and_never_loads_config(self):
        stdout, stderr = io.StringIO(), io.StringIO()
        with patch.object(checker, "_load_runtime") as loader, redirect_stdout(stdout), redirect_stderr(stderr):
            code = checker.main(["--not-supported", self.config.SMTP_PASSWORD])
        self.assertEqual(code, 1)
        self.assertEqual(stderr.getvalue(), "")
        self.assert_private(json.loads(stdout.getvalue()))
        loader.assert_not_called()
        self.smtp.assert_not_called()
        self.smtp_ssl.assert_not_called()


if __name__ == "__main__":
    unittest.main()
