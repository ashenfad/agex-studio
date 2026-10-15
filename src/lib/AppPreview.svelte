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
     * It is the iframe `test_app` acts on with `live: true`. Its bar is
     * the workbench's: it says whether it is loading and whether there is
     * an app, and rebuilds when asked.
     */
    import { onDestroy, untrack } from 'svelte'
    import { errorText } from './errors.js'
    import { callStarted, callsLost, setLiveIframe } from './app-control.js'
    import { appDigest, hasApp, readApp } from './app-files.js'
    import { buildAppPage, reseedAppPage } from './app-html.js'
    import { hostInit } from './app-assets.js'
    import { checkBag, read as readAppStorage, write as writeAppStorage } from './app-storage.js'
    import { pageLoaded } from './send-control.js'
    import { APP_CALLS, appAgent } from './app-tasks.svelte.js'
    import { APPS_ORIGIN, isFromAppFrame, replyToApp } from './apps-origin.js'
    import { appNotify } from './notify.js'
    import { sync } from './sync.svelte.js'
    import { studio } from './studio.svelte.js'

    /** @type {{ session: import('./session.svelte.js').ChatSession, loading?: boolean, empty?: boolean }} */
    let { session, loading = $bindable(false), empty = $bindable(false) } = $props()

    /** @type {HTMLIFrameElement | null} */
    let iframe = $state(null)
    /** The bootloader's URL, cache-busted per load so each load reloads it. */
    /** @type {string | null} */
    let appsUrl = $state(null)
    /** @type {string | null} */
    let failed = $state(null)
    /** @type {string[]} */
    let resourceErrors = $state([])
    /** The built page, and the session whose app it is: posted each time
     *  the bootloader says it's ready, which is again whenever the app
     *  reloads itself. */
    /** @type {{ page: import('./app-html.js').AppPage, name: string } | null} */
    let current = null
    /** The app's fingerprint when it was last built. */
    let builtDigest = ''
    /** Each load's number, in the order they started. */
    let loads = 0
    /** The load whose build is the one to show: an earlier one that
     *  finishes after it is dropped. */
    let latest = 0

    async function load(force = false) {
        const ws = session.ws
        if (ws === null) return
        const ticket = ++loads
        const app = await readApp(ws)
        // a later load already read the files and went on with them
        if (ticket < latest) return
        const digest = appDigest(app)
        if (!force && digest === builtDigest && appsUrl !== null) return
        latest = ticket
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
        const name = session.name
        try {
            const page = await buildAppPage(app.files, {
                appBinaries: app.binaries,
                appStorage: { seed: readAppStorage(name), writeable: true },
            })
            if (ticket !== latest) return
            current = { page, name }
            appsUrl = `${APPS_ORIGIN}/?t=${Date.now()}`
        } catch (e) {
            if (ticket !== latest) return
            failed = errorText(e)
            loading = false
        }
    }

    // Rebuild when the session's app may have changed (a tool call that
    // wrote, an undo), and only if its files actually did.
    /** Build the app again from its files. */
    export function rebuild() {
        void load(true)
    }

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

    /** The app data stamp when the app was last built: past it, another
     *  device's data arrived, and the preview offers to reload. */
    let seenAppData = $state(untrack(() => session.appDataStamp))

    function reloadWithData() {
        seenAppData = session.appDataStamp
        void load(true)
    }

    /** The app's storage, the last bag it posted, and its session's name. */
    /** @type {{ name: string, bag: Record<string, string> } | null} */
    let storageToWrite = null
    /** @type {ReturnType<typeof setTimeout> | null} */
    let storageTimer = null

    /** Write the app's storage now, if it posted any since the last write. */
    function flushStorage() {
        if (storageTimer !== null) clearTimeout(storageTimer)
        storageTimer = null
        if (storageToWrite === null) return
        const { name, bag } = storageToWrite
        storageToWrite = null
        try {
            writeAppStorage(name, bag)
            sync.appChanged(name)
        } catch (e) {
            // the studio's storage is full: the app's saved data stays as it was
            console.warn('[app] storage not saved:', e)
        }
    }

    /** @param {MessageEvent} event */
    async function onMessage(event) {
        if (iframe === null || !isFromAppFrame(event, iframe)) return
        const data = event.data
        if (!data) return
        if (data.type === 'agex-host-ready' && current !== null) {
            // seeded with what the app saved so far: on its first load
            // that's what it was built with, after a reload of its own
            // it's what it saved before reloading
            flushStorage()
            const page = reseedAppPage(current.page, { seed: readAppStorage(current.name), writeable: true })
            replyToApp(iframe, hostInit(page, data))
            loading = false
            return
        }
        if (data.type === 'agex-bridge-ready') {
            // the app's page is up, and test_app can act on it again; the
            // calls a page before it made will reach no one
            pageLoaded(iframe)
            callsLost(iframe)
            return
        }
        if (data.type === 'agex-cache-get') {
            const { id, key } = data
            const frame = iframe
            const done = callStarted(frame)
            try {
                const value = await session.ws?.cache.get(String(key))
                replyToApp(frame, { type: 'agex-cache-get-result', id, data: value ?? null, error: null })
            } catch (e) {
                replyToApp(frame, { type: 'agex-cache-get-result', id, data: null, error: errorText(e) })
            } finally {
                done()
            }
            return
        }
        if (data.type === 'agex-app-storage') {
            // the app's storage, written a moment after it settles; a
            // bag the shim wouldn't have kept (not all strings, or past
            // its quota) isn't written at all
            const bag = checkBag(data.data)
            if (bag === null) return
            storageToWrite = { name: session.name, bag }
            if (storageTimer === null) storageTimer = setTimeout(flushStorage, 300)
            return
        }
        if (data.type === 'agex-task') {
            const frame = iframe
            const done = callStarted(frame)
            // an app opened from elsewhere asks before spending the viewer's key
            const ask = (studio.sessions.find((x) => x.name === session.name)?.source ?? null) !== null
            try {
                const value = await appAgent.call(session.name, { spec: data.spec, inputs: data.inputs }, { ask })
                replyToApp(frame, { type: 'agex-task-result', id: data.id, value: value === undefined ? null : value, error: null })
            } catch (e) {
                replyToApp(frame, { type: 'agex-task-result', id: data.id, value: null, error: errorText(e) })
            } finally {
                done()
            }
            return
        }
        if (data.type === 'agex-notify') {
            const { shown, reason } = appNotify({ session: session.name, title: String(data.title ?? ''), body: String(data.body ?? '') })
            replyToApp(iframe, { type: 'agex-notify-result', id: data.id, shown, error: reason })
            return
        }
        if (data.type === 'agex-iframe-resource-error') {
            resourceErrors = [...resourceErrors, `<${data.tag} ${data.attr}="${data.url}">`].slice(-5)
        }
    }

    onDestroy(() => {
        if (timer !== null) clearTimeout(timer)
        flushStorage()
    })
</script>

<svelte:window onmessage={onMessage} />

<div class="preview">
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
