// Runs only in disposable CI containers, never against a user's installation.
import assert from "node:assert/strict";

const base = "http://127.0.0.1:3000";
const origin = process.env.PUBLIC_BASE_URL;
assert.ok(origin, "Public origin is configured");
const host = new URL(origin).host;
const email = "deployment-ci@example.org";
const password = "QStudyDisposableCi2026!";

async function request(path, { method = "GET", body, cookie, suppliedOrigin = origin } = {}) {
  const headers = { Host: host };
  if (suppliedOrigin) headers.Origin = suppliedOrigin;
  if (body) headers["Content-Type"] = "application/json";
  if (cookie) headers.Cookie = cookie;
  return fetch(base + path, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
    redirect: "manual", signal: AbortSignal.timeout(30_000),
  });
}

const health = await request("/api/health");
assert.equal(health.status, 200, "BFF reaches the private backend");
assert.equal((await health.json()).service, "QStudy");
for (const suppliedOrigin of [null, "https://evil.example", origin.replace("https:", "http:")]) {
  const denied = await request("/api/auth/login", { method: "POST", body: { email, password }, suppliedOrigin });
  assert.equal(denied.status, 403, "Cross-site or insecure origins are rejected");
}

const existing = process.argv.includes("--existing");
const auth = await request(existing ? "/api/auth/login" : "/api/auth/register", {
  method: "POST", body: existing ? { email, password } : { email, password, name: "Disposable CI student" },
});
assert.equal(auth.status, 200, "HTTPS public origin works behind an HTTP internal proxy");
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
