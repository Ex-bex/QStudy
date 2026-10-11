// Runs only in disposable CI containers, never against a user's installation.
import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";

const base = "http://127.0.0.1:3000";
const origin = process.env.PUBLIC_BASE_URL;
assert.ok(origin, "Public origin is configured");
const host = new URL(origin).host;
const email = "deployment-ci@example.org";
const password = "QStudyDisposableCi2026!";

async function request(path, { method = "GET", body, cookie, suppliedOrigin = origin } = {}) {
  const headers = { Host: host };
  if (suppliedOrigin) headers.Origin = suppliedOrigin;
  const form = body instanceof URLSearchParams;
  const payload = body === undefined ? undefined : form ? body.toString() : JSON.stringify(body);
  if (payload !== undefined) {
    headers["Content-Type"] = form ? "application/x-www-form-urlencoded" : "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }
  if (cookie) headers.Cookie = cookie;
  // Node fetch replaces a custom Host. Simulate the HTTPS proxy with native HTTP,
  // keeping the real public Host and Origin while connecting over private HTTP.
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(base + path, {
      method, headers, signal: AbortSignal.timeout(30_000),
    }, async incoming => {
      try {
        const responseHeaders = new Headers();
        for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
          responseHeaders.append(incoming.rawHeaders[i], incoming.rawHeaders[i + 1]);
        }
        const chunks = [];
        let size = 0;
        for await (const chunk of incoming) {
          size += chunk.length;
          assert.ok(size <= 2 * 1024 * 1024, "Smoke response is bounded");
          chunks.push(chunk);
        }
        resolve(new Response(Buffer.concat(chunks), {
          status: incoming.statusCode, headers: responseHeaders,
        }));
      } catch (error) { reject(error); }
    });
    outgoing.on("error", reject);
    outgoing.end(payload);
  });
}

const health = await request("/api/health");
assert.equal(health.status, 200, "BFF reaches the private backend");
assert.equal((await health.json()).service, "QStudy");
for (const suppliedOrigin of [null, "https://evil.example", origin.replace("https:", "http:")]) {
  const denied = await request("/api/auth/login", {
    method: "POST", body: new URLSearchParams({ username: email, password }), suppliedOrigin,
  });
  assert.equal(denied.status, 403, "Cross-site or insecure origins are rejected");
}

const existing = process.argv.includes("--existing");
const auth = await request(existing ? "/api/auth/login" : "/api/auth/register", {
  method: "POST", body: existing
    ? new URLSearchParams({ username: email, password })
    : { email, password, name: "Disposable CI student" },
});
assert.equal(auth.status, existing ? 200 : 201, "HTTPS public origin works behind an HTTP internal proxy");
const cookies = auth.headers.getSetCookie();
const session = cookies.find(value => value.startsWith("qstudy_session="));
assert.ok(session && /;\s*Secure(?:;|$)/i.test(session), "Production cookie is Secure");
assert.match(session, /;\s*HttpOnly(?:;|$)/i, "Session stays private from scripts");
assert.match(session, /;\s*SameSite=Strict(?:;|$)/i);
const authData = await auth.json();
assert.equal(authData.access_token, undefined, "Bearer token is not returned to the browser");
assert.equal(authData.token, undefined);
const cookie = session.split(";", 1)[0];
const me = await request("/api/auth/me", { cookie });
assert.equal(me.status, 200);
const student = await me.json();
assert.equal(student.role, "student", "Public sign-up never grants administrator privileges");
assert.equal(student.email, email);
const admin = await request("/api/admin/stats", { cookie });
assert.equal(admin.status, 403, "Students cannot administer the installation");
const home = await request("/");
assert.equal(home.status, 200);
assert.ok((await home.text()).includes("QStudy"));
console.log(existing ? "Production persistence, login and proxy checks passed." : "Production health, auth, cookie, origin and role checks passed.");
