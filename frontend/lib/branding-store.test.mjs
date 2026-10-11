import assert from "node:assert/strict";
import { test } from "node:test";
import { setImmediate } from "node:timers";
import { createBrandingStore } from "./branding-store.ts";

const fallback = {
  project_logo_url: "/brand/qforce_logo_main.png",
  project_logo_custom: false,
};
const custom = (letter) => ({
  project_logo_url: `/api/branding/assets/project/${letter.repeat(64)}.png`,
  project_logo_custom: true,
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("shared logo consumers deduplicate the initial fetch", async () => {
  const request = deferred();
  let calls = 0;
  const store = createBrandingStore(fallback, () => {
    calls += 1;
    return request.promise;
  });
  const first = store.refresh();
  assert.equal(store.refresh(), first);
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().branding, fallback);
  request.resolve(custom("a"));
  await first;
  assert.deepEqual(store.getSnapshot().branding, custom("a"));
  assert.equal(store.getSnapshot().loading, false);
});

test("cross-tab invalidation ignores the in-flight response and guarantees one fresh fetch", async () => {
  const oldRequest = deferred();
  const freshRequest = deferred();
  let calls = 0;
  const store = createBrandingStore(
    fallback,
    () => [oldRequest, freshRequest][calls++].promise,
  );
  const first = store.refresh();
  store.refresh(true);
  store.refresh(true);
  oldRequest.resolve(custom("a"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls, 2);
  assert.equal(store.getSnapshot().branding, fallback);
  freshRequest.resolve(custom("b"));
  await first;
  assert.deepEqual(store.getSnapshot().branding, custom("b"));
  assert.equal(calls, 2);
});

test("successful uploads update immediately and cannot be replaced by an older response", async () => {
  const request = deferred();
  const store = createBrandingStore(fallback, () => request.promise);
  const first = store.refresh();
  store.update(custom("b"));
  request.resolve(custom("a"));
  await first;
  assert.deepEqual(store.getSnapshot().branding, custom("b"));
});

test("metadata failure preserves the last logo and allows a later retry", async () => {
  let calls = 0;
  const store = createBrandingStore(fallback, async () => {
    if (calls++ === 0) throw new Error("Сервер временно недоступен");
    return custom("b");
  });
  await store.refresh();
  assert.equal(store.getSnapshot().branding, fallback);
  assert.equal(store.getSnapshot().loading, false);
  assert.ok(store.getSnapshot().error);
  await store.refresh(true);
  assert.deepEqual(store.getSnapshot().branding, custom("b"));
  assert.equal(store.getSnapshot().error, "");
});
