<script>
    /**
     * The live preview: the session's app, built from its files under
     * app/ and rendered in an iframe at the apps origin (a separate
     * origin, so the app can't reach the studio's storage or DOM). The
     * studio posts the built HTML to the origin's bootloader, and
     * answers the app's calls to it: `getCacheValue`, its storage,
     * `notify`, its agent tasks (`agex.task`, run on the viewer's model,
     * counted on its meter), its database (`agex.db`, the session's) and
     * the work it marks in flight (`agex.busy`). The preview rebuilds
     * when the app's files change, and reloads the app when its
     * database changes under it (a restore, or a sync, which only offers
     * the reload while the app is busy).
     *
     * It is the iframe `test_app` acts on with `live: true`. Its bar is
     * the workbench's: it says whether it is loading and whether there is
     * an app, and rebuilds when asked.
     */
    import { onDestroy, tick, untrack } from 'svelte'
    import { errorText } from './errors.js'
    import { callStarted, callsLost, setLiveIframe, setLiveSettled } from './app-control.js'
    import { appDbs } from './app-db-clients.js'
    import { dbRestores } from './db-restore.svelte.js'
    import { afterDbChange, busyCount, setLiveBusy } from './app-busy.js'
    import { formatDate } from './format-time.js'
    import { answerDb, mayHaveWritten } from './app-db-bridge.js'
    import { appDigest, hasApp, readApp } from './app-files.js'
    import { buildAppPage, reseedAppPage } from './app-html.js'
    import { hostInit } from './app-assets.js'
    import { checkBag, read as readAppStorage, write as writeAppStorage } from './app-storage.js'
    import { pageGone, pageLoaded, pageUp } from './send-control.js'
    import { appAgent } from './app-tasks.svelte.js'
    import { RATE } from './app-meter.js'
    import { APPS_ORIGIN, isFromAppFrame, replyToApp } from './apps-origin.js'
    import { appNotify } from './notify.js'
    import { sync } from './sync.svelte.js'
    import { studio } from './studio.svelte.js'

    /** @type {{ session: import('./session.svelte.js').ChatSession, loading?: boolean, empty?: boolean, asking?: boolean }} */
    let { session, loading = $bindable(false), empty = $bindable(false), asking = $bindable(false) } = $props()

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

    /** Loads in flight: reading the files, building, posting the page. */
    let building = 0
    /** Those waiting for the preview to settle (`whenSettled`). */
    /** @type {(() => void)[]} */
    let settling = []

    /** Tell those waiting once no rebuild is due or under way. */
    function settleCheck() {
        if (timer !== null || building > 0) return
        const waiting = settling
        settling = []
        for (const fn of waiting) fn()
    }

    /** Settles once the preview has gone on with the app's files as they
     *  are: no rebuild is due (a write's debounce) or under way. Its page
     *  may still be loading, which `test_app` waits for on its own. */
    function whenSettled() {
        return new Promise((resolve) => {
            // once the DOM shows what the load did (a first app's iframe)
            settling.push(() => void tick().then(() => resolve(undefined)))
            settleCheck()
        })
    }

    async function load(force = false) {
        building += 1
        try {
            await loadNow(force)
        } finally {
            building -= 1
            settleCheck()
        }
    }

    async function loadNow(force = false) {
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
            if (iframe !== null) pageGone(iframe, 'studio')
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
            // the studio replaces the page: an action waiting on it fails
            // saying so, not as though the app had navigated
            if (iframe !== null) pageGone(iframe, 'studio')
            appsUrl = `${APPS_ORIGIN}/?t=${Date.now()}`
        } catch (e) {
            if (ticket !== latest) return
            // the preview shows the error in the page's place
            if (iframe !== null) pageGone(iframe, 'studio')
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
        timer = setTimeout(() => {
            timer = null
            void load()
        }, 300)
    })

    $effect(() => {
        setLiveIframe(iframe)
        return () => setLiveIframe(null)
    })

    $effect(() => {
        setLiveSettled(whenSettled)
        return () => setLiveSettled(null)
    })

    /** The app data stamp when the app was last built: past it, another
     *  device's data arrived, and the preview offers to reload. */
    let seenAppData = $state(untrack(() => session.appDataStamp))

    /** The app's work in flight, as its page last said (`agex.busy`). */
    let busy = 0
    /** Whether a sync changed the app's database while it was busy, so
     *  the preview offers the reload it didn't do. */
    let dbOffered = $state(false)

    $effect(() => {
        setLiveBusy(() => ({ busy, offered: dbOffered }))
        return () => setLiveBusy(null)
    })

    function reloadWithData() {
        seenAppData = session.appDataStamp
        dbOffered = false
        void load(true)
    }

    // A restore of the app's database (here, or in another tab), or a
    // sync that brought another device's changes to it, leaves the app
    // holding data from before: it reloads, unless a sync finds it busy,
    // which offers the reload instead.
    let seenRestores = untrack(() => dbRestores.restored.count)
    $effect(() => {
        const { count, id, cause } = dbRestores.restored
        if (count === seenRestores) return
        seenRestores = count
        const name = session.name
        void appDbs.idOf(name).then((mine) => {
            if (mine === null || mine !== id || session.name !== name) return
            if (afterDbChange(cause, busy) === 'offer') dbOffered = true
            else void load(true)
        })
    })

    /** The app's database's id, once it has one: looked up again when a
     *  question about some database comes (it may be named since). */
    let dbId = $state(/** @type {string | null} */ (null))
    $effect(() => {
        void Object.keys(dbRestores.asking).length
        const name = session.name
        void appDbs.idOf(name).then((id) => {
            if (session.name === name) dbId = id
        })
    })

    /** A restore of the app's database the agent asks about, waiting on the person. */
    const restoring = $derived(dbId === null ? null : (dbRestores.asking[dbId] ?? null))
    $effect(() => {
        asking = restoring !== null || appAgent.asking[session.name] !== undefined || appAgent.paused[session.name] !== undefined
    })

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
        if (data.type === 'agex-host-ready') {
            // the bootloader is back in the app's place: the app reloaded
            // itself, unless the studio's rebuild already said it replaced
            // the page; actions wait for the page's bridge
            pageGone(iframe, 'app')
        }
        if (data.type === 'agex-host-ready' && current !== null) {
            // seeded with what the app saved so far: on its first load
            // that's what it was built with, after a reload of its own
            // it's what it saved before reloading
            flushStorage()
            // a fresh page: nothing in flight, and the database as it is now
            busy = 0
            dbOffered = false
            const page = reseedAppPage(current.page, { seed: readAppStorage(current.name), writeable: true })
            replyToApp(iframe, hostInit(page, data))
            loading = false
            return
        }
        if (data.type === 'agex-bridge-ready') {
            // the app's page is up, and test_app can act on it again; the
            // calls a page before it made will reach no one
            pageUp(iframe)
            callsLost(iframe)
            return
        }
        if (data.type === 'agex-page-loaded') {
            // its document loaded (its imports with it): live actions start
            pageLoaded(iframe)
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
        if (data.type === 'agex-db') {
            // the database of the session this preview shows, never one
            // the message names
            const frame = iframe
            const name = session.name
            const done = callStarted(frame)
            try {
                const reply = await answerDb(data, () => appDbs.dbFor(name))
                replyToApp(frame, reply)
                if (mayHaveWritten(data, reply)) sync.dbChanged(name)
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
        if (data.type === 'agex-busy') {
            // the app's work in flight; it settling leaves an offer showing
            busy = busyCount(data.busy)
            return
        }
        if (data.type === 'agex-iframe-resource-error') {
            resourceErrors = [...resourceErrors, `<${data.tag} ${data.attr}="${data.url}">`].slice(-5)
        }
    }

    onDestroy(() => {
        if (timer !== null) clearTimeout(timer)
        timer = null
        building = 0
        settleCheck()
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
    {:else if dbOffered && !empty}
        <div class="data-note">
            The app's database changed on another device while the app was busy.
            <button onclick={reloadWithData}>Reload the app</button>
        </div>
    {/if}
    {#if restoring}
        <div class="consent">
            <p>
                The agent asks to restore the app's data to the checkpoint “{restoring.checkpoint.label || 'unnamed'}”, taken {formatDate(new Date(restoring.checkpoint.time).toISOString())}.
                Everything the app stored since then is lost.
            </p>
            <button onclick={() => restoring.answer(true)}>Restore</button>
            <button class="secondary" onclick={() => restoring.answer(false)}>Keep it as it is</button>
        </div>
    {/if}
    {#if appAgent.asking[session.name]}
        {@const asking = appAgent.asking[session.name]}
        <div class="consent">
            <p>This app asks to use your model for an agent task (“{asking.task}”). Each call runs on your key; the agent meter above the app shows what it has used.</p>
            <button onclick={() => asking.answer(true)}>Allow</button>
            <button class="secondary" onclick={() => asking.answer(false)}>Don't allow</button>
        </div>
    {/if}
    {#if appAgent.paused[session.name]}
        {@const paused = appAgent.paused[session.name]}
        <div class="consent">
            <p>This app made {paused.calls} agent calls in the last minute, on your key, so its calls are paused: more than {RATE.calls} a minute can be a loop. Let it go on?</p>
            <button onclick={() => appAgent.goOn(session.name)}>Keep going</button>
            <button class="secondary" onclick={() => paused.answer(false)}>Stop its calls</button>
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
