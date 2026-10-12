"""Public HTTP needs explicit IPv4 opt-in; tests never load a working dotenv."""
import importlib.util
import os
from pathlib import Path
import unittest
from unittest.mock import patch

from pydantic import ValidationError
from pydantic_settings import BaseSettings


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("public_http_configuration_tests", ROOT / "backend" / "app" / "config.py")
configuration = importlib.util.module_from_spec(SPEC)
# The application's singleton must not read backend/.env during this isolated
# import. The real Settings constructor is restored before every validation.
with patch.object(BaseSettings, "__init__", return_value=None):
    SPEC.loader.exec_module(configuration)


class PublicHttpConfigurationTests(unittest.TestCase):
    def setUp(self):
        environment = patch.dict(os.environ, {}, clear=True)
        environment.start()
        self.addCleanup(environment.stop)

    def settings(self, origin, allow=False):
        return configuration.Settings(_env_file=None, SECRET_KEY="FixtureRandomApplicationSecret0123456789012345",
                                      PUBLIC_BASE_URL=origin, ALLOW_PUBLIC_HTTP=allow)

    def test_public_http_requires_explicit_opt_in(self):
        with self.assertRaises(ValidationError):
            configuration.Settings(_env_file=None, SECRET_KEY="FixtureRandomApplicationSecret0123456789012345",
                                   PUBLIC_BASE_URL="http://8.8.8.8:8080")
        self.assertEqual(self.settings("http://8.8.8.8:8080", allow=True).PUBLIC_BASE_URL, "http://8.8.8.8:8080")
        self.assertEqual(self.settings("http://8.8.8.8:80", allow=True).PUBLIC_BASE_URL, "http://8.8.8.8:80")
        self.assertEqual(self.settings("http://8.8.8.8:65535/", allow=True).PUBLIC_BASE_URL, "http://8.8.8.8:65535")

    def test_environment_opt_in_is_validated_without_reading_a_dotenv(self):
        with patch.dict(os.environ, {"ALLOW_PUBLIC_HTTP": "true", "PUBLIC_BASE_URL": "http://8.8.8.8:8080",
                                     "SECRET_KEY": "FixtureRandomApplicationSecret0123456789012345"}):
            settings = configuration.Settings(_env_file=None)
        self.assertTrue(settings.ALLOW_PUBLIC_HTTP)
        self.assertEqual(settings.PUBLIC_BASE_URL, "http://8.8.8.8:8080")

    def test_public_http_opt_in_never_enables_domains_ipv6_or_reserved_addresses(self):
        for origin in ("http://example.org:8080", "http://example.org", "http://[2606:4700:4700::1111]:8080",
                       "http://100.64.1.1:8080", "http://192.0.2.1:8080", "http://198.51.100.1:8080",
                       "http://203.0.113.1:8080", "http://198.18.0.1:8080", "http://224.0.0.1:8080",
                       "http://192.88.99.2:8080", "http://0.0.0.0:8080", "http://255.255.255.255:8080", "http://008.8.8.8:8080"):
            with self.subTest(origin=origin), self.assertRaises(ValidationError):
                self.settings(origin, allow=True)

    def test_public_http_requires_one_canonical_origin_and_explicit_valid_port(self):
        for origin in ("http://8.8.8.8", "http://8.8.8.8:0", "http://8.8.8.8:65536", "http://8.8.8.8:08080",
                       "http://8.8.8.8:8080/path", "http://8.8.8.8:8080?value=1", "http://8.8.8.8:8080#fragment",
                       "http://user:password@8.8.8.8:8080", "http://@8.8.8.8:8080", " http://8.8.8.8:8080",
                       "http://8.8.\t8.8:8080"):
            with self.subTest(origin=origin), self.assertRaises(ValidationError):
                self.settings(origin, allow=True)

    def test_local_development_http_and_public_https_remain_supported(self):
        for origin in ("http://localhost:3000", "http://127.0.0.1:3000", "http://192.168.1.5:3000",
                       "http://10.1.1.5:3000", "http://172.16.1.5:3000", "http://[::1]:3000",
                       "http://[fd00::1]:3000", "https://qstudy.example.org"):
            with self.subTest(origin=origin):
                self.assertEqual(self.settings(origin).PUBLIC_BASE_URL, origin)
        self.assertFalse(self.settings("https://qstudy.example.org").ALLOW_PUBLIC_HTTP)


if __name__ == "__main__":
    unittest.main()
