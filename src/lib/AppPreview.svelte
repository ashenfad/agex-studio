<script>
    /**
     * The live preview: the session's app, built from its files under
     * app/ and rendered in an iframe at the apps origin (a separate
     * origin, so the app can't reach the studio's storage or DOM). The
     * studio posts the built HTML to the origin's bootloader, and
     * answers the app's calls to it: `getCacheValue`, its storage,
     * `notify`, and its agent tasks (`agex.task`, run on the viewer's
     * model within this page's budget). The preview rebuilds when the
     * app's files change.
     *
     * It is the iframe `test_app` acts on with `live: true`.
     */
    import { onDestroy, untrack } from 'svelte'
    import { setLiveIframe } from './app-control.js'
    import { appDigest, hasApp, readApp } from './app-files.js'
    import { buildAppHtml } from './app-html.js'
    import { read as readAppStorage, write as writeAppStorage } from './app-storage.js'
    import { APP_CALLS, appAgent } from './app-tasks.svelte.js'
    import { APPS_ORIGIN, isFromAppFrame, replyToApp } from './apps-origin.js'
    import { sync } from './sync.svelte.js'
    import { studio } from './studio.svelte.js'

    /** @type {{ session: import('./studio.svelte.js').ChatSession }} */
    let { session } = $props()

    /** @type {HTMLIFrameElement | null} */
    let iframe = $state(null)
    /** The bootloader's URL, cache-busted per load so each load reloads it. */
    /** @type {string | null} */
    let appsUrl = $state(null)
    let empty = $state(false)
    let loading = $state(false)
    /** @type {string | null} */
    let failed = $state(null)
    /** @type {string[]} */
    let resourceErrors = $state([])
    /** The built HTML, posted once the bootloader says it's ready. */
    /** @type {string | null} */
    let pendingHtml = null
    /** The app's fingerprint when it was last built. */
    let builtDigest = ''

    async function load(force = false) {
        const ws = session.ws
        if (ws === null) return
        const app = await readApp(ws)
        const digest = appDigest(app)
        if (!force && digest === builtDigest && appsUrl !== null) return
        builtDigest = digest
        resourceErrors = []
        failed = null
        if (!hasApp(app)) {
            empty = true
            appsUrl = null
            return
        }
        empty = false
        loading = true
        try {
            pendingHtml = await buildAppHtml(app.files, {
                appBinaries: app.binaries,
                appStorage: { seed: readAppStorage('ts', session.name), writeable: true },
            })
            appsUrl = `${APPS_ORIGIN}/?t=${Date.now()}`
        } catch (e) {
            failed = e instanceof Error ? e.message : String(e)
            loading = false
        }
    }

    // Rebuild when the session's app may have changed (a tool call that
    // wrote, an undo), and only if its files actually did.
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null
    $effect(() => {
        void session.appStamp
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => void load(), 300)
    })

    $effect(() => {
        setLiveIframe(iframe)
        return () => setLiveIframe(null)
    })

    /** This page's budget for the app's agent calls, once it has one. */
    const budget = $derived(appAgent.budgets[session.name] ?? null)

    /** The app data stamp when the app was last built: past it, another
     *  device's data arrived, and the preview offers to reload. */
    let seenAppData = $state(untrack(() => session.appDataStamp))

    function reloadWithData() {
        seenAppData = session.appDataStamp
        void load(true)
    }

    /** @type {Record<string, string> | null} */
    let storageToWrite = null
    /** @type {ReturnType<typeof setTimeout> | null} */
    let storageTimer = null

    /** @param {MessageEvent} event */
    async function onMessage(event) {
        if (iframe === null || !isFromAppFrame(event, iframe)) return
        const data = event.data
        if (!data) return
        if (data.type === 'agex-host-ready' && pendingHtml !== null) {
            replyToApp(iframe, { type: 'agex-host-init', html: pendingHtml })
            pendingHtml = null
            loading = false
            return
        }
        if (data.type === 'agex-cache-get') {
            const { id, key } = data
            try {
                const value = await session.ws?.cache.get(String(key))
                replyToApp(iframe, { type: 'agex-cache-get-result', id, data: value ?? null, error: null })
            } catch (e) {
                replyToApp(iframe, { type: 'agex-cache-get-result', id, data: null, error: e instanceof Error ? e.message : String(e) })
            }
            return
        }
        if (data.type === 'agex-app-storage') {
            // the app's storage, written a moment after it settles
            storageToWrite = data.data || {}
            const name = session.name
            if (storageTimer === null) {
                storageTimer = setTimeout(() => {
                    storageTimer = null
                    if (storageToWrite !== null) {
                        writeAppStorage('ts', name, storageToWrite)
                        sync.appChanged(name)
                    }
                    storageToWrite = null
                }, 300)
            }
            return
        }
        if (data.type === 'agex-task') {
            const frame = iframe
            // an app opened from elsewhere asks before spending the viewer's key
            const ask = (studio.sessions.find((x) => x.name === session.name)?.source ?? null) !== null
            try {
                const value = await appAgent.call(session.name, { spec: data.spec, inputs: data.inputs }, { ask })
                replyToApp(frame, { type: 'agex-task-result', id: data.id, value: value === undefined ? null : value, error: null })
            } catch (e) {
                replyToApp(frame, { type: 'agex-task-result', id: data.id, value: null, error: e instanceof Error ? e.message : String(e) })
            }
            return
        }
        if (data.type === 'agex-notify') {
            // notifications come with the studio's own (a later step)
            replyToApp(iframe, { type: 'agex-notify-result', id: data.id, shown: false })
            return
        }
        if (data.type === 'agex-iframe-resource-error') {
            resourceErrors = [...resourceErrors, `<${data.tag} ${data.attr}="${data.url}">`].slice(-5)
        }
    }

    onDestroy(() => {
        if (timer !== null) clearTimeout(timer)
    })
