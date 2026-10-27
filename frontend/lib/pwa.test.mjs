import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PWA_APPS,
  pwaApp,
  pwaAppForPath,
  pwaIconUrl,
  pwaManifest,
  pwaManifestUrl,
} from "./pwa.ts";

test("Each installable project has an independent stable identity and valid launch scope", () => {
  const ids = new Set();
  const manifests = new Set();
  for (const app of PWA_APPS) {
    const manifest = pwaManifest(app.id);
    assert.equal(manifest.name, app.name);
    assert.equal(manifest.display, "standalone");
    assert.ok(manifest.start_url.startsWith(manifest.scope));
    assert.equal(manifest.start_url, app.startUrl);
    assert.equal(manifest.id, `/apps/${app.id}`);
    assert.equal(manifest.icons.length, 3);
    assert.deepEqual(
      manifest.icons.map((icon) => icon.sizes),
      ["192x192", "512x512", "512x512"],
    );
    assert.equal(manifest.icons[2].purpose, "maskable");
    assert.ok(
      manifest.icons.every(
        (icon) =>
          icon.src.startsWith(`/apps/${app.id}/icon/`) &&
          icon.type === "image/png",
      ),
    );
    ids.add(manifest.id);
    manifests.add(pwaManifestUrl(app.id));
  }
  assert.equal(ids.size, 8);
  assert.equal(manifests.size, 8);
  assert.equal(pwaApp("__proto__"), null);
  assert.equal(pwaApp("QStudy"), null);
  assert.equal(pwaIconUrl("qstudy", 180), "/apps/qstudy/icon/180.png");
});

test("Path and Q-ID return targets choose the project without accidental prefix or external matches", () => {
  for (const [pathname, id] of [
    ["/", "qforce"],
    ["/developers", "qforce"],
    ["/qstudy", "qstudy"],
    ["/dashboard", "qstudy"],
    ["/dashboard/groups/1/courses/2", "qstudy"],
    ["/qball/play", "qball"],
    ["/qcareer/workspace", "qcareer"],
    ["/qtests/library", "qtests"],
    ["/qmessage/chats", "qmessage"],
    ["/qcontrol/accounts", "qcontrol"],
    ["/login", "qid"],
    ["/register", "qid"],
    ["/qtests-lookalike", "qforce"],
    ["/dashboard2", "qforce"],
  ])
    assert.equal(pwaAppForPath(pathname).id, id, pathname);
  for (const pathname of [
    "/login",
    "/register",
    "/forgot-password",
    "/reset-password",
  ]) {
    assert.equal(
      pwaAppForPath(pathname, "/qmessage/chats?chat=1").id,
      "qmessage",
    );
    assert.equal(
      pwaAppForPath(pathname, "/qcontrol?tab=accounts").id,
      "qcontrol",
    );
    for (const target of [
      "//evil.test/qcontrol",
      "https://evil.test/qcontrol",
      "/\\evil.test/qcontrol",
      "/qcontrol\n",
      "/qcontrol-other",
      "/login?next=/qball/play",
    ])
      assert.equal(pwaAppForPath(pathname, target).id, "qid", target);
  }
});
