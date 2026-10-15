import assert from "node:assert/strict";
import { test } from "node:test";
import {
  publicHttpOrigin,
  sameSiteMutation,
  sessionCookieOptions,
  trustedClientIp,
} from "./proxy-security.ts";
import { nativeHttpOrigin } from "./proxy-security.ts";

test("production local and LAN HTTP require the native launcher mode and exact Origin/Host", () => {
  for (const [mode, origin, host] of [
    ["local", "http://127.0.0.1:3000", "127.0.0.1:3000"],
    ["lan", "http://192.168.1.10:8080", "192.168.1.10:8080"],
  ]) {
    assert.equal(nativeHttpOrigin(origin, mode)?.origin, origin);
    assert.equal(
      sameSiteMutation(
        origin,
        host,
        "http:",
        origin,
        "false",
        "production",
        mode,
      ),
      true,
    );
    assert.equal(
      sessionCookieOptions(host, "http:", "production", origin, "false", mode)
        .secure,
      false,
    );
    assert.equal(
      sameSiteMutation(origin, host, "http:", origin, "false", "production"),
      false,
    );
    assert.equal(
      sessionCookieOptions(host, "http:", "production", origin, "false").secure,
      true,
    );
    for (const badOrigin of [
      "http://evil.example",
      "http://127.0.0.1:3001",
      "https://" + host,
    ])
      assert.equal(
        sameSiteMutation(
          badOrigin,
          host,
          "http:",
          origin,
          "false",
          "production",
          mode,
        ),
        false,
      );
    assert.equal(
      sameSiteMutation(
        origin,
        "evil.example",
        "http:",
        origin,
        "false",
        "production",
        mode,
      ),
      false,
    );
  }
  for (const [origin, mode] of [
    ["http://8.8.8.8:8080", "lan"],
    ["http://192.168.1.10:8080", "local"],
    ["http://127.0.0.1:3000", "internet"],
    ["http://100.64.1.1:8080", "lan"],
    ["http://169.254.1.1:8080", "lan"],
    ["http://192.168.01.10:8080", "lan"],
  ])
    assert.equal(nativeHttpOrigin(origin, mode), null);
});

test("local mutations require full origin including protocol and port", () => {
  assert.equal(
    sameSiteMutation("http://127.0.0.1:3000", "127.0.0.1:3000", "http:"),
    true,
  );
  for (const origin of [
    null,
    "null",
    "https://127.0.0.1:3000",
    "http://127.0.0.1:3001",
    "https://evil.example",
    "http://x@127.0.0.1:3000",
    "http://127.0.0.1:3000/path",
  ]) {
    assert.equal(sameSiteMutation(origin, "127.0.0.1:3000", "http:"), false);
  }
});

test("HTTPS termination uses configured public origin while validating Host", () => {
  const trusted = "https://qstudy.example";
  assert.equal(
    sameSiteMutation(trusted, "qstudy.example", "http:", trusted),
    true,
  );
  for (const origin of [
    "http://qstudy.example",
    "https://qstudy.example:8443",
    "https://qstudy.example.evil.test",
    "https://evil.test",
    "https://qstudy.example?x=1",
  ]) {
    assert.equal(
      sameSiteMutation(origin, "qstudy.example", "http:", trusted),
      false,
    );
  }
  assert.equal(sameSiteMutation(trusted, "evil.test", "http:", trusted), false);
  assert.equal(
    sameSiteMutation(trusted, "qstudy.example", "http:", "invalid"),
    false,
  );
  assert.equal(
    sameSiteMutation(trusted, "qstudy.example", "http:", trusted + "/path"),
    false,
  );
});

