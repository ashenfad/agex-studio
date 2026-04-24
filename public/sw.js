/**
 * Service Worker: cache PyPI wheel fetches.
 *
 * Uses a cache-first strategy for requests to PyPI (files.pythonhosted.org)
 * so that micropip.install() doesn't re-download on every page load.
 */

// Bump the cache version whenever we want all clients to forget what
// they've cached (e.g. after a security fix in a vendor package).
const CACHE_NAME = "agex-assets-v2";

/** @param {string} url */
function isCacheable(url) {
    // PyPI wheels
    if (url.includes("files.pythonhosted.org")) return true;
    // PyPI package metadata JSON — micropip fetches this to resolve
    // versions on every cold load. Cache-first: the pinned wheel we
    // install is determined by the first resolution, and stale
    // metadata just means we stay on that version (acceptable trade).
    // The cache-bust query param (?v=...) on our own packages bumps
    // the cache key automatically when we cut a release.
    if (url.includes("pypi.org/pypi/")) return true;
    // Pyodide CDN (runtime, stdlib, built-in packages)
    if (url.includes("cdn.jsdelivr.net/pyodide/")) return true;
    return false;
}

self.addEventListener("install", () => {
    self.skipWaiting();
});

self.addEventListener("activate", (event) => {
    // Clean up old caches if cache version changes
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names
                    .filter((n) => n !== CACHE_NAME)
                    .map((n) => caches.delete(n))
            )
        )
    );
    self.clients.claim();
});

self.addEventListener("fetch", (event) => {
    if (!isCacheable(event.request.url)) return;

    event.respondWith(
        caches.open(CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request);
            if (cached) return cached;

            const response = await fetch(event.request);
            if (response.ok) {
                cache.put(event.request, response.clone());
            }
            return response;
        })
    );
});
