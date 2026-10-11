import assert from "node:assert/strict";
import { test } from "node:test";
import { sameSiteMutation, trustedClientIp } from "./proxy-security.ts";

test("local mutations require full origin including protocol and port", () => {
  assert.equal(sameSiteMutation("http://127.0.0.1:3000", "127.0.0.1:3000", "http:"), true);
  for (const origin of [null, "null", "https://127.0.0.1:3000", "http://127.0.0.1:3001", "https://evil.example", "http://x@127.0.0.1:3000", "http://127.0.0.1:3000/path"]) {
    assert.equal(sameSiteMutation(origin, "127.0.0.1:3000", "http:"), false);
  }
});

test("HTTPS termination uses configured public origin while validating Host", () => {
  const trusted = "https://qstudy.example";
  assert.equal(sameSiteMutation(trusted, "qstudy.example", "http:", trusted), true);
  for (const origin of ["http://qstudy.example", "https://qstudy.example:8443", "https://qstudy.example.evil.test", "https://evil.test", "https://qstudy.example?x=1"]) {
    assert.equal(sameSiteMutation(origin, "qstudy.example", "http:", trusted), false);
  }
  assert.equal(sameSiteMutation(trusted, "evil.test", "http:", trusted), false);
  assert.equal(sameSiteMutation(trusted, "qstudy.example", "http:", "invalid"), false);
  assert.equal(sameSiteMutation(trusted, "qstudy.example", "http:", trusted + "/path"), false);
});

test("client forwarding needs explicit production trust and a private shared key", () => {
  const key = "test-only-proxy-secret".repeat(3);
  assert.equal(trustedClientIp("203.0.113.17", "true", "production", key), "203.0.113.17");
  assert.equal(trustedClientIp("2001:db8::2", "true", "production", key), "2001:db8::2");
  for (const value of ["203.0.113.17, 127.0.0.1", "203.0.113.17:8000", "not-an-ip", null]) {
    assert.equal(trustedClientIp(value, "true", "production", key), null);
  }
  assert.equal(trustedClientIp("203.0.113.17", "false", "production", key), null);
  assert.equal(trustedClientIp("203.0.113.17", "true", "development", key), null);
  assert.equal(trustedClientIp("203.0.113.17", "true", "production", "short"), null);
});
