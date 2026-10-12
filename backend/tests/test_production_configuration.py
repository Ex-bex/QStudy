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

    def test_http_initialization_needs_only_public_ipv4_and_port(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = configuration.initialize_http(self.base, "8.8.8.8")
        values = configuration.read_environment(self.base / ".env")
        self.assertEqual(result["status"], "created")
        self.assertEqual(output.getvalue(), "")
        self.assertEqual(values["QSTUDY_HOST_MODE"], "http")
        self.assertEqual(values["ALLOW_PUBLIC_HTTP"], "true")
        self.assertEqual(values["PUBLIC_BASE_URL"], "http://8.8.8.8:8080")
        self.assertEqual(values["REGISTRATION_ENABLED"], "false")
        self.assertEqual(len(values["SECRET_KEY"]), 64)
        self.assertNotEqual(values["SECRET_KEY"], values["BFF_PROXY_SECRET"])
        with patch.object(configuration.socket, "getaddrinfo", side_effect=AssertionError("Literal IPv4 requires no DNS lookup")):
            report = configuration.check(self.base)
        self.assertEqual(report["host_mode"], "http")
        self.assertEqual(report["compose_file"], "compose.http.yml")
        self.assertEqual(report["public_port"], 8080)
        self.assertEqual(report["public_ip"], "8.8.8.8")
        self.assertFalse(report["dns_checked"])
        # Placeholders satisfy base Compose interpolation; certificate/domain
        # validation must not require real inputs for the HTTP service.
        self.replace("QSTUDY_DOMAIN", "unused-placeholder")
        self.replace("ACME_EMAIL", "unused-placeholder")
        self.assertEqual(configuration.check(self.base, offline=True)["public_url"], "http://8.8.8.8:8080")

    def test_http_reinitialization_preserves_secrets_and_refuses_host_changes(self):
        configuration.initialize_http(self.base, "8.8.8.8", 8080)
        self.replace("SMTP_PASSWORD", "PRIVATE_VALUE_WITH$LITERAL")
        before = (self.base / ".env").read_bytes()
        self.assertEqual(configuration.initialize_http(self.base, "8.8.8.8", "8080")["status"], "preserved")
        self.assertEqual((self.base / ".env").read_bytes(), before)
        for public_ip, port in (("9.9.9.9", 8080), ("8.8.8.8", 8081)):
            with self.subTest(ip=public_ip, port=port), self.assertRaises(configuration.ConfigurationError):
                configuration.initialize_http(self.base, public_ip, port)
            self.assertEqual((self.base / ".env").read_bytes(), before)
        with self.assertRaises(configuration.ConfigurationError):
            configuration.initialize(self.base, "qstudy.example.org", "owner@example.org")
        self.assertEqual((self.base / ".env").read_bytes(), before)

    def test_http_init_cannot_overwrite_an_existing_https_installation(self):
        self.initialize()
        before = (self.base / ".env").read_bytes()
        with self.assertRaises(configuration.ConfigurationError):
            configuration.initialize_http(self.base, "8.8.8.8", 8080)
        self.assertEqual((self.base / ".env").read_bytes(), before)

    def test_http_rejects_nonpublic_noncanonical_addresses_and_invalid_ports(self):
        for address in ("localhost", "https://8.8.8.8", "8.8.8.8:8080", "8.8.8.8/path", " 8.8.8.8",
                        "008.8.8.8", "10.0.0.1", "127.0.0.1", "100.64.1.1", "192.0.2.1",
                        "169.254.1.1", "192.88.99.2", "198.18.0.1", "224.0.0.1", "255.255.255.255", "2606:4700:4700::1111"):
            with self.subTest(address=address), self.assertRaises(configuration.ConfigurationError):
                configuration.initialize_http(self.base, address, 8080)
        for port in (0, 65536, -1, True, "08080", "8080 ", "+8080", "8e3", "８０８０"):
            with self.subTest(port=port), self.assertRaises(configuration.ConfigurationError):
                configuration.initialize_http(self.base, "8.8.8.8", port)
        self.assertFalse((self.base / ".env").exists())

    def test_http_check_requires_explicit_opt_in_and_exact_origin(self):
        configuration.initialize_http(self.base, "8.8.8.8", 8080)
        original = configuration.read_environment(self.base / ".env")
        invalid = (("ALLOW_PUBLIC_HTTP", "false"), ("QSTUDY_HOST_MODE", "automatic"),
                   ("PUBLIC_BASE_URL", "http://8.8.8.8:8081"), ("PUBLIC_BASE_URL", "http://example.org:8080"),
                   ("PUBLIC_BASE_URL", "http://user:secret@8.8.8.8:8080"), ("PUBLIC_BASE_URL", "http://8.8.8.8:8080/"),
                   ("PUBLIC_BASE_URL", "http://8.8.8.8:8080/path"), ("QSTUDY_PUBLIC_IP", "10.0.0.1"),
                   ("QSTUDY_HTTP_PORT", "65536"), ("QSTUDY_DOMAIN", ""), ("ACME_EMAIL", ""),
                   ("RECOVERY_DELIVERY", "local"))
        for key, value in invalid:
            with self.subTest(key=key, value=value):
                self.replace(key, value)
                with self.assertRaises(configuration.ConfigurationError):
                    configuration.check(self.base, offline=True)
                self.replace(key, original[key])

    def test_https_stays_default_and_cannot_silently_enable_http(self):
        self.initialize()
        report = configuration.check(self.base, offline=True)
        self.assertEqual(report["host_mode"], "https")
        self.assertEqual(report["compose_file"], "compose.yml")
        self.assertEqual(report["public_port"], 443)
        self.replace("ALLOW_PUBLIC_HTTP", "true")
        with self.assertRaises(configuration.ConfigurationError):
            configuration.check(self.base, offline=True)
        # Existing HTTPS files from before host-mode support remain compatible.
        path = self.base / ".env"
        lines = path.read_text(encoding="utf-8").splitlines()
        path.write_text("\n".join(line for line in lines if not line.startswith(("QSTUDY_HOST_MODE=", "ALLOW_PUBLIC_HTTP="))) + "\n", encoding="utf-8")
        self.assertEqual(configuration.check(self.base, offline=True)["host_mode"], "https")

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

    def test_http_probe_checks_ip_port_without_hsts_or_external_access_claim(self):
        configuration.initialize_http(self.base, "8.8.8.8", 80)
        self.assertEqual(configuration.check(self.base, offline=True)["public_url"], "http://8.8.8.8:80")
        opener = MagicMock()
        # HTTP's default port may disappear when a URL is normalized.
        opener.open.side_effect = [self.response("http://8.8.8.8/api/health", hsts=""),
                                   self.response("http://8.8.8.8/", hsts="")]
        with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
            report = configuration.probe(self.base)
        self.assertEqual(report["status"], "public_http_verified")
        self.assertEqual(report["host_mode"], "http")
        self.assertTrue(report["verified_from_this_host"])
        self.assertFalse(report["external_reachability_proven"])
        self.assertEqual(report["public_url"], "http://8.8.8.8:80")

    def test_http_probe_rejects_changed_scheme_ip_or_port(self):
        configuration.initialize_http(self.base, "8.8.8.8", 8080)
        for bad_url in ("http://8.8.8.8/api/health", "http://8.8.8.8:8081/api/health",
                        "http://9.9.9.9:8080/api/health", "https://8.8.8.8:8080/api/health"):
            with self.subTest(url=bad_url):
                opener = MagicMock()
                opener.open.return_value = self.response(bad_url, hsts="")
                with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
                    with self.assertRaises(configuration.ConfigurationError):
                        configuration.probe(self.base)
                self.assertEqual(opener.open.call_count, 1)

    def test_local_http_probe_uses_loopback_with_exact_public_host_including_port_80(self):
        for port in (80, 3000):
            with self.subTest(port=port):
                if (self.base / ".env").exists():
                    (self.base / ".env").unlink()
                configuration.initialize_http(self.base, "94.125.99.135", port)
                public_origin = f"http://94.125.99.135:{port}"
                local_origin = f"http://127.0.0.1:{port}"
                opener = MagicMock()
                # A transport may normalize the default HTTP port in its URL.
                response_origin = "http://127.0.0.1" if port == 80 else local_origin
                health = self.response(response_origin + "/api/health", hsts="")
                opener.open.side_effect = [health, self.response(response_origin + "/", hsts="")]
                with patch.object(configuration.urllib.request, "build_opener", return_value=opener) as factory, patch.object(configuration.socket, "getaddrinfo") as dns:
                    report = configuration.probe(self.base, local=True)
                self.assertEqual(report, {"status": "local_http_verified", "public_url": public_origin,
                                          "host_mode": "http", "verified_locally": True,
                                          "external_reachability_proven": False})
                requests = [call.args[0] for call in opener.open.call_args_list]
                self.assertEqual([request.full_url for request in requests], [local_origin + "/api/health", local_origin + "/"])
                self.assertEqual([request.get_header("Host") for request in requests], [f"94.125.99.135:{port}"] * 2)
                self.assertTrue(all(call.kwargs == {"timeout": 25} for call in opener.open.call_args_list))
                handlers = factory.call_args.args
                self.assertTrue(any(isinstance(handler, urllib.request.ProxyHandler) and handler.proxies == {} for handler in handlers))
                self.assertTrue(any(isinstance(handler, configuration.ProbeRedirectHandler) for handler in handlers))
                health.read.assert_called_once_with(10_000)
                dns.assert_not_called()

    def test_local_http_probe_bypasses_system_proxy_in_real_urllib_processing(self):
        configuration.initialize_http(self.base, "94.125.99.135", 3000)
        builder = urllib.request.build_opener
        requested = []

        class LocalTransport(urllib.request.HTTPHandler):
            def http_open(self, request):
                requested.append((request.full_url, request.get_header("Host"), request.has_proxy()))
                body = b'{"status":"ok","service":"QStudy"}' if request.selector == "/api/health" else b"QStudy"
                response = urllib.response.addinfourl(io.BytesIO(body), Message(), request.full_url, 200)
                response.msg = "OK"
                return response

        def direct_opener(*handlers):
            return builder(*handlers, LocalTransport())

        with patch.dict(configuration.os.environ, {"http_proxy": "http://proxy.invalid:8123", "HTTP_PROXY": "http://proxy.invalid:8123", "no_proxy": "", "NO_PROXY": ""}), patch.object(configuration.urllib.request, "build_opener", side_effect=direct_opener), patch.object(configuration.socket, "create_connection", side_effect=AssertionError("Tests must not open network connections")):
            report = configuration.probe(self.base, local=True)
        self.assertEqual(requested, [("http://127.0.0.1:3000/api/health", "94.125.99.135:3000", False),
                                     ("http://127.0.0.1:3000/", "94.125.99.135:3000", False)])
        self.assertEqual(report["status"], "local_http_verified")

    def test_local_http_probe_requires_http_mode_and_valid_configuration_before_requests(self):
        self.initialize()
        with patch.object(configuration.urllib.request, "build_opener") as factory:
            with self.assertRaises(configuration.ConfigurationError) as raised:
                configuration.probe(self.base, local=True)
            factory.assert_not_called()
        self.assertIn("only", str(raised.exception))
        (self.base / ".env").unlink()
        configuration.initialize_http(self.base, "94.125.99.135", 3000)
        original = configuration.read_environment(self.base / ".env")
        for key, value in (("QSTUDY_HTTP_PORT", "65536"), ("QSTUDY_HTTP_PORT", "03000"),
                           ("PUBLIC_BASE_URL", "http://94.125.99.135:3001"),
                           ("ALLOW_PUBLIC_HTTP", "false"), ("SECRET_KEY", "short"),
                           ("BFF_PROXY_SECRET", original["SECRET_KEY"]), ("RECOVERY_DELIVERY", "local")):
            with self.subTest(key=key, value=value):
                self.replace(key, value)
                with patch.object(configuration.urllib.request, "build_opener") as factory, patch.object(configuration.socket, "getaddrinfo") as dns:
                    with self.assertRaises(configuration.ConfigurationError):
                        configuration.probe(self.base, local=True)
                    factory.assert_not_called()
                    dns.assert_not_called()
                self.replace(key, original[key])

    def test_local_http_probe_checks_response_connection_origin_at_both_stages(self):
        configuration.initialize_http(self.base, "94.125.99.135", 3000)
        local_origin = "http://127.0.0.1:3000"
        for bad_url in ("http://94.125.99.135:3000/", "http://localhost:3000/", "http://127.0.0.1:3001/",
                        "https://127.0.0.1:3000/", "http://PRIVATE_VALUE@127.0.0.1:3000/"):
            for stage in ("health", "homepage"):
                with self.subTest(url=bad_url, stage=stage):
                    opener = MagicMock()
                    opener.open.side_effect = ([self.response(bad_url)] if stage == "health" else
                                               [self.response(local_origin + "/api/health"), self.response(bad_url)])
                    with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
                        with self.assertRaises(configuration.ConfigurationError) as raised:
                            configuration.probe(self.base, local=True)
                    self.assertIn("another origin", str(raised.exception))
                    self.assertNotIn("PRIVATE_VALUE", str(raised.exception))
                    self.assertEqual(opener.open.call_count, 1 if stage == "health" else 2)

    def test_local_http_probe_refuses_redirects_at_both_stages(self):
        configuration.initialize_http(self.base, "94.125.99.135", 3000)
        builder = urllib.request.build_opener
        for stage in ("health", "homepage"):
            for code in (301, 302, 303, 307, 308):
                requested = []

                class RedirectTransport(urllib.request.HTTPHandler):
                    def http_open(self, request):
                        requested.append(request.full_url)
                        headers = Message()
                        redirected = stage == "health" or request.selector == "/"
                        if redirected:
                            headers["Location"] = "http://94.125.99.135:3000/PRIVATE_LOCATION"
                        body = b"" if redirected else b'{"status":"ok","service":"QStudy"}'
                        response = urllib.response.addinfourl(io.BytesIO(body), headers, request.full_url, code if redirected else 200)
                        response.msg = "Redirect" if redirected else "OK"
                        return response

                def direct_opener(*handlers):
                    return builder(*handlers, RedirectTransport())

                with self.subTest(stage=stage, code=code), patch.object(configuration.urllib.request, "build_opener", side_effect=direct_opener), patch.object(configuration.socket, "create_connection", side_effect=AssertionError("Tests must not open network connections")):
                    with self.assertRaises(configuration.ConfigurationError) as raised:
                        configuration.probe(self.base, local=True)
                self.assertEqual(requested, ["http://127.0.0.1:3000/api/health"] + (["http://127.0.0.1:3000/"] if stage == "homepage" else []))
                self.assertNotIn("PRIVATE_LOCATION", str(raised.exception))

    def test_local_http_probe_does_not_require_reachable_public_ip(self):
        configuration.initialize_http(self.base, "94.125.99.135", 3000)
        opener = MagicMock()
        opener.open.side_effect = urllib.error.URLError("Public IP is unavailable from this host")
        with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
            with self.assertRaises(urllib.error.URLError):
                configuration.probe(self.base)
        self.assertEqual(opener.open.call_args.args[0], "http://94.125.99.135:3000/api/health")
        opener.open.side_effect = [self.response("http://127.0.0.1:3000/api/health", hsts=""),
                                   self.response("http://127.0.0.1:3000/", hsts="")]
        with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
            report = configuration.probe(self.base, local=True)
        self.assertTrue(report["verified_locally"])
        self.assertFalse(report["external_reachability_proven"])
        self.assertNotIn("verified_from_this_host", report)

    def test_local_http_probe_requires_qstudy_health_and_successful_homepage(self):
        configuration.initialize_http(self.base, "94.125.99.135", 3000)
        for health_status, health_body, homepage_status in ((200, b'{"status":"ok","service":"Other"}', 200),
                                                          (503, b'{"status":"ok","service":"QStudy"}', 200),
                                                          (200, b'not-json-PRIVATE_RESPONSE', 200),
                                                          (200, b'{"status":"ok","service":"QStudy"}', 503)):
            with self.subTest(health_status=health_status, homepage_status=homepage_status):
                opener = MagicMock()
                opener.open.side_effect = [self.response("http://127.0.0.1:3000/api/health", status=health_status, body=health_body),
                                           self.response("http://127.0.0.1:3000/", status=homepage_status)]
                with patch.object(configuration.urllib.request, "build_opener", return_value=opener):
                    with self.assertRaises(configuration.ConfigurationError) as raised:
                        configuration.probe(self.base, local=True)
                self.assertNotIn("PRIVATE_RESPONSE", str(raised.exception))
                self.assertEqual(opener.open.call_count, 2 if homepage_status == 503 else 1)

    def test_cli_local_http_probe_returns_safe_report(self):
        configuration.initialize_http(self.base, "94.125.99.135", 3000)
        output = io.StringIO()
        opener = MagicMock()
        opener.open.side_effect = [self.response("http://127.0.0.1:3000/api/health", hsts=""),
                                   self.response("http://127.0.0.1:3000/", hsts="")]
        with patch.object(configuration.sys, "argv", ["configure.py", "probe", "--local"]), patch.object(configuration, "deployment_directory", return_value=self.base), patch.object(configuration.urllib.request, "build_opener", return_value=opener), contextlib.redirect_stdout(output):
            self.assertEqual(configuration.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "local_http_verified")
        self.assertNotIn("SECRET_KEY", output.getvalue())
        self.assertNotIn("BFF_PROXY_SECRET", output.getvalue())

    def test_http_probe_refuses_redirect_before_contacting_another_address(self):
        configuration.initialize_http(self.base, "8.8.8.8", 8080)
        requested = []

        class RedirectTransport(urllib.request.HTTPHandler):
            def http_open(self, request):
                requested.append(request.full_url)
                headers = Message()
                headers["Location"] = "http://9.9.9.9:8080/PRIVATE_VALUE"
                response = urllib.response.addinfourl(io.BytesIO(b""), headers, request.full_url, 302)
                response.msg = "Redirect"
                return response

        opener = urllib.request.build_opener(configuration.ProbeRedirectHandler(), RedirectTransport())
        with patch.object(configuration.urllib.request, "build_opener", return_value=opener), patch.object(configuration.socket, "create_connection", side_effect=AssertionError("Tests must not open network connections")):
            with self.assertRaises(configuration.ConfigurationError) as raised:
                configuration.probe(self.base)
        self.assertEqual(requested, ["http://8.8.8.8:8080/api/health"])
        self.assertNotIn("PRIVATE_VALUE", str(raised.exception))

    def test_cli_http_init_does_not_require_a_domain_or_email(self):
        output = io.StringIO()
        with patch.object(configuration.sys, "argv", ["configure.py", "init-http", "8.8.8.8", "8080"]), patch.object(configuration, "deployment_directory", return_value=self.base), contextlib.redirect_stdout(output):
            self.assertEqual(configuration.main(), 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "created")
        self.assertNotIn("SECRET_KEY", output.getvalue())
        self.assertEqual(configuration.check(self.base, offline=True)["public_url"], "http://8.8.8.8:8080")

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