</script>

<svelte:window onmessage={onMessage} />

<div class="preview">
    <div class="bar">
        <span>App</span>
        {#if loading}<span class="muted">loading…</span>{/if}
        {#if budget}
            <span class="calls" title="The app's calls to an agent this visit, on your model">agent {budget.used}/{budget.limit}</span>
            {#if budget.used >= budget.limit}
                <button class="more" onclick={() => appAgent.allowMore(session.name)}>Allow {APP_CALLS} more</button>
            {/if}
        {/if}
        <button onclick={() => load(true)} disabled={empty} title="Rebuild from the files">↻</button>
    </div>
    {#if session.appDataStamp > seenAppData && !empty}
        <div class="data-note">
            The app's data changed on another device.
            <button onclick={reloadWithData}>Reload the app</button>
        </div>
    {/if}
    {#if appAgent.asking[session.name]}
        {@const asking = appAgent.asking[session.name]}
        <div class="consent">
            <p>This app asks to use your model for an agent task (“{asking.task}”). Each call runs on your key; it may make up to {APP_CALLS} this visit.</p>
            <button onclick={() => asking.answer(true)}>Allow</button>
            <button class="secondary" onclick={() => asking.answer(false)}>Don't allow</button>
        </div>
    {/if}
    {#if failed}
        <p class="note error">The app couldn't be built: {failed}</p>
    {:else if empty}
        <p class="note">No app yet. Ask for one: it lives under <code>app/</code>, starting from <code>app/index.html</code>.</p>
    {:else if appsUrl}
        <iframe
            bind:this={iframe}
            src={appsUrl}
            title="App preview"
            allow="autoplay; microphone; camera; geolocation; gyroscope; accelerometer; magnetometer; midi; fullscreen; screen-wake-lock; web-share; clipboard-write"
        ></iframe>
    {/if}
    {#if resourceErrors.length > 0}
        <div class="errors">
            {#each resourceErrors as e}<div>failed to load {e}</div>{/each}
        </div>
    {/if}
</div>

<style>
    .data-note {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.4rem 0.8rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        font-size: 0.8rem;
    }
    .data-note button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 4px;
        padding: 0.2rem 0.6rem;
        cursor: pointer;
    }
    .calls {
        color: var(--text-muted);
        font-size: 0.75rem;
    }
    .more,
    .consent button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 4px;
        padding: 0.2rem 0.6rem;
        font-size: 0.75rem;
        cursor: pointer;
    }
    .consent {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        padding: 0.6rem 0.8rem;
        border-bottom: 1px solid var(--border);
        background: var(--surface);
        font-size: 0.85rem;
    }
    .consent p {
        width: 100%;
        margin: 0;
    }
    .consent .secondary {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
    }
    .preview {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--bg);
    }
    .bar {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.35rem 0.8rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.85rem;
    }
    .bar span:first-child {
        flex: 1;
    }
    .bar button {
        background: none;
        border: none;
        color: var(--text);
        cursor: pointer;
    }
    .muted {
        color: var(--text-muted);
    }
    iframe {
        flex: 1;
        width: 100%;
        border: none;
        background: #1a1a2e;
    }
    .note {
        padding: 1rem;
        color: var(--text-muted);
    }
    .error {
        color: var(--error);
    }
    .errors {
        font-size: 0.75rem;
        color: var(--warning);
        padding: 0.3rem 0.8rem;
        border-top: 1px solid var(--border);
    }
</style>
