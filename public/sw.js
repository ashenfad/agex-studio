/**
 * Service Worker: cache PyPI wheel fetches.
 *
 * Uses a cache-first strategy for requests to PyPI (files.pythonhosted.org)
 * so that micropip.install() doesn't re-download on every page load.
 */

const CACHE_NAME = "agex-assets-v1";

/** @param {string} url */
function isCacheable(url) {
    // PyPI wheels
    if (url.includes("files.pythonhosted.org")) return true;
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
