"""Untrusted clients cannot select another visitor's rate limit bucket."""
import os
os.environ.setdefault("SECRET_KEY", "test-only-qstudy-secret-key-32-characters-long")
import unittest
from unittest.mock import patch
from starlette.requests import Request
from app.config import settings
from app.security import client_key


class ProxySecurityTests(unittest.TestCase):
    def request(self, **headers):
        return Request({"type": "http", "client": ("10.0.0.5", 1234),
                        "headers": [(key.encode(), value.encode()) for key, value in headers.items()]})

    def test_spoofed_forwarding_headers_and_wrong_key_are_ignored(self):
        with patch.object(settings, "BFF_PROXY_SECRET", "test-proxy-key-" * 4):
            for headers in [{"x-forwarded-for": "203.0.113.8"}, {"x-real-ip": "203.0.113.8"},
                            {"x-qstudy-client-ip": "203.0.113.8"},
                            {"x-qstudy-client-ip": "203.0.113.8", "x-qstudy-proxy-key": "wrong"}]:
                self.assertEqual(client_key(self.request(**headers)), "10.0.0.5")

    def test_authenticated_proxy_isolates_real_visitor_buckets(self):
        key = "test-proxy-key-" * 4
        with patch.object(settings, "BFF_PROXY_SECRET", key):
            for ip, expected in [("203.0.113.8", "203.0.113.8"), ("2001:db8::1", "2001:db8::1")]:
                self.assertEqual(client_key(self.request(**{"x-qstudy-proxy-key": key, "x-qstudy-client-ip": ip})), expected)
            for ip in ["203.0.113.8, 127.0.0.1", "[::1]:80", "private text", ""]:
                self.assertEqual(client_key(self.request(**{"x-qstudy-proxy-key": key, "x-qstudy-client-ip": ip})), "10.0.0.5")

    def test_forwarding_is_disabled_without_a_configured_key(self):
        with patch.object(settings, "BFF_PROXY_SECRET", ""):
            self.assertEqual(client_key(self.request(**{"x-qstudy-proxy-key": "", "x-qstudy-client-ip": "203.0.113.8"})), "10.0.0.5")


if __name__ == "__main__":
    unittest.main()
