/* Bahandi service worker — installable PWA shell (Prompt 23.1) +
 * offline-first capture support (Prompt 7).
 *
 * Caching policy (safe, never serves stale data):
 *   - Static assets (/_next/static/**, /icons/**, /manifest.webmanifest, fonts)
 *     → cache-first. These are content-hashed by the bundler or versioned by
 *     CACHE_VERSION, so serving from cache is always correct.
 *   - Navigations → network-first. Falls back to the last cached HTML, then to
 *     the precached /offline shell — only when the network is truly gone.
 *   - Other same-origin GETs (API / RSC data) → network-first with a cache
 *     fallback, so users never see stale data while online.
 *   - Cross-origin requests (Supabase REST / Storage) and non-GET requests
 *     (Server Actions, photo uploads) are NEVER intercepted — the SW only
 *     proxies same-origin GETs. The IndexedDB capture queue (P7) therefore
 *     owns all writes; this SW only nudges clients to flush on reconnect.
 *
 * CACHE_VERSION busts every cache on activate when bumped, so a new deploy
 * can never be hidden behind a stale shell.
 */

const CACHE_VERSION = "v3";
const SHELL_CACHE = `bahandi-shell-${CACHE_VERSION}`;
const ASSET_CACHE = `bahandi-assets-${CACHE_VERSION}`;
const FLUSH_SYNC_TAG = "bahandi-flush";
const OFFLINE_URL = "/offline";

const KEEP_CACHES = new Set([SHELL_CACHE, ASSET_CACHE]);

// Precached on install so the offline shell is available before the first
// navigation failure. Best-effort: a single failed fetch never aborts install.
const PRECACHE_URLS = [OFFLINE_URL];

// ── install ──────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      await Promise.all(
        PRECACHE_URLS.map((url) =>
          shell.add(new Request(url, { cache: "reload" })).catch(() => {}),
        ),
      );
      await self.skipWaiting();
    })(),
  );
});

// ── activate: drop every cache from a previous version, then claim clients ──
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((k) => !KEEP_CACHES.has(k)).map((k) => caches.delete(k)),
      );
      await self.clients.claim();
    })(),
  );
});

// ── fetch ────────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const req = event.request;

  // Never intercept writes — Server Actions, photo uploads, etc. stay on the
  // network and are owned by the IndexedDB capture queue (P7).
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Cross-origin (Supabase API / Storage) is never proxied or cached.
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first → cached shell → /offline.
  if (req.mode === "navigate") {
    event.respondWith(networkFirstNavigation(req));
    return;
  }

  // Static, content-addressed assets: cache-first.
  if (isStaticAsset(url.pathname)) {
    event.respondWith(cacheFirst(req, ASSET_CACHE));
    return;
  }

  // Same-origin data/API GETs: network-first with cache fallback.
  event.respondWith(networkFirstData(req));
});

function isStaticAsset(pathname) {
  return (
    pathname.startsWith("/_next/static/") ||
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest" ||
    /\.(?:woff2?|ttf|otf|eot)$/i.test(pathname)
  );
}

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200 && res.type === "basic") {
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (_err) {
    return cached || Response.error();
  }
}

async function networkFirstNavigation(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    cache.put(req, fresh.clone()).catch(() => {});
    return fresh;
  } catch (_err) {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    const offline = await cache.match(OFFLINE_URL);
    if (offline) return offline;
    return new Response(offlineFallbackHtml(), {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    });
  }
}

async function networkFirstData(req) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const fresh = await fetch(req);
    if (fresh && fresh.status === 200 && fresh.type === "basic") {
      cache.put(req, fresh.clone()).catch(() => {});
    }
    return fresh;
  } catch (_err) {
    const cached = await cache.match(req);
    if (cached) return cached;
    return Response.error();
  }
}

// Last-resort offline document if /offline was never precached.
function offlineFallbackHtml() {
  return (
    "<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width,initial-scale=1'>" +
    "<title>Нет соединения</title><style>" +
    "body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;" +
    "background:#F6F8F7;font-family:Nunito,system-ui,sans-serif;color:#1A1A1A;padding:1.5rem}" +
    ".c{max-width:26rem;text-align:center;background:#fff;border-radius:16px;padding:1.25rem 1.5rem;" +
    "box-shadow:0 1px 2px rgba(16,24,20,.04),0 8px 24px rgba(16,24,20,.06)}" +
    ".m{width:3.5rem;height:3.5rem;margin:0 auto 1rem;border-radius:.75rem;background:#16A34A;color:#fff;" +
    "font-weight:800;font-size:1.75rem;line-height:3.5rem}.t{margin:0 0 .5rem;font-size:1.25rem}" +
    ".b{margin:0;color:#6B7280;font-size:.9375rem;line-height:1.5}" +
    "</style><main class=c><div class=m>E</div><h1 class=t>Нет соединения</h1>" +
    "<p class=b>Подключитесь к сети и обновите страницу. Ваши списания сохранены " +
    "и будут отправлены автоматически.</p></main>"
  );
}

// ── Background Sync (P7): nudge clients to flush the IDB queue on reconnect ──
self.addEventListener("sync", (event) => {
  if (event.tag === FLUSH_SYNC_TAG) {
    event.waitUntil(broadcastToClients({ type: "FLUSH" }));
  }
});

// Portable flush trigger for browsers without Background Sync.
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "TRIGGER_FLUSH") {
    event.waitUntil(broadcastToClients({ type: "FLUSH" }));
  }
});

async function broadcastToClients(message) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  await Promise.all(clients.map((c) => c.postMessage(message)));
}