test("client forwarding needs explicit production trust and a private shared key", () => {
  const key = "test-only-proxy-secret".repeat(3);
  assert.equal(
    trustedClientIp("203.0.113.17", "true", "production", key),
    "203.0.113.17",
  );
  assert.equal(
    trustedClientIp("2001:db8::2", "true", "production", key),
    "2001:db8::2",
  );
  for (const value of [
    "203.0.113.17, 127.0.0.1",
    "203.0.113.17:8000",
    "not-an-ip",
    null,
  ]) {
    assert.equal(trustedClientIp(value, "true", "production", key), null);
  }
  assert.equal(
    trustedClientIp("203.0.113.17", "false", "production", key),
    null,
  );
  assert.equal(
    trustedClientIp("203.0.113.17", "true", "development", key),
    null,
  );
  assert.equal(
    trustedClientIp("203.0.113.17", "true", "production", "short"),
    null,
  );
});

test("production HTTP requires explicit opt-in and a canonical global IPv4", () => {
  const trusted = "http://8.8.8.8:18080";
  assert.equal(publicHttpOrigin(trusted, "true")?.origin, trusted);
  assert.equal(
    publicHttpOrigin("http://8.8.8.8:80", "true")?.origin,
    "http://8.8.8.8",
  );
  assert.equal(
    sameSiteMutation(
      trusted,
      "8.8.8.8:18080",
      "http:",
      trusted,
      "true",
      "production",
    ),
    true,
  );
  assert.equal(
    sameSiteMutation(
      "http://8.8.8.8",
      "8.8.8.8",
      "http:",
      "http://8.8.8.8:80",
      "true",
      "production",
    ),
    true,
  );
  assert.equal(
    sameSiteMutation(
      "http://8.8.8.8",
      "8.8.8.8:80",
      "http:",
      "http://8.8.8.8:80",
      "true",
      "production",
    ),
    true,
  );
  for (const optIn of [undefined, "false", "TRUE", "1"]) {
    assert.equal(publicHttpOrigin(trusted, optIn), null);
    assert.equal(
      sameSiteMutation(
        trusted,
        "8.8.8.8:18080",
        "http:",
        trusted,
        optIn,
        "production",
      ),
      false,
    );
  }
  for (const address of [
    "0.1.2.3",
    "10.1.2.3",
    "100.64.1.2",
    "127.0.0.1",
    "169.254.1.2",
    "172.16.1.2",
    "192.0.0.8",
    "192.0.2.1",
    "192.88.99.1",
    "192.88.99.2",
    "192.88.99.255",
    "192.168.1.9",
    "198.18.0.1",
    "198.51.100.1",
    "203.0.113.1",
    "224.0.0.1",
    "240.0.0.1",
    "255.255.255.255",
  ]) {
    assert.equal(
      publicHttpOrigin(`http://${address}:8080`, "true"),
      null,
      address,
    );
  }
  for (const url of [
    "http://qstudy.example:8080",
    "http://[2606:4700:4700::1111]:8080",
    "http://134744072:8080",
    "http://0x08080808:8080",
    "http://8.8.8.08:8080",
    "http://8.8.8.8",
    "http://8.8.8.8:08080",
    "http://8.8.8.8:0",
    "http://8.8.8.8:65536",
    "http://8.8.8.8:8080/path",
    "http://8.8.8.8:8080?x=1",
    "http://8.8.8.8:8080#x",
    "http://x@8.8.8.8:8080",
    ` ${trusted}`,
  ]) {
    assert.equal(publicHttpOrigin(url, "true"), null, url);
  }
  assert.equal(
    sameSiteMutation(
      "http://127.0.0.1:3000",
      "127.0.0.1:3000",
      "http:",
      undefined,
      undefined,
      "production",
    ),
    false,
  );
});

