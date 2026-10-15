import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, request as httpRequest } from "node:http";
import {
  nativeServerConfiguration,
  prepareNativeRequest,
} from "./native-server.mjs";

const configured = (
  mode = "local",
  url = "http://127.0.0.1:3000",
  bind = "127.0.0.1",
  port = "3000",
) =>
  nativeServerConfiguration(
    {
      QSTUDY_ACCESS_MODE: mode,
      PUBLIC_BASE_URL: url,
      ALLOW_PUBLIC_HTTP: "true",
    },
    ["--hostname", bind, "--port", port],
  );
const request = (host = "127.0.0.1:3000") => ({
  headers: { host },
  rawHeaders: ["Host", host],
  socket: { remoteAddress: "::ffff:192.168.1.10" },
  url: "/api/auth/me",
});

test("native modes permit only their own explicit listener and address range", () => {
  assert.equal(configured().bind, "127.0.0.1");
  assert.equal(
    configured("lan", "http://192.168.1.10:3000", "0.0.0.0").authority,
    "192.168.1.10:3000",
  );
  assert.equal(
    configured("internet", "http://8.8.8.8:8080", "0.0.0.0", "8080").port,
    8080,
  );
  for (const args of [
    ["local", "http://127.0.0.1:3000", "0.0.0.0"],
    ["local", "http://192.168.1.10:3000"],
    ["lan", "http://8.8.8.8:3000", "0.0.0.0"],
    ["internet", "http://100.64.1.1:3000", "0.0.0.0"],
    ["internet", "http://192.168.1.10:3000", "0.0.0.0"],
    ["lan", "http://192.168.01.10:3000", "0.0.0.0"],
  ])
    assert.throws(() => configured(...args));
  assert.throws(() =>
    nativeServerConfiguration(
      {
        QSTUDY_ACCESS_MODE: "internet",
        PUBLIC_BASE_URL: "http://8.8.8.8:8080",
        ALLOW_PUBLIC_HTTP: "false",
      },
      ["--hostname", "0.0.0.0", "--port", "8080"],
    ),
  );
});

test("native gate rejects Host confusion before any Next route or public asset", () => {
  const config = configured();
  for (const host of [
    "localhost:3000",
    "127.0.0.1",
    "127.0.0.1:3001",
    "evil.example",
    "127.0.0.1:3000.evil.example",
    "user@127.0.0.1:3000",
    "127.0.0.1:03000",
  ])
    assert.equal(prepareNativeRequest(request(host), config), false);
  const duplicate = request();
  duplicate.rawHeaders.push("HOST", "evil.example");
  assert.equal(prepareNativeRequest(duplicate, config), false);
  for (const target of [
    "http://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
  ]) {
    const candidate = request();
    candidate.url = target;
    assert.equal(prepareNativeRequest(candidate, config), false);
  }
});

test("native gate derives client identity from the socket and removes spoofed proxy proofs", () => {
  const candidate = request();
  Object.assign(candidate.headers, {
    "x-real-ip": "8.8.8.8",
    "x-forwarded-for": "1.1.1.1",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "https",
    forwarded: "for=1.1.1.1;host=evil.example",
    "x-qstudy-proxy-key": "fake-proof",
    "x-qstudy-client-ip": "1.1.1.1",
  });
  assert.equal(prepareNativeRequest(candidate, configured()), true);
  assert.equal(candidate.headers["x-real-ip"], "192.168.1.10");
  assert.equal(candidate.headers["x-forwarded-host"], "127.0.0.1:3000");
  assert.equal(candidate.headers["x-forwarded-proto"], "http");
  assert.equal(candidate.headers["x-forwarded-for"], undefined);
  assert.equal(candidate.headers.forwarded, undefined);
  assert.equal(candidate.headers["x-qstudy-proxy-key"], undefined);
  assert.equal(candidate.headers["x-qstudy-client-ip"], undefined);
});

test("native gate supports canonical default port without accepting a different authority", () => {
  const config = configured("local", "http://127.0.0.1:80", "127.0.0.1", "80");
  assert.equal(prepareNativeRequest(request("127.0.0.1"), config), true);
  assert.equal(prepareNativeRequest(request("127.0.0.1:80"), config), true);
  assert.equal(prepareNativeRequest(request("localhost:80"), config), false);
});

test("HTTP fixture strips a forged rate-limit identity and rejects foreign or duplicate Host before routing", async () => {
  let config;
  let routed = 0;
  const server = createServer((incoming, response) => {
    if (!prepareNativeRequest(incoming, config)) {
      response.writeHead(421);
      response.end();
      return;
    }
    routed++;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify({
        ip: incoming.headers["x-real-ip"],
        proto: incoming.headers["x-forwarded-proto"],
        host: incoming.headers["x-forwarded-host"],
        forgedProof: incoming.headers["x-qstudy-proxy-key"] || null,
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const authority = "127.0.0.1:" + port;
  config = configured(
    "local",
    "http://" + authority,
    "127.0.0.1",
    String(port),
  );
  const call = (headers, path = "/api/admin/system/status") =>
    new Promise((resolve, reject) => {
      const outgoing = httpRequest(
        { hostname: "127.0.0.1", port, path, headers },
        (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk) => {
            body += chunk;
          });
          response.on("end", () =>
            resolve({ status: response.statusCode, body }),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end();
    });
  try {
    const response = await call({
      Host: authority,
      "x-real-ip": "8.8.8.8",
      "x-forwarded-for": "1.1.1.1",
      "x-forwarded-proto": "https",
      "x-forwarded-host": "evil.example",
      "x-qstudy-proxy-key": "fake",
    });
    assert.equal(response.status, 200);
    assert.deepEqual(JSON.parse(response.body), {
      ip: "127.0.0.1",
      proto: "http",
      host: authority,
      forgedProof: null,
    });
    assert.equal((await call({ Host: "evil.example" })).status, 421);
    assert.equal(
      (await call(["Host", authority, "Host", "evil.example"])).status,
      421,
    );
    assert.equal(
      (await call({ Host: authority }, "http://evil.example/")).status,
      421,
    );
    assert.equal(routed, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
