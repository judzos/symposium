/**
 * The service worker — mobile-spec.md §7, phase 5.
 *
 * `/symposium/` and `c46d9695` are substituted at emit time by pwa/dist/index.js.
 *
 * This is the one piece of the spec that can break the site for a reader who
 * has already installed it, and the hardest to take back, so the design is
 * biased hard toward "cannot serve something stale" over "caches the most".
 *
 * ONE DEVIATION FROM §7, deliberate. The spec asks for the shell to be
 * precached on install from a baked-in file list. That list cannot be built
 * honestly: emitters run in `Promise.all` (processors/emit.ts), so at the
 * moment this file is written the hashed names of index.css and postscript.js
 * do not exist yet, and anything this plugin guessed would go stale silently
 * the first time a hash changed — the exact failure the spec's versioning
 * section is trying to prevent.
 *
 * Runtime caching gets the same result without the lie. Quartz already
 * content-hashes every shell asset (`index-23bcb0d8.css`), so a new build
 * produces new URLs, which are simply cache misses and are fetched. Nothing has
 * to be invalidated because nothing is ever overwritten. The only thing lost
 * versus precaching is the reader who installs the app and goes offline without
 * ever opening it — who has nothing cached either way, because they have not
 * downloaded the site.
 *
 * The three tiers of §7 survive intact:
 *   Tier 1  shell assets   cache-first (immutable: the hash is in the name)
 *   Tier 2  pages          network-first, LRU-capped, offline.html as fallback
 *   Tier 3  contentIndex   cache-first + background revalidate — this is what
 *                          kills the 2.8 MB per-load cost and makes search work
 *                          offline, which is the actual point on a phone.
 *
 * TO DISABLE THIS WORKER, if it ever misbehaves in the wild: replace the body
 * of this file with `self.registration.unregister()` inside an `activate`
 * handler and deploy. Installed clients pick it up on their next load and drop
 * out of SW control. Do not simply delete sw.js — a 404 leaves the previously
 * installed worker running forever.
 */

const BASE = "/symposium/"
const VERSION = "c46d9695"

const SHELL = `shell-${VERSION}`
const PAGES = `pages-${VERSION}`
const DATA = `data-${VERSION}`
const KEEP = new Set([SHELL, PAGES, DATA])

const OFFLINE = `${BASE}offline.html`
const INDEX = `${BASE}static/contentIndex.json`
const LIVE_DATA = new Set([
  `${BASE}static/cards.json`,
  `${BASE}static/graph.json`,
  `${BASE}static/sync-config.json`,
  `${BASE}static/supabase.js`,
])

// ~100 pages ≈ 3 MB at this wiki's median page weight. The cap exists so a
// reader who browses for an hour does not silently accumulate the whole site.
const PAGE_LIMIT = 100

self.addEventListener("install", (event) => {
  // Only offline.html is precached: it is the one asset that must exist before
  // the reader has ever needed it, and this plugin emits it, so its URL is
  // known here rather than guessed.
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.add(new Request(OFFLINE, { cache: "reload" })))
      .catch(() => {}),
  )
  // No skipWaiting: §7 is explicit that a worker must never take over under a
  // reader mid-article. The page offers a reload instead, and the reader
  // chooses when.
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys()
      await Promise.all(names.filter((n) => !KEEP.has(n)).map((n) => caches.delete(n)))
      await self.clients.claim()
    })(),
  )
})

// The page asks for this when the reader accepts the reload prompt.
self.addEventListener("message", (event) => {
  if (event.data === "skip-waiting") self.skipWaiting()
})

/** Keep a cache to `limit` entries, oldest first. cache.keys() is insertion-ordered. */
async function trim(cache, limit) {
  const keys = await cache.keys()
  if (keys.length <= limit) return
  await Promise.all(keys.slice(0, keys.length - limit).map((k) => cache.delete(k)))
}

/** Immutable by construction: the build puts a content hash in the filename. */
function isHashedAsset(url) {
  return /-[0-9a-f]{8}\.(css|js)$/.test(url.pathname) || url.pathname.includes(`${BASE}static/`)
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  if (hit) return hit
  const res = await fetch(request)
  if (res.ok) cache.put(request, res.clone())
  return res
}

/** Cache-first, but refresh in the background so the next load is current. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName)
  const hit = await cache.match(request)
  const network = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone())
      return res
    })
    .catch(() => undefined)
  return hit ?? (await network) ?? Response.error()
}

/** Reader state inputs must be current online, with the cache used only offline. */
async function networkFirstData(request) {
  const cache = await caches.open(DATA)
  try {
    const res = await fetch(request)
    if (res.ok) cache.put(request, res.clone())
    return res
  } catch {
    return (await cache.match(request)) ?? Response.error()
  }
}

/** A live wiki stays live: the cache is the safety net, never the source. */
async function networkFirst(request) {
  const cache = await caches.open(PAGES)
  try {
    const res = await fetch(request)
    if (res.ok) {
      cache.put(request, res.clone())
      trim(cache, PAGE_LIMIT)
    }
    return res
  } catch {
    const hit = await cache.match(request)
    if (hit) return hit
    const shell = await caches.open(SHELL)
    return (await shell.match(OFFLINE)) ?? Response.error()
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event
  if (request.method !== "GET") return

  const url = new URL(request.url)
  const sameOrigin = url.origin === self.location.origin

  // Fonts are cross-origin (fonts.gstatic.com) but CORS-enabled, so they cache
  // normally and are worth having offline. Everything else cross-origin is left
  // to the network — this worker has no business proxying other people's sites,
  // and every source page links to one.
  if (!sameOrigin) {
    if (url.hostname === "fonts.gstatic.com" || url.hostname === "fonts.googleapis.com") {
      event.respondWith(cacheFirst(request, SHELL))
    }
    return
  }

  // Never cache anything outside our own subpath: the origin may serve other
  // projects, and a worker at /symposium/ has no claim on them.
  if (!url.pathname.startsWith(BASE)) return

  if (url.pathname === INDEX) {
    event.respondWith(staleWhileRevalidate(request, DATA))
    return
  }

  // These generated files keep stable names but change between builds. They
  // are not immutable shell assets merely because they live under /static/.
  if (LIVE_DATA.has(url.pathname)) {
    event.respondWith(networkFirstData(request))
    return
  }

  if (isHashedAsset(url)) {
    event.respondWith(cacheFirst(request, SHELL))
    return
  }

  if (request.mode === "navigate" || request.destination === "document") {
    event.respondWith(networkFirst(request))
  }
})
