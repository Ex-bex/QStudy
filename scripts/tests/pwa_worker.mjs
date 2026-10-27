/** Execute the shipped service worker against a disposable CacheStorage model. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = fileURLToPath(new URL("../../", import.meta.url));
const source = await readFile(new URL("../../frontend/public/sw.js", import.meta.url), "utf8");
const origin = "https://qforce.example";
const OFFLINE = "GENERIC_OFFLINE_PAGE_WITHOUT_USER_DATA";
const callbacks = new Map();
const stores = new Map([
  ["qforce-pwa-ancient", new Map([[`${origin}/old.html`, new Response("OLD")]])],
  ["unrelated-product-cache", new Map([[`${origin}/unrelated`, new Response("DO_NOT_DELETE")]])],
]);
const fetches = [];
const writes = [];
const deleted = [];
let failing = false;
let status = 200;
let claims = 0;
let skipWaits = 0;

function key(input) {
  return new URL(typeof input === "string" ? input : input.url, origin).href;
}
async function fetchModel(input, init) {
  fetches.push({url:key(input), init});
  if (failing) throw new TypeError("Disposable network failure");
  return new Response(key(input).endsWith("/offline.html") ? OFFLINE : "PRIVATE_NETWORK_PAGE", {status});
}
const caches = {
  async keys() { return [...stores.keys()]; },
  async delete(name) { deleted.push(name); return stores.delete(name); },
  async open(name) {
    if (!stores.has(name)) stores.set(name, new Map());
    const cache = stores.get(name);
    return {
      async put(input, response) { writes.push(key(input)); cache.set(key(input), response.clone()); },
      async match(input) { return cache.get(key(input))?.clone(); },
      async add(input) { const response = await fetchModel(input); assert(response.ok); writes.push(key(input)); cache.set(key(input), response); },
      async addAll(inputs) { for (const input of inputs) await this.add(input); },
    };
  },
  async match(input) {
    for (const cache of stores.values()) if (cache.has(key(input))) return cache.get(key(input)).clone();
  },
};
class RelativeRequest extends Request {
  constructor(input, init) { super(key(input), init); }
}
const serviceWorker = {
  location:new URL(`${origin}/sw.js`),
  addEventListener(type, callback) { callbacks.set(type, callback); },
  skipWaiting() { skipWaits++; return Promise.resolve(); },
  clients:{claim() { claims++; return Promise.resolve(); }},
  caches,
};
vm.runInNewContext(source, {
  self:serviceWorker, caches, fetch:fetchModel, URL, Request:RelativeRequest,
  Response, Headers, Promise, console, setTimeout, clearTimeout,
}, {filename:`${root}frontend/public/sw.js`});

async function lifecycle(type) {
  assert.equal(typeof callbacks.get(type), "function", `${type} handler missing`);
  const pending = [];
  callbacks.get(type)({waitUntil(value) { pending.push(Promise.resolve(value)); }});
  await Promise.all(pending);
}
async function request(path, {mode="navigate", method="GET", destination="document"}={}) {
  const pending = [];
  let response;
  let handled = false;
  callbacks.get("fetch")({
    request:{url:new URL(path,origin).href, mode, method, destination, headers:new Headers()},
    respondWith(value) { assert.equal(handled,false,"Fetch was intercepted twice"); handled=true; response=Promise.resolve(value); },
    waitUntil(value) { pending.push(Promise.resolve(value)); },
  });
  const result = handled ? await response : undefined;
  await Promise.all(pending);
  return {handled, response:result};
}
function assertOnlyGenericCacheWrites() {
  assert(writes.length>0,"Offline fallback was not precached");
  assert(writes.every(url=>url===`${origin}/offline.html`),"Worker stored a private page, API, account or attachment response");
}

await lifecycle("install");
assertOnlyGenericCacheWrites();
assert([...stores.values()].some(cache=>cache.has(`${origin}/offline.html`)));
await lifecycle("activate");
assert(deleted.includes("qforce-pwa-ancient"),"Old owned cache was not removed");
assert(stores.has("unrelated-product-cache"),"Activation deleted another application's cache");
assert.equal(claims,1,"New worker did not claim its clients");

for (const path of ["/dashboard", "/qmessage/chats", "/qcontrol", "/login?next=%2Fqcontrol"]) {
  const result = await request(path);
  assert(result.handled,`Navigation did not use network-first flow: ${path}`);
  assert.equal(await result.response.text(),"PRIVATE_NETWORK_PAGE");
  assertOnlyGenericCacheWrites();
}

const ignored = [
  ["/api/auth/me",{}], ["/api/qmessage/attachments/77",{}],
  ["/api/admin/system/exports/project/download",{}],
  ["/api/auth/me",{mode:"cors",destination:""}],
  ["/api/qmessage/conversations",{mode:"cors",destination:""}],
  ["/api/branding/assets/qforce/"+"a".repeat(64)+".png",{mode:"no-cors",destination:"image"}],
  ["/dashboard?_rsc=fixture",{mode:"cors",destination:""}],
  ["/_next/static/fixture.js",{mode:"no-cors",destination:"script"}],
  ["https://another.example/document",{}],
  ["/login",{method:"POST"}],
];
for (const [path, options] of ignored) {
  const before=fetches.length;
  const result = await request(path, options);
  assert.equal(result.handled,false,`Worker intercepted a private API, mutation, cross-origin or non-navigation request: ${path}`);
  assert.equal(fetches.length,before,"An ignored request performed a worker fetch");
}

status=503;
let result=await request("/dashboard");
assert.equal(result.response.status,503,"Worker replaced a real server error with cached success");
assert.equal(await result.response.text(),"PRIVATE_NETWORK_PAGE");
status=200; failing=true;
for (const path of ["/dashboard", "/qmessage/chats", "/qcontrol"]) {
  result=await request(path);
  assert(result.handled,"Offline navigation was not handled");
  assert.equal(await result.response.text(),OFFLINE,"Offline page exposed a prior authenticated response");
}
assertOnlyGenericCacheWrites();
assert.equal(await stores.get("unrelated-product-cache").get(`${origin}/unrelated`).text(),"DO_NOT_DELETE");
console.log(`PASS: actual service worker; generic offline install/cache, owned cache cleanup, ${claims} client claim, ${skipWaits} skipWaiting; private pages always network, failed navigation receives generic offline page, API/images/RSC/scripts/mutations/cross-origin bypass, real HTTP errors preserved; no account or correspondence data cached.`);