test("public IP HTTP mutations compare the entire public origin and Host", () => {
  const trusted = "http://8.8.8.8:18080";
  for (const origin of [
    null,
    "null",
    "https://8.8.8.8:18080",
    "http://8.8.8.8:18081",
    "http://8.8.8.8",
    "http://1.1.1.1:18080",
    "http://8.8.8.8:18080/path",
  ]) {
    assert.equal(
      sameSiteMutation(
        origin,
        "8.8.8.8:18080",
        "http:",
        trusted,
        "true",
        "production",
      ),
      false,
    );
  }
  assert.equal(
    sameSiteMutation(
      trusted,
      "8.8.8.8:18081",
      "http:",
      trusted,
      "true",
      "production",
    ),
    false,
  );
  assert.equal(
    sameSiteMutation(
      trusted,
      "1.1.1.1:18080",
      "http:",
      trusted,
      "true",
      "production",
    ),
    false,
  );
  assert.equal(
    sameSiteMutation(
      "https://qstudy.example",
      "qstudy.example",
      "http:",
      "https://qstudy.example",
      "true",
      "production",
    ),
    true,
  );
  assert.equal(
    sameSiteMutation(
      "http://qstudy.example",
      "qstudy.example",
      "http:",
      "https://qstudy.example",
      "true",
      "production",
    ),
    false,
  );
});

test("default HTTP port Host spellings are equivalent without accepting malformed authorities", () => {
  const trusted = "http://8.8.8.8:80";
  for (const host of ["8.8.8.8", "8.8.8.8:80"]) {
    for (const origin of ["http://8.8.8.8", "http://8.8.8.8:80"]) {
      assert.equal(
        sameSiteMutation(origin, host, "http:", trusted, "true", "production"),
        true,
      );
    }
    assert.equal(
      sessionCookieOptions(host, "http:", "production", trusted, "true").secure,
      false,
    );
  }
  for (const host of [
    "8.8.8.8:81",
    "8.8.8.8:443",
    "8.8.8.8:080",
    "8.8.8.8:",
    "8.8.8.8/",
    "user@8.8.8.8:80",
    "134744072:80",
    "8.8.8.8:80,evil.test",
    " 8.8.8.8:80",
    "8.8.8.8:80\r\nX-Host: evil.test",
  ]) {
    assert.equal(
      sameSiteMutation(
        "http://8.8.8.8",
        host,
        "http:",
        trusted,
        "true",
        "production",
      ),
      false,
      host,
    );
    assert.equal(
      sessionCookieOptions(host, "http:", "production", trusted, "true").secure,
      true,
      host,
    );
  }
  assert.equal(
    sameSiteMutation(
      "https://qstudy.example",
      "qstudy.example:443",
      "http:",
      "https://qstudy.example",
      undefined,
      "production",
    ),
    true,
  );
  assert.equal(
    sameSiteMutation(
      "https://qstudy.example",
      "qstudy.example:80",
      "http:",
      "https://qstudy.example",
      undefined,
      "production",
    ),
    false,
  );
});

test("session and expiry flags relax Secure only for the explicitly configured HTTP endpoint", () => {
  const trusted = "http://8.8.8.8:18080";
  const options = (host, protocol, nodeEnv, publicUrl, flag) =>
    sessionCookieOptions(host, protocol, nodeEnv, publicUrl, flag);
  assert.deepEqual(
    options("8.8.8.8:18080", "http:", "production", trusted, "true"),
    {
      httpOnly: true,
      secure: false,
      sameSite: "strict",
      path: "/",
    },
  );
  assert.equal(
    options("8.8.8.8", "http:", "production", "http://8.8.8.8:80", "true")
      .secure,
    false,
  );
  for (const [host, protocol, url, flag] of [
    ["8.8.8.8:18080", "http:", trusted, undefined],
    ["8.8.8.8:18081", "http:", trusted, "true"],
    ["8.8.8.8:18080", "https:", trusted, "true"],
    ["qstudy.example", "http:", "http://qstudy.example", "true"],
    ["127.0.0.1:3000", "http:", "http://127.0.0.1:3000", "true"],
    ["qstudy.example", "http:", "https://qstudy.example", "true"],
  ]) {
    assert.equal(options(host, protocol, "production", url, flag).secure, true);
  }
  assert.equal(options("127.0.0.1:3000", "http:", "development").secure, false);
  assert.equal(options("127.0.0.1:3000", "https:", "development").secure, true);
});
