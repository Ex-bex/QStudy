import assert from "node:assert/strict";
import { test } from "node:test";
import {
  gameWebSocketOrigin,
  gameContentSecurityPolicy,
  prepareGameResponse,
} from "./game-csp.mjs";

const local = { authority: "127.0.0.1:3000" };
const internet = { authority: "94.125.99.135:8080" };
const secure = { authority: "qstudy.example", protocol: "https:" };

test("runtime policies permit only the configured WebSocket authority", () => {
  for (const [configuration, target] of [
    [local, "ws://127.0.0.1:3000"],
    [{ authority: "192.168.1.50:3001" }, "ws://192.168.1.50:3001"],
    [internet, "ws://94.125.99.135:8080"],
    [secure, "wss://qstudy.example"],
  ]) {
    assert.equal(gameWebSocketOrigin(configuration), target);
    const policy = gameContentSecurityPolicy(
      "default-src 'self'; connect-src 'self'; object-src 'none'",
      configuration,
    );
    assert.equal(
      policy,
      `default-src 'self'; connect-src 'self' ${target}; object-src 'none'`,
    );
    assert.doesNotMatch(policy, /(?:^|\s)(?:ws:|wss:)(?:\s|;|$)|\*/);
    assert.equal(gameContentSecurityPolicy(policy, configuration), policy);
  }
});

test("each existing policy is updated without relaxing explicit restrictions", () => {
  assert.equal(
    gameContentSecurityPolicy(
      ["default-src 'self'", "connect-src 'self'; img-src data:"],
      internet,
    ),
    "default-src 'self'; connect-src 'self' ws://94.125.99.135:8080, connect-src 'self' ws://94.125.99.135:8080; img-src data:",
  );
  for (const policy of [
    "connect-src 'none'",
    "default-src 'none'",
    "connect-src https://api.example",
  ])
    assert.equal(gameContentSecurityPolicy(policy, internet), policy);
  assert.equal(gameContentSecurityPolicy(undefined, internet), "");
});

function responseFixture() {
  return {
    headers: new Map(),
    committed: null,
    getHeader(name) {
      return this.headers.get(name.toLowerCase());
    },
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
    writeHead(...args) {
      this.committed = args;
      return this;
    },
  };
}

test("writeHead covers late maps, status messages and duplicate raw headers", () => {
  for (const args of [
    [200, { "Content-Security-Policy": "connect-src 'self'", "X-Keep": "yes" }],
    [
      200,
      "OK",
      {
        "content-security-policy": ["connect-src 'self'", "connect-src 'self'"],
        "X-Keep": "yes",
      },
    ],
    [
      200,
      undefined,
      { "Content-Security-Policy": "connect-src 'self'", "X-Keep": "yes" },
    ],
    [
      200,
      [
        "Content-Security-Policy",
        "connect-src 'self'",
        "X-Keep",
        "yes",
        "content-security-policy",
        "default-src 'self'",
      ],
    ],
  ]) {
    const response = responseFixture();
    prepareGameResponse(response, internet);
    response.setHeader("Content-Security-Policy", "connect-src 'self'");
    assert.equal(response.writeHead(...args), response);
    const policy = response.getHeader("Content-Security-Policy");
    assert.match(policy, /connect-src 'self' ws:\/\/94\.125\.99\.135:8080/);
    for (const part of policy.split(","))
      assert.ok(part.includes("ws://94.125.99.135:8080"));
    assert.equal(
      policy
        .split(",")
        .filter(
          (part) =>
            part.trim() === "connect-src 'self' ws://94.125.99.135:8080",
        ).length,
      1,
    );
    const supplied = response.committed.at(-1);
    assert.doesNotMatch(JSON.stringify(supplied), /content-security-policy/i);
    assert.match(JSON.stringify(supplied), /X-Keep/);
  }
});

test("header commit amends late setHeader and leaves unrelated headers intact", () => {
  const response = responseFixture();
  prepareGameResponse(response, secure);
  response.setHeader(
    "Content-Security-Policy",
    "connect-src 'self'; frame-ancestors 'none'",
  );
  response.setHeader("Set-Cookie", ["fixture=1; HttpOnly", "other=2"]);
  response.writeHead(200);
  assert.equal(
    response.getHeader("Content-Security-Policy"),
    "connect-src 'self' wss://qstudy.example; frame-ancestors 'none'",
  );
  assert.deepEqual(response.getHeader("Set-Cookie"), [
    "fixture=1; HttpOnly",
    "other=2",
  ]);
});

test("policy authority cannot inject paths, credentials or additional sources", () => {
  for (const authority of [
    "user:password@example.com",
    "example.com/path",
    "example.com?query=1",
    "example.com#fragment",
    "example.com ws://evil.example",
  ])
    assert.throws(() => gameWebSocketOrigin({ authority }));
  assert.throws(() => gameWebSocketOrigin({ ...secure, protocol: "ftp:" }));
});
