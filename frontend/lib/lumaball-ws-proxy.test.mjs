import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import {
  gameUpgradeRequest,
  createGameUpgradeProxy,
} from "./lumaball-ws-proxy.mjs";
import {
  nativeServerConfiguration,
  prepareNativeRequest,
  privateProxyConfiguration,
  preparePrivateProxyRequest,
} from "./native-server.mjs";

const room = "12345678123412341234123456789abc";
const ticket = "oneshot_fixture_ticket_01234567890123456789";
const proof = "fixture_private_proxy_secret_01234567890123456789";
const key = "dGhlIHNhbXBsZSBub25jZQ==";
const environment = {
  QSTUDY_ACCESS_MODE: "local",
  PUBLIC_BASE_URL: "http://127.0.0.1:3000",
  BFF_PROXY_SECRET: proof,
  BACKEND_URL: "http://127.0.0.1:8000",
};
const config = nativeServerConfiguration(environment, [
  "--hostname",
  "127.0.0.1",
  "--port",
  "3000",
]);
const fixture = () => ({
  method: "GET",
  url: `/api/lumaball/ws?ticket=${ticket}&room=${room}`,
  headers: {
    host: "127.0.0.1:3000",
    origin: "http://127.0.0.1:3000",
    upgrade: "websocket",
    "sec-websocket-version": "13",
    "sec-websocket-key": key,
    cookie: "qstudy_session=must-not-forward",
    authorization: "Bearer must-not-forward",
    "x-qstudy-client-ip": "1.1.1.1",
    "x-qstudy-proxy-key": "forged",
  },
  socket: { remoteAddress: "::ffff:192.168.1.12" },
});

test("the game tunnel forwards only the fixed backend, short-lived ticket and socket identity", () => {
  const target = gameUpgradeRequest(fixture(), environment, config);
  assert.equal(target.hostname, "127.0.0.1");
  assert.equal(target.headers["X-QStudy-Proxy-Key"], proof);
  assert.equal(target.headers["X-QStudy-Client-IP"], "192.168.1.12");
  assert.equal(target.headers.cookie, undefined);
  assert.equal(target.headers.authorization, undefined);
});

test("the tunnel refuses cross-site, generic upgrades, duplicate tickets and external targets", () => {
  const invalid = [
    (r) => (r.headers.origin = "http://evil.example"),
    (r) => (r.headers.host = "evil.example"),
    (r) => (r.url = "/other?ticket=" + ticket + "&room=" + room),
    (r) => (r.url += "&ticket=" + ticket),
    (r) => (r.url += "&target=http://evil.example"),
    (r) => (r.headers["sec-websocket-key"] = "invalid"),
    (r) => (r.url = "/api/lumaball/ws?ticket=short&room=" + room),
  ];
  for (const mutate of invalid) {
    const r = fixture();
    mutate(r);
    assert.equal(gameUpgradeRequest(r, environment, config), null);
  }
  for (const backend of [
    "http://evil.example",
    "http://127.0.0.2:8000",
    "https://127.0.0.1:8000",
    "http://u:p@127.0.0.1:8000",
    "http://127.0.0.1:8000/path",
  ])
    assert.equal(
      gameUpgradeRequest(
        fixture(),
        { ...environment, BACKEND_URL: backend },
        config,
      ),
      null,
    );
});

test("Docker's private proxy retains HTTPS and never trusts public Host overrides", () => {
  const env = {
    ...environment,
    QSTUDY_ACCESS_MODE: "proxy",
    PUBLIC_BASE_URL: "https://qstudy.example",
    TRUST_PROXY_HEADERS: "true",
    BACKEND_URL: "http://backend:8000",
  };
  const configuration = privateProxyConfiguration(env, [
    "--hostname",
    "0.0.0.0",
    "--port",
    "3000",
  ]);
  const request = fixture();
  request.headers.host = "qstudy.example";
  request.headers.origin = "https://qstudy.example";
  request.headers["x-real-ip"] = "8.8.8.8";
  request.rawHeaders = [
    "Host",
    "qstudy.example",
    "X-Real-IP",
    "8.8.8.8",
    "X-QStudy-Proxy-Key",
    "forged",
  ];
  assert.ok(preparePrivateProxyRequest(request, configuration));
  assert.equal(request.headers["x-forwarded-proto"], "https");
  assert.equal(request.headers["x-qstudy-proxy-key"], undefined);
  assert.equal(
    gameUpgradeRequest(request, env, configuration).headers[
      "X-QStudy-Client-IP"
    ],
    "8.8.8.8",
  );
  const other = fixture();
  other.headers.host = "evil.example";
  other.rawHeaders = ["Host", "evil.example"];
  assert.equal(preparePrivateProxyRequest(other, configuration), false);
});

test(
  "an actual same-origin upgrade tunnels bytes and strips the account cookie",
  { timeout: 10000 },
  async () => {
    let called = 0,
      captured;
    const backend = createServer();
    const backendSockets = new Set();
    backend.on("upgrade", (request, socket) => {
      called++;
      captured = request.headers;
      backendSockets.add(socket);
      socket.on("close", () => backendSockets.delete(socket));
      const accept = createHash("sha1")
        .update(
          request.headers["sec-websocket-key"] +
            "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
        )
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
          accept +
          "\r\n\r\n",
      );
      socket.on("data", (bytes) => socket.write(bytes));
    });
    await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
    let localConfig, proxy;
    const frontend = createServer();
    frontend.on("upgrade", (request, socket, head) => {
      if (!prepareNativeRequest(request, localConfig)) {
        socket.destroy();
        return;
      }
      proxy.upgrade(request, socket, head);
    });
    await new Promise((resolve) => frontend.listen(0, "127.0.0.1", resolve));
    const port = frontend.address().port;
    const env = {
      ...environment,
      PUBLIC_BASE_URL: "http://127.0.0.1:" + port,
      BACKEND_URL: "http://127.0.0.1:" + backend.address().port,
    };
    localConfig = nativeServerConfiguration(env, [
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ]);
    proxy = createGameUpgradeProxy(env, localConfig);
    try {
      const response = await new Promise((resolve, reject) => {
        const request = httpRequest(env.PUBLIC_BASE_URL + fixture().url, {
          headers: {
            Host: "127.0.0.1:" + port,
            Origin: env.PUBLIC_BASE_URL,
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Version": "13",
            "Sec-WebSocket-Key": key,
            Cookie: "qstudy_session=private",
            "X-QStudy-Proxy-Key": "forged",
            "X-QStudy-Client-IP": "1.1.1.1",
          },
        });
        request.on("upgrade", (_response, socket) => {
          socket.on("error", reject);
          socket.once("data", (data) => {
            resolve(data.toString());
            socket.destroy();
          });
          socket.write(Buffer.from("fixture-game-frame"));
        });
        request.on("error", reject);
        request.end();
      });
      assert.equal(response, "fixture-game-frame");
      assert.equal(called, 1);
      assert.equal(captured.cookie, undefined);
      assert.equal(captured["x-qstudy-proxy-key"], proof);
      assert.equal(captured["x-qstudy-client-ip"], "127.0.0.1");
    } finally {
      proxy.close();
      for (const socket of backendSockets) socket.destroy();
      await Promise.all([
        new Promise((resolve) => frontend.close(resolve)),
        new Promise((resolve) => backend.close(resolve)),
      ]);
    }
  },
);
