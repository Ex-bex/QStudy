"""Production initialization protects secrets and refuses unsafe origins/storage."""
import contextlib
import importlib.util
import io
import json
from email.message import Message
from pathlib import Path
import shutil
import tempfile
import unittest
import urllib.error
import urllib.request
import urllib.response
from unittest.mock import MagicMock, patch


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

    @staticmethod
    def response(url, status=200, body=b'{"status":"ok","service":"QStudy"}', hsts="max-age=31536000"):
        response = MagicMock()
        response.__enter__.return_value = response
        response.geturl.return_value = url
        response.status = status
        response.read.return_value = body
        response.headers = {"Strict-Transport-Security": hsts}
        return response

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

    def test_probe_validates_configuration_before_any_network_request(self):
        self.initialize()
        original = configuration.read_environment(self.base / ".env")
        for key, value in (("PUBLIC_BASE_URL", "https://other.my-campus.org"),
                           ("SECRET_KEY", "short"), ("RECOVERY_DELIVERY", "local")):
            with self.subTest(key=key):
                self.replace(key, value)
                with patch.object(configuration.urllib.request, "build_opener") as factory, patch.object(configuration.socket, "getaddrinfo") as dns:
                    with self.assertRaises(configuration.ConfigurationError):
                        configuration.probe(self.base)
                    factory.assert_not_called()
                    dns.assert_not_called()
                self.replace(key, original[key])

    def test_probe_verifies_exact_https_site_without_claiming_external_access(self):
        self.initialize()
        origin = "https://qstudy.my-campus.org"
        opener = MagicMock()
        health = self.response(origin + "/api/health")
        opener.open.side_effect = [health, self.response(origin + "/", hsts="max-age=31536000; includeSubDomains")]
        with patch.object(configuration.urllib.request, "build_opener", return_value=opener), patch.object(configuration.socket, "getaddrinfo") as dns:
            report = configuration.probe(self.base)
        self.assertEqual(report["status"], "public_https_verified")
        self.assertEqual(report["public_url"], origin)
        self.assertTrue(report["verified_from_this_host"])
        self.assertFalse(report["external_reachability_proven"])
        self.assertEqual([call.args[0] for call in opener.open.call_args_list], [origin + "/api/health", origin + "/"])
        self.assertTrue(all(call.kwargs == {"timeout": 25} for call in opener.open.call_args_list))
        health.read.assert_called_once_with(10_000)
        dns.assert_not_called()

    def test_probe_refuses_http_redirects_without_following_the_location(self):
        self.initialize()
        builder = urllib.request.build_opener
        private_marker = "PRIVATE_REDIRECT_VALUE_MUST_NOT_APPEAR"
        for code in (301, 302, 303, 307, 308):
            requested = []

            class RedirectTransport(urllib.request.HTTPSHandler):
                def https_open(self, request):
                    requested.append(request.full_url)
                    headers = Message()
                    headers["Location"] = "https://elsewhere.invalid/" + private_marker
                    response = urllib.response.addinfourl(io.BytesIO(b""), headers, request.full_url, code)
                    response.msg = "Redirect"
                    return response

            # An in-memory HTTPS transport exercises urllib's real redirect
            # processing. Any accidental socket connection is forbidden.
            opener = builder(configuration.ProbeRedirectHandler(), RedirectTransport())
            with self.subTest(status=code), patch.object(configuration.urllib.request, "build_opener", return_value=opener), patch.object(configuration.socket, "create_connection", side_effect=AssertionError("Tests must not open network connections")):
                with self.assertRaises(configuration.ConfigurationError) as raised:
                    configuration.probe(self.base)
            self.assertEqual(requested, ["https://qstudy.my-campus.org/api/health"])
            self.assertIn("refused a redirect", str(raised.exception))
            self.assertNotIn(private_marker, str(raised.exception))

    def test_probe_rejects_responses_from_another_origin_at_both_stages(self):
        self.initialize()
        origin = "https://qstudy.my-campus.org"
        for bad_url in ("https://other.my-campus.org/", "http://qstudy.my-campus.org/",
                        origin + ":444/", origin + ":invalid/", "https://@qstudy.my-campus.org/",
                        "https://user:PRIVATE_VALUE@qstudy.my-campus.org/"):
            for stage in ("health", "homepage"):
                with self.subTest(url=bad_url, stage=stage):
                    opener = MagicMock()
                    opener.open.side_effect = ([self.response(bad_url)] if stage == "health" else
                                               [self.response(origin + "/api/health"), self.response(bad_url)])
                    with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
                        with self.assertRaises(configuration.ConfigurationError) as raised:
                            configuration.probe(self.base)
                    self.assertIn("another origin", str(raised.exception))
                    self.assertNotIn("PRIVATE_VALUE", str(raised.exception))
                    self.assertEqual(opener.open.call_count, 1 if stage == "health" else 2)

    def test_probe_requires_successful_qstudy_health_before_homepage(self):
        self.initialize()
        origin = "https://qstudy.my-campus.org"
        cases = ((200, {"status": "ok", "service": "Other"}),
                 (200, {"status": "error", "service": "QStudy"}),
                 (200, []), (503, {"status": "ok", "service": "QStudy"}),
                 (200, b"not-json-PRIVATE_RESPONSE_MUST_NOT_APPEAR"))
        for status, body in cases:
            with self.subTest(status=status, body=body):
                opener = MagicMock()
                opener.open.return_value = self.response(origin + "/api/health", status=status,
                                                        body=body if isinstance(body, bytes) else json.dumps(body).encode())
                with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
                    with self.assertRaises(configuration.ConfigurationError) as raised:
                        configuration.probe(self.base)
                self.assertEqual(opener.open.call_count, 1)
                self.assertNotIn("PRIVATE_RESPONSE_MUST_NOT_APPEAR", str(raised.exception))

    def test_probe_requires_successful_homepage_and_active_hsts(self):
        self.initialize()
        origin = "https://qstudy.my-campus.org"
        for status, hsts in ((503, "max-age=31536000"), (200, ""), (200, "max-age=0"),
                             (200, "max-age=invalid"), (200, "not-max-age=31536000")):
            with self.subTest(status=status, hsts=hsts):
                opener = MagicMock()
                opener.open.side_effect = [self.response(origin + "/api/health"),
                                           self.response(origin + "/", status=status, hsts=hsts)]
                with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
                    with self.assertRaises(configuration.ConfigurationError):
                        configuration.probe(self.base)

    def test_main_redacts_probe_transport_error_details(self):
        self.initialize()
        output = io.StringIO()
        opener = MagicMock()
        opener.open.side_effect = urllib.error.URLError("PRIVATE_SMTP_PASSWORD_AND_URL_MUST_NOT_APPEAR")
        with patch.object(configuration.sys, "argv", ["configure.py", "probe"]), patch.object(configuration, "deployment_directory", return_value=self.base), patch.object(configuration.urllib.request, "build_opener", return_value=opener), contextlib.redirect_stderr(output):
            self.assertEqual(configuration.main(), 1)
        self.assertNotIn("PRIVATE_SMTP_PASSWORD_AND_URL_MUST_NOT_APPEAR", output.getvalue())
        self.assertIn("URLError", output.getvalue())

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
