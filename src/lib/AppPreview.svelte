<script>
    import { disableQueries, enableQueries } from './agent.js'
    import { buildAppHtml, setLiveIframe } from './pyodide.js'
    import { sessionStore } from './sessions.js'
    import { read as readAppStorage, write as writeAppStorage } from './app-storage.js'
    import { getActiveAdapter } from './active-adapter.js'
    import { onMount } from 'svelte'

    /** @type {{ refreshKey: number }} */
    let { refreshKey } = $props()

    let iframe = $state(null)
    let blobUrl = $state(null)
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
        if (blobUrl) {
            URL.revokeObjectURL(blobUrl)
            blobUrl = null
        }

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
            const appFiles = await adapter.readAppFiles(branch)
            if (!appFiles || Object.keys(appFiles).length === 0) {
                error = 'No app files found'
                return
            }

            const seed = branch ? readAppStorage(kernel, branch) : {}
            const html = buildAppHtml(appFiles, {
                appStorage: { seed, writeable: true },
            })

            // Revoke previous blob
            if (blobUrl) URL.revokeObjectURL(blobUrl)
            blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }))
            mountTime = performance.now()
        } catch (e) {
            error = e.message || String(e)
        } finally {
            loading = false
        }
    }

    // Handle query + app-storage messages from the iframe
    function handleMessage(event) {
        if (frozen) return
        if (!iframe || event.source !== iframe.contentWindow) return

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
            iframe?.contentWindow?.postMessage({
                type: 'agex-query-result',
                id,
                data: null,
                error: 'app preview adapter not ready',
            }, '*')
            return
        }
        appAdapter.runQuery(appBranch, code, result)
            .then(data => {
                iframe?.contentWindow?.postMessage({
                    type: 'agex-query-result',
                    id,
                    data,
                    error: null,
                }, '*')
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
                iframe?.contentWindow?.postMessage({
                    type: 'agex-query-result',
                    id,
                    data: null,
                    error: msg,
                }, '*')
            })
    }

    onMount(() => {
        window.addEventListener('message', handleMessage)
        return () => {
            window.removeEventListener('message', handleMessage)
            setLiveIframe(null)
            if (blobUrl) URL.revokeObjectURL(blobUrl)
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
    {:else if blobUrl}
        <div class="iframe-wrap">
            <iframe
                bind:this={iframe}
                src={blobUrl}
                sandbox="allow-scripts"
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
