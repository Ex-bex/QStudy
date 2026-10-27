/* QForce PWA: no account data or authenticated resources are stored offline. */
const CACHE_PREFIX = "qforce-pwa-";
const CACHE_NAME = `${CACHE_PREFIX}v1`;
const OFFLINE_PATH = "/offline.html";
const OFFLINE_URL = new URL(OFFLINE_PATH, self.location.origin).href;

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const response = await fetch(OFFLINE_URL, { cache: "reload", credentials: "omit" });
    if (!response.ok || response.redirected) throw new Error("Offline page unavailable");
    const cache = await caches.open(CACHE_NAME);
    await cache.put(OFFLINE_URL, response);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME).map((name) => caches.delete(name)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  // Every navigation reaches the network. APIs, RSC fetches, images, documents,
  // messages and forms are never intercepted or written into Cache Storage.
  event.respondWith((async () => {
    try {
      return await fetch(request);
    } catch {
      const cached = await caches.match(OFFLINE_URL, { cacheName: CACHE_NAME });
      return cached || new Response("Нет подключения к интернету. Повторите попытку после подключения.", {
        status: 503,
        headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
  })());
});
