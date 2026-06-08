<script>
    import { disableQueries, enableQueries } from './agent.js'
    import { buildAppHtml } from './app-html.js'
    import { setLiveIframe } from './pyodide.js'
    import { sessionStore } from './sessions.js'
    import { read as readAppStorage, write as writeAppStorage } from './app-storage.js'
    import { getActiveAdapter } from './active-adapter.js'
    import { APPS_ORIGIN, isFromAppFrame, replyToApp } from './apps-origin.js'
    import {
        notificationsSupported,
        notificationPermission,
        requestNotificationPermission,
        showAppNotification,
    } from './notify.js'
    import { onMount } from 'svelte'

    /** @type {{ refreshKey: number }} */
    let { refreshKey } = $props()

    let iframe = $state(null)
    /** Cache-busted apps-origin URL the iframe loads to fetch the
     *  bootloader. Bumped on every `loadPreview` so the bootloader
     *  reloads cleanly (same-URL navigation would be a no-op). */
    let appsUrl = $state(null)
    /** App HTML waiting to be sent to the iframe via `agex-host-init`
     *  once the bootloader posts its `agex-host-ready` signal.
     *  Cleared after one successful init; a stale ready (from an
     *  earlier load attempt that resolved after a newer one started)
     *  finds `pendingHtml === null` and is ignored. */
    let pendingHtml = null
    let loading = $state(false)
    let error = $state('')

    // True once the iframe fires `onload` (HTML parsed + initial
    // scripts executed) or the app sends its first postMessage,
    // whichever happens first. Used to keep a spinner overlay visible
    // while the iframe is still blank-white during its own boot.
    let iframeReady = $state(false)
    let iframeReadyTimer = null

    // The (kernel, branch, adapter) this iframe was built against.
    // App-storage writes posted from the iframe are persisted under
    // this pair, not the live $sessionStore.currentBranch — preserves
    // correct routing if the user switches sessions mid-flight. The
    // adapter is captured once at loadPreview time so the synchronous
    // query-message handler can dispatch without an extra await.
    let appBranch = ''
    let appKernel = 'py'
    /** @type {import('./kernel-adapter.js').KernelAdapter | null} */
    let appAdapter = null
    let pendingStorageData = null
    let storageFlushTimer = null
    const STORAGE_FLUSH_MS = 300

    function scheduleStorageFlush(kernel, branch, data) {
        pendingStorageData = data
        if (storageFlushTimer) return
        storageFlushTimer = setTimeout(() => {
            const toWrite = pendingStorageData
            pendingStorageData = null
            storageFlushTimer = null
            try {
                writeAppStorage(kernel, branch, toWrite)
            } catch (err) {
                console.warn('[agex] app storage flush failed:', err)
            }
        }, STORAGE_FLUSH_MS)
    }

    // Flood detection: trip if we see more than FLOOD_THRESHOLD agex-query
    // messages within FLOOD_WINDOW_MS. 30 in 2s (15/sec sustained) is well
    // above a legit mount burst but well below a render loop.
    const FLOOD_WINDOW_MS = 2000
    const FLOOD_THRESHOLD = 30
    const SAMPLE_LIMIT = 5

    let queryTimestamps = []
    /** @type {Array<{ code: string, count: number }>} */
    let querySamples = []
    let mountTime = 0

    /** @type {null | { rate: number, totalInWindow: number, timeToFreezeMs: number | null, samples: Array<{ code: string, count: number }> }} */
    let frozen = $state(null)
    let copyLabel = $state('Copy report for agent')

    function resetTracking() {
        queryTimestamps = []
        querySamples = []
        mountTime = 0
        frozen = null
        copyLabel = 'Copy report for agent'
    }

    function recordQuery(code) {
        const now = performance.now()
        queryTimestamps.push(now)
        const cutoff = now - FLOOD_WINDOW_MS
        while (queryTimestamps.length && queryTimestamps[0] < cutoff) {
            queryTimestamps.shift()
        }

        // Dedupe samples by code, newest-last, cap at SAMPLE_LIMIT entries
        const trimmed = (code || '').trim().slice(0, 240)
        const existing = querySamples.find(s => s.code === trimmed)
        if (existing) {
            existing.count++
        } else {
            querySamples.push({ code: trimmed, count: 1 })
            if (querySamples.length > SAMPLE_LIMIT) querySamples.shift()
        }

        return queryTimestamps.length
    }

    function triggerFreeze() {
        if (frozen) return
        const now = performance.now()
        const rate = Math.round(queryTimestamps.length / (FLOOD_WINDOW_MS / 1000))
        frozen = {
            rate,
            totalInWindow: queryTimestamps.length,
            timeToFreezeMs: mountTime ? Math.round(now - mountTime) : null,
            samples: [...querySamples].reverse(),
        }

        // Stop the bridge immediately so queued queries short-circuit
        // instead of draining through the worker.
        disableQueries()

        // Tear down the iframe: kill any running JS, unregister as live.
        setLiveIframe(null)
        try {
            if (iframe) iframe.src = 'about:blank'
        } catch {}
        appsUrl = null
        pendingHtml = null

        console.warn(
            `[agex] Preview auto-paused: ${rate} queries/sec ` +
            `(${frozen.totalInWindow} in ${FLOOD_WINDOW_MS / 1000}s` +
            (frozen.timeToFreezeMs != null ? `, ${frozen.timeToFreezeMs}ms after mount` : '') +
            ')'
        )
    }

    function buildReport() {
        if (!frozen) return ''
        const lines = [
            '**App preview auto-paused: query bridge flood detected**',
            '',
            `- Rate: ~${frozen.rate} queries/sec`,
            `- Total in ${FLOOD_WINDOW_MS / 1000}s window: ${frozen.totalInWindow}`,
        ]
        if (frozen.timeToFreezeMs != null) {
            lines.push(`- Time from mount to freeze: ${frozen.timeToFreezeMs}ms`)
        }
        lines.push('', 'Recent query samples (newest first):')
        frozen.samples.forEach((s, i) => {
            const count = s.count > 1 ? ` (×${s.count})` : ''
            lines.push(`${i + 1}. \`${s.code}\`${count}`)
        })
        lines.push(
            '',
            'Likely cause: a `useEffect`, render-phase `query()`, or interval firing',
            'without proper dependency guards. Please find and fix the infinite loop.',
        )
        return lines.join('\n')
    }

    async function handleCopy() {
        try {
            await navigator.clipboard.writeText(buildReport())
            copyLabel = 'Copied'
            setTimeout(() => { copyLabel = 'Copy report for agent' }, 1500)
        } catch {
            copyLabel = 'Copy failed'
            setTimeout(() => { copyLabel = 'Copy report for agent' }, 1500)
        }
    }

    async function loadPreview() {
        iframeReady = false
        // A fresh bootloader load is about to re-install the bridge, so
        // clear any "navigated/dead" mark left by an in-app location.reload
        // — otherwise sendControl would keep bailing on the rebuilt iframe.
        if (iframe) iframe.__navigated = false
        if (iframeReadyTimer) {
            clearTimeout(iframeReadyTimer)
            iframeReadyTimer = null
        }
        resetTracking()
        enableQueries()

        loading = true
        error = ''
        try {
            const { adapter, branch, kernel } = await getActiveAdapter()
            appAdapter = adapter
            appBranch = branch
            appKernel = kernel
            // Read text files + binary assets in parallel — the
            // two are independent fs walks within the adapter and
            // don't need to serialize. Binaries get inlined as data
            // URLs by `buildAppHtml` so `<img>` / CSS / `fetch`
            // refs in agent app code resolve inside the sandboxed
            // iframe (which has no meaningful base path under blob:).
            const [appFiles, appBinaries] = await Promise.all([
                adapter.readAppFiles(branch),
                adapter.readAppBinaries(branch),
            ])
            if (!appFiles || Object.keys(appFiles).length === 0) {
                error = 'No app files found'
                return
            }

            const seed = branch ? readAppStorage(kernel, branch) : {}
            const html = buildAppHtml(appFiles, {
                appBinaries,
                appStorage: { seed, writeable: true },
            })

            // Stash the HTML for the upcoming `agex-host-ready`
            // handshake, then cache-bust the apps-origin URL so the
            // iframe reloads the bootloader. The bootloader will post
            // ready, our handleMessage will respond with `agex-host-
            // init { html: pendingHtml }`, and the bootloader writes
            // it into the iframe document.
            pendingHtml = html
            appsUrl = `${APPS_ORIGIN}/?t=${Date.now()}`
            mountTime = performance.now()
        } catch (e) {
            error = e.message || String(e)
        } finally {
            loading = false
        }
    }

    // In-flight iframe-initiated spawn calls, keyed by message id, so an
    // `agex-cancel-spawn` from the app can abort the right clone (e.g. a
    // "Stop thinking" button).
    const spawnControllers = new Map()

    // Rate cap for app-requested notifications: a rolling window of
    // recent show-timestamps. Keeps a misbehaving (or buggy) app from
    // spamming the OS notification tray. Resets on reload (module-fresh).
    const NOTIFY_MAX = 5
    const NOTIFY_WINDOW_MS = 60_000
    let notifyTimes = []

    /** Host-mediate an app's notification request. The cross-origin
     *  sandbox can't construct Notifications or prompt for permission,
     *  so we do it here behind a rate cap and a permission re-check,
     *  then reply with whether it showed. */
    async function handleAppNotify(id, title, body) {
        const reply = (shown, reason) =>
            replyToApp(iframe, {
                type: 'agex-notify-result',
                id,
                shown,
                error: reason || null,
            })
        if (!notificationsSupported()) {
            reply(false, 'notifications are not supported in this browser')
            return
        }
        const now = Date.now()
        notifyTimes = notifyTimes.filter((t) => now - t < NOTIFY_WINDOW_MS)
        if (notifyTimes.length >= NOTIFY_MAX) {
            reply(false, 'notification rate limit reached — try again shortly')
            return
        }
        // Prompt only when the user hasn't decided yet. A hard "denied"
        // can't be undone from script — surface it so the app can fall
        // back to in-page UI.
        let perm = notificationPermission()
        if (perm === 'default') perm = await requestNotificationPermission()
        if (perm !== 'granted') {
            reply(false, 'notification permission not granted')
            return
        }
        notifyTimes.push(now)
        const shown = showAppNotification({ title, body, branch: appBranch })
        reply(shown, shown ? null : 'failed to show notification')
    }

    // Handle ready / query / app-storage messages from the iframe
    function handleMessage(event) {
        if (frozen) return
        // Only accept messages from the app iframe's window at the apps
        // origin — defends against other tabs / extensions posting
        // crafted payloads. See isFromAppFrame in apps-origin.js.
        if (!isFromAppFrame(event, iframe)) return

        // Bootloader handshake: respond with the pending app HTML.
        // A stale ready (from an earlier load whose iframe finished
        // booting after we started a newer load) sees pendingHtml ===
        // null and is dropped; that's correct — the newer load will
        // trigger its own reload + ready.
        if (event.data?.type === 'agex-host-ready') {
            if (pendingHtml === null) return
            replyToApp(iframe, { type: 'agex-host-init', html: pendingHtml })
            pendingHtml = null
            return
        }

        if (event.data?.type === 'agex-app-storage') {
            if (appBranch) scheduleStorageFlush(appKernel, appBranch, event.data.data || {})
            return
        }

        if (event.data?.type === 'agex-iframe-resource-error') {
            console.warn(
                `[iframe resource error] <${event.data.tag} ${event.data.attr}="${event.data.url}">`,
                { outerHTML: event.data.outerHTML },
            )
            return
        }

        if (event.data?.type === 'agex-cache-get') {
            // Lighter-weight than `agex-query`: just a cache lookup, no
            // code execution. Wired separately so the freeze /
            // flood-detection logic stays scoped to runQuery's broader
            // surface area.
            if (!iframeReady) iframeReady = true
            const { id, key } = event.data
            if (!appAdapter) {
                replyToApp(iframe, {
                    type: 'agex-cache-get-result',
                    id,
                    data: null,
                    error: 'app preview adapter not ready',
                })
                return
            }
            appAdapter.getCacheValue(appBranch, key)
                .then(data => {
                    replyToApp(iframe, {
                        type: 'agex-cache-get-result',
                        id,
                        data: data === undefined ? null : data,
                        error: null,
                    })
                })
                .catch(err => {
                    replyToApp(iframe, {
                        type: 'agex-cache-get-result',
                        id,
                        data: null,
                        error: err.message || String(err),
                    })
                })
            return
        }

        if (event.data?.type === 'agex-spawn') {
            // App-initiated spawn. Origin + source already validated at
            // the top of this handler. The app passes a full SpawnSpec
            // inline. Records nothing to the chat narrative (app runtime,
            // not a chat turn) — the host-side `spawnFromApp` enforces the
            // cost cap and strips `view`. Per-call AbortController lets the
            // app cancel via `agex-cancel-spawn`.
            if (!iframeReady) iframeReady = true
            const { id, spec } = event.data
            if (!appAdapter || typeof appAdapter.spawn !== 'function') {
                replyToApp(iframe, {
                    type: 'agex-spawn-error',
                    id,
                    error: 'spawn is not available on this kernel',
                })
                return
            }
            const ac = new AbortController()
            spawnControllers.set(id, ac)
            appAdapter.spawn(appBranch, spec, ac.signal)
                .then(data => {
                    replyToApp(iframe, {
                        type: 'agex-spawn-result',
                        id,
                        data: data === undefined ? null : data,
                    })
                })
                .catch(err => {
                    replyToApp(iframe, {
                        type: 'agex-spawn-error',
                        id,
                        error: err?.message || String(err),
                    })
                })
                .finally(() => spawnControllers.delete(id))
            return
        }

        if (event.data?.type === 'agex-cancel-spawn') {
            const ac = spawnControllers.get(event.data.id)
            if (ac) ac.abort()
            return
        }

        if (event.data?.type === 'agex-notify') {
            // App-requested desktop notification. Origin + source already
            // validated above. Host-mediated because the sandbox can't
            // construct Notifications or prompt for permission itself.
            if (!iframeReady) iframeReady = true
            const { id, title, body } = event.data
            void handleAppNotify(id, title, body)
            return
        }

        if (event.data?.type !== 'agex-query') return

        // Any postMessage from the iframe means app JS is running.
        if (!iframeReady) iframeReady = true

        const { id, code, result } = event.data
        const countInWindow = recordQuery(code || '')
        if (countInWindow > FLOOD_THRESHOLD) {
            triggerFreeze()
            return
        }

        if (!appAdapter) {
            // Iframe sent a query before the adapter was captured —
            // shouldn't happen in practice (query messages only fire
            // after the iframe loads, which is after loadPreview's
            // adapter capture), but be defensive.
            replyToApp(iframe, {
                type: 'agex-query-result',
                id,
                data: null,
                error: 'app preview adapter not ready',
            })
            return
        }
        appAdapter.runQuery(appBranch, code, result)
            .then(data => {
                replyToApp(iframe, {
                    type: 'agex-query-result',
                    id,
                    data,
                    error: null,
                })
            })
            .catch(err => {
                const msg = err.message || String(err)
                // Downstream mutex escalated (backlog cap or disabled) —
                // trip the freeze so the user sees the report, not a
                // silent stream of console errors.
                if (msg.includes('backlog full') || msg.includes('disabled')) {
                    triggerFreeze()
                    return
                }
                replyToApp(iframe, {
                    type: 'agex-query-result',
                    id,
                    data: null,
                    error: msg,
                })
            })
    }

    onMount(() => {
        window.addEventListener('message', handleMessage)
        return () => {
            window.removeEventListener('message', handleMessage)
            setLiveIframe(null)
            // Flush any pending storage writes synchronously so the
            // user doesn't lose the last few writes on unmount/reload.
            if (storageFlushTimer) {
                clearTimeout(storageFlushTimer)
                storageFlushTimer = null
                if (pendingStorageData !== null && appBranch) {
                    try { writeAppStorage(appKernel, appBranch, pendingStorageData) } catch {}
                }
                pendingStorageData = null
            }
        }
    })

    // Register the live iframe with pyodide.js for live_app(). When
    // frozen, the iframe is about:blank so un-register.
    $effect(() => {
        setLiveIframe(frozen ? null : iframe)
    })

    // Reload when refreshKey changes
    $effect(() => {
        void refreshKey
        loadPreview()
    })
