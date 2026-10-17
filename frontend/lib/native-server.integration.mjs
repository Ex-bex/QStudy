// Run after npm run build. Both servers are disposable and bound to loopback;
// the API fixture never imports application code, settings, accounts or SQLite.
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath, URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import process from "node:process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
const { fetch, AbortSignal } = globalThis;

const root = fileURLToPath(new URL("../", import.meta.url));
const instance = randomUUID().replaceAll("-", "");
const controlDirectory = fileURLToPath(
  new URL("../../.local/managed/", import.meta.url),
);
mkdirSync(controlDirectory, { recursive: true, mode: 0o700 });
const stopFile = join(controlDirectory, "frontend-stop-" + instance + ".json");
const proof = "disposable-native-proxy-proof-0123456789";
let calls = 0;
let child;
let releaseIdentityResponse;
let identityResponseStarted;
const guestSecret = "disposable-guest-credential-0123456789abcdefghi";
const backend = createServer((request, response) => {
  calls++;
  request.resume();
  response.setHeader("Content-Type", "application/json");
  if (request.url === "/api/auth/login")
    response.end(
      JSON.stringify({
        access_token: "fixture-session",
        user: { id: 1, role: "admin" },
      }),
    );
  else if (request.url === "/api/lumaball/session") {
    const member = request.headers.authorization === "Bearer fixture-session";
    if (
      request.headers.authorization === "Bearer expired-session" ||
      request.headers["x-lumaball-session"] === "expired"
    ) {
      response.statusCode = 401;
      response.end(JSON.stringify({ detail: "Session expired" }));
      return;
    }
    if (request.headers["x-lumaball-session"] === "banned") {
      response.statusCode = 403;
      response.end(JSON.stringify({ detail: "Access revoked" }));
      return;
    }
    response.end(
      JSON.stringify({
        identity: {
          id: member ? "member" : "guest",
          kind: member ? "user" : "guest",
          name: member ? "Студент" : "guest#123456",
        },
        config: {},
        ws_ticket: "single-use-opaque-ticket",
        ...(member ? {} : { guest_token: guestSecret }),
      }),
    );
  } else if (request.url?.split("?")[0] === "/api/lumaball/me") {
    const reply = () => {
      if (request.headers["x-lumaball-session"] !== guestSecret)
        response.statusCode = 401;
      response.end(
        JSON.stringify({
          guestValid: request.headers["x-lumaball-session"] === guestSecret,
          memberValid:
            request.headers.authorization === "Bearer fixture-session",
        }),
      );
    };
    if (request.url.endsWith("?delayed=1")) {
      releaseIdentityResponse = reply;
      identityResponseStarted?.();
    } else reply();
  } else if (request.url === "/api/health")
    response.end(JSON.stringify({ status: "ok", service: "QStudy" }));
  else
    response.end(
      JSON.stringify({
        ip: request.headers["x-qstudy-client-ip"],
        proofValid: request.headers["x-qstudy-proxy-key"] === proof,
        sessionValid:
          request.headers.authorization === "Bearer fixture-session",
      }),
    );
});
await new Promise((resolve) => backend.listen(0, "127.0.0.1", resolve));
const reservation = createServer();
await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const origin = "http://127.0.0.1:" + port;
try {
  child = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("../server.mjs", import.meta.url)),
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: root,
      env: {
        PATH: process.env.PATH,
        SystemRoot: process.env.SystemRoot,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
        NODE_ENV: "production",
        QSTUDY_ACCESS_MODE: "local",
        QSTUDY_INSTANCE: instance,
        QSTUDY_FRONTEND_STOP_FILE: stopFile,
        PUBLIC_BASE_URL: origin,
        ALLOW_PUBLIC_HTTP: "false",
        BACKEND_URL: "http://127.0.0.1:" + backend.address().port,
        TRUST_PROXY_HEADERS: "true",
        BFF_PROXY_SECRET: proof,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  child.stdout.resume();
  child.stderr.resume();
  let ready = false;
  for (let i = 0; i < 120; i++) {
    if (child.exitCode !== null)
      throw new Error("Disposable native frontend exited before readiness");
    try {
      const response = await fetch(origin + "/api/health", {
        signal: AbortSignal.timeout(500),
      });
      if (response.ok && (await response.json()).service === "QStudy") {
        ready = true;
        break;
      }
    } catch {
      /* The disposable server may still be preparing Next. */
    }
    await delay(100);
  }
  assert.ok(ready, "built native Next server becomes healthy");
  const beforeRejectedHost = calls;
  const foreignHost = await new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      origin + "/api/health",
      { headers: { Host: "evil.example" } },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      },
    );
    outgoing.on("error", reject);
    outgoing.end();
  });
  assert.equal(foreignHost, 421);
  assert.equal(
    calls,
    beforeRejectedHost,
    "untrusted host never reaches BFF or backend",
  );
  const login = await fetch(origin + "/api/auth/login", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "fixture@example.invalid",
      password: "not-an-account",
    }),
  });
  assert.equal(
    login.status,
    200,
    "native production loopback login passes exact-origin guard",
  );
  const cookie = login.headers.get("set-cookie");
  assert.ok(cookie.includes("qstudy_session=fixture-session"));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  assert.doesNotMatch(
    cookie,
    /;\s*Secure(?:;|$)/i,
    "HTTP native cookie remains usable in the browser",
  );
  assert.equal(
    (await login.json()).access_token,
    undefined,
    "BFF keeps access token out of browser JSON",
  );
  const headers = {
    Cookie: "qstudy_session=fixture-session",
    Origin: origin,
    "Content-Type": "application/json",
    "x-real-ip": "8.8.8.8",
    "x-forwarded-for": "1.1.1.1",
    "x-forwarded-proto": "https",
    "x-qstudy-proxy-key": "forged",
  };
  const mutation = await fetch(origin + "/api/admin/system/settings", {
    method: "PATCH",
    headers,
    body: "{}",
  });
  assert.equal(mutation.status, 200);
  assert.deepEqual(
    await mutation.json(),
    { ip: "127.0.0.1", proofValid: true, sessionValid: true },
    "BFF authenticates the socket identity and server session, never forged client forwarding",
  );
  const beforeCrossSite = calls;
  assert.equal(
    (
      await fetch(origin + "/api/admin/system/settings", {
        method: "PATCH",
        headers: { ...headers, Origin: "http://evil.example" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    calls,
    beforeCrossSite,
    "cross-site mutation never reaches the API",
  );
  const guestSession = await fetch(origin + "/api/lumaball/session", {
    method: "POST",
    headers: { Origin: origin },
  });
  assert.equal(guestSession.status, 200);
  const guestData = await guestSession.json();
  assert.equal(guestData.identity.name, "guest#123456");
  assert.equal(
    guestData.guest_token,
    undefined,
    "guest credentials never appear in browser JSON",
  );
  const guestCookie = guestSession.headers.get("set-cookie");
  assert.match(guestCookie, /lumaball_guest=/);
  assert.match(guestCookie, /HttpOnly/i);
  assert.match(guestCookie, /SameSite=Strict/i);
  assert.match(guestCookie, /Max-Age=2592000/i);
  assert.doesNotMatch(guestCookie, /;\s*Secure(?:;|$)/i);
  const resumed = await fetch(origin + "/api/lumaball/me", {
    headers: {
      Cookie: guestCookie.split(";", 1)[0],
      "X-LumaBall-Session": "forged-browser-header",
    },
  });
  assert.deepEqual(
    await resumed.json(),
    { guestValid: true, memberValid: false },
    "BFF forwards only its HttpOnly guest cookie",
  );
  const memberGame = await fetch(origin + "/api/lumaball/session", {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: "qstudy_session=fixture-session; " + guestCookie.split(";", 1)[0],
    },
  });
  assert.equal(
    (await memberGame.json()).identity.kind,
    "user",
    "QStudy session takes precedence over guest identity",
  );
  assert.equal(
    memberGame.headers.get("set-cookie"),
    null,
    "member game entry does not replace either session",
  );
  const expiredGuest = await fetch(origin + "/api/lumaball/me", {
    headers: { Cookie: "lumaball_guest=expired" },
  });
  assert.equal(expiredGuest.status, 401);
  for (const previousCookie of [undefined, "lumaball_guest=expired"]) {
    const identityStarted = new Promise((resolve) => {
      identityResponseStarted = resolve;
    });
    const initialRead = fetch(origin + "/api/lumaball/me?delayed=1", {
      headers: previousCookie ? { Cookie: previousCookie } : {},
    });
    await identityStarted;
    const freshEntry = await fetch(origin + "/api/lumaball/session", {
      method: "POST",
      headers: { Origin: origin },
    });
    assert.equal(freshEntry.status, 200);
    const newCookie = freshEntry.headers.get("set-cookie").split(";", 1)[0];
    releaseIdentityResponse();
    const staleRead = await initialRead;
    assert.equal(staleRead.status, 401);
    assert.equal(
      staleRead.headers.get("set-cookie"),
      null,
      "an initial /me response arriving after guest creation must not delete the new credential",
    );
    const stillSignedIn = await fetch(origin + "/api/lumaball/me", {
      headers: { Cookie: newCookie },
    });
    assert.equal(stillSignedIn.status, 200);
  }
  assert.equal(
    expiredGuest.headers.get("set-cookie"),
    null,
    "read-only checks cannot mutate guest credentials",
  );
  for (const [sessionCookie, status, mayReset] of [
    ["lumaball_guest=expired", 401, true],
    ["lumaball_guest=banned", 403, false],
    ["qstudy_session=expired-session; lumaball_guest=expired", 401, false],
  ]) {
    const entry = await fetch(origin + "/api/lumaball/session", {
      method: "POST",
      headers: { Origin: origin, Cookie: sessionCookie },
    });
    assert.equal(entry.status, status);
    assert.equal(
      entry.headers.get("X-QBall-Guest-Reset"),
      mayReset ? "1" : null,
    );
    if (mayReset)
      assert.match(entry.headers.get("set-cookie"), /lumaball_guest=;/);
    else
      assert.doesNotMatch(
        entry.headers.get("set-cookie") || "",
        /lumaball_guest=;/,
      );
  }
  const gameIntroduction = await fetch(origin + "/qball");
  assert.equal(
    gameIntroduction.status,
    200,
    "production build serves the public introduction",
  );
  const policies = gameIntroduction.headers
    .get("content-security-policy")
    .split(",");
  for (const policy of policies) {
    const connect = policy
      .split(";")
      .find((directive) => directive.trim().startsWith("connect-src "));
    assert.ok(
      connect
        ?.trim()
        .split(/\s+/)
        .includes("ws://127.0.0.1:" + port),
      "every production policy explicitly permits this runtime port's same-origin WebSocket",
    );
  }
  assert.doesNotMatch(
    gameIntroduction.headers.get("content-security-policy"),
    /(?:^|\s)(?:ws:|wss:)(?:\s|;|$)/,
    "production CSP never enables WebSockets to arbitrary hosts",
  );
  assert.equal(
    (await fetch(origin + "/qball/play")).status,
    200,
    "production build serves the guest-capable lobby",
  );
  for (const [before, after] of [
    ["/lumaball?from=invite", "/qball?from=invite"],
    ["/lumaball/play", "/qball/play"],
    [
      "/lumaball/room/" + "a".repeat(32) + "?from=invite",
      "/qball/room/" + "a".repeat(32) + "?from=invite",
    ],
    ["/dashboard/admin/lumaball", "/qcontrol/qball"],
  ]) {
    const redirect = await fetch(origin + before, { redirect: "manual" });
    assert.equal(redirect.status, 307);
    const location = new URL(redirect.headers.get("location"), origin);
    assert.equal(location.pathname + location.search, after);
  }
  const brand = await fetch(origin + "/branding/qball-logo.png");
  assert.equal(brand.status, 200);
  assert.match(brand.headers.get("content-type"), /image\/png/);
  const stopBegan = Date.now();
  const stopped = new Promise((resolve) =>
    child.once("exit", (code) => resolve(code)),
  );
  writeFileSync(
    stopFile,
    JSON.stringify({ version: 1, instance, action: "stop" }),
    { mode: 0o600 },
  );
  const exitCode = await Promise.race([
    stopped,
    delay(8000, "timeout", { ref: false }),
  ]);
  assert.equal(
    exitCode,
    0,
    "private stop receipt gracefully closes the actual Next child without console signals",
  );
  assert.ok(Date.now() - stopBegan < 8000, "detached child stops promptly");
  console.log(
    "Native built-server integration passed: HTTP login/cookie, QBall HttpOnly sessions, public pages, legacy redirects, PNG logo, CSRF, exact Host, signed socket IP, private-file graceful stop. Disposable loopback API only.",
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      delay(5000),
    ]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  backend.closeAllConnections();
  await new Promise((resolve) => backend.close(resolve));
  try {
    unlinkSync(stopFile);
  } catch {
    /* Stop is optional after an earlier failed assertion. */
  }
}