</script>

<div class="preview-panel">
    {#if loading}
        <div class="preview-notice"><span class="spinner"></span> Loading...</div>
    {:else if frozen}
        <div class="preview-frozen">
            <div class="frozen-header">
                <h3>Preview paused</h3>
                <p class="frozen-subtitle">
                    App was making ~{frozen.rate} <code>query()</code> calls per second{#if frozen.timeToFreezeMs != null} within {frozen.timeToFreezeMs}ms of mount{/if}.
                    This usually means a render loop or a <code>useEffect</code>
                    without proper dependency guards.
                </p>
            </div>

            {#if frozen.samples.length > 0}
                <div class="frozen-samples">
                    <div class="frozen-samples-label">Recent query samples</div>
                    {#each frozen.samples as s, i}
                        <div class="frozen-sample">
                            <span class="frozen-sample-idx">{i + 1}.</span>
                            <code>{s.code}</code>
                            {#if s.count > 1}<span class="frozen-sample-count">×{s.count}</span>{/if}
                        </div>
                    {/each}
                </div>
            {/if}

            <div class="frozen-actions">
                <button onclick={handleCopy}>{copyLabel}</button>
                <div class="frozen-hint">
                    Paste into chat so the agent can fix the loop,
                    then use the reload button in the header.
                </div>
            </div>
        </div>
    {:else if error}
        <div class="preview-notice error">{error}</div>
    {:else if appsUrl}
        <div class="iframe-wrap">
            <!--
                Cross-origin iframe pointing at the apps sandbox host
                (apps.agex.studio in prod; see APPS_ORIGIN). The
                sandbox attribute is intentionally absent — the
                cross-origin separation provides the isolation that
                `sandbox="allow-scripts"` used to. The `allow` list
                still applies (Permissions Policy delegations) since
                cross-origin iframes default to NOT delegating these
                features.
            -->
            <iframe
                bind:this={iframe}
                src={appsUrl}
                allow="autoplay; microphone; camera; geolocation; gyroscope; accelerometer; magnetometer; midi; fullscreen; screen-wake-lock; web-share; clipboard-write"
                title="App Preview"
                onload={() => {
                    // Fallback signal in case the app never sends a
                    // query() (static HTML, CSS-only demos, etc).
                    if (iframeReadyTimer) clearTimeout(iframeReadyTimer)
                    iframeReadyTimer = setTimeout(() => { iframeReady = true }, 100)
                }}
            ></iframe>
            {#if !iframeReady}
                <div class="iframe-overlay">
                    <span class="spinner"></span>
                </div>
            {/if}
        </div>
    {/if}
</div>

<style>
    .preview-panel {
        height: 100%;
        overflow: hidden;
        background: var(--bg);
    }

    .iframe-wrap {
        position: relative;
        width: 100%;
        height: 100%;
    }

    iframe {
        width: 100%;
        height: 100%;
        border: none;
        background: transparent;
    }

    .iframe-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--bg);
        pointer-events: none;
    }

    .preview-notice {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 100%;
        color: var(--text-muted);
        font-size: 0.85rem;
        gap: 0.5rem;
    }

    .preview-notice.error {
        color: var(--error);
    }

    .spinner {
        width: 14px;
        height: 14px;
        border: 2px solid var(--border);
        border-top-color: var(--text-muted);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    .preview-frozen {
        height: 100%;
        overflow-y: auto;
        padding: 1.25rem 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        color: var(--text);
        font-size: 0.85rem;
    }

    .frozen-header h3 {
        margin: 0 0 0.4rem 0;
        font-size: 0.95rem;
        color: var(--accent);
    }

    .frozen-subtitle {
        margin: 0;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .frozen-subtitle code {
        font-family: monospace;
        font-size: 0.8rem;
        background: var(--input-bg);
        padding: 0 0.25rem;
        border-radius: 3px;
    }

    .frozen-samples {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.6rem 0.75rem;
        background: var(--input-bg);
    }

    .frozen-samples-label {
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
        margin-bottom: 0.2rem;
    }

    .frozen-sample {
        display: flex;
        gap: 0.4rem;
        align-items: baseline;
        font-size: 0.75rem;
        line-height: 1.4;
    }

    .frozen-sample-idx {
        color: var(--text-muted);
        flex-shrink: 0;
    }

    .frozen-sample code {
        font-family: monospace;
        color: var(--text);
        word-break: break-all;
        flex: 1;
    }

    .frozen-sample-count {
        color: var(--accent);
        font-size: 0.7rem;
        flex-shrink: 0;
    }

    .frozen-actions {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .frozen-actions button {
        align-self: flex-start;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.5rem 0.9rem;
        font-family: inherit;
        font-size: 0.8rem;
        cursor: pointer;
    }

    .frozen-actions button:hover {
        filter: brightness(1.1);
    }

    .frozen-hint {
        color: var(--text-muted);
        font-size: 0.72rem;
        line-height: 1.4;
    }
</style>
