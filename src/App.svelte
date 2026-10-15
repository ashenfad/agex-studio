<script>
    /**
     * The studio: the session list (folded away with ☰ or ⌘B; a drawer
     * on a narrow screen), the chat, and beside it the workbench (the
     * app and the files), split where the person drags it; the app full
     * screen; and the settings for the model.
     */
    import { onMount } from 'svelte'
    import { errorText } from './lib/errors.js'
    import { readLocal, writeLocal } from './lib/local.js'
    import { loadModels } from './lib/openrouter-models.js'
    import { getSettings } from './lib/settings.js'
    import AppPreview from './lib/AppPreview.svelte'
    import Chat from './lib/Chat.svelte'
    import { installDevHook } from './lib/dev-hook.js'
    import SessionList from './lib/SessionList.svelte'
    import SettingsDialog from './lib/SettingsDialog.svelte'
    import { appAgent } from './lib/app-tasks.svelte.js'
    import { setFaviconStatus } from './lib/favicon.js'
    import { onNotificationClick } from './lib/notify.js'
    import SplitPane from './lib/SplitPane.svelte'
    import { overall } from './lib/status.js'
    import { distribution } from './lib/distribution.svelte.js'
    import { studio } from './lib/studio.svelte.js'
    import { sync } from './lib/sync.svelte.js'
    import Workbench from './lib/Workbench.svelte'

    /** @param {string} key @param {boolean} on */
    function store(key, on) {
        writeLocal(key, on ? '1' : '0')
    }

    /** @type {string | null} */
    let failed = $state(null)
    let showSettings = $state(false)
    /** A narrow screen: the session list a drawer, one pane at a time. */
    const narrowQuery = matchMedia('(max-width: 768px)')
    let narrow = $state(narrowQuery.matches)
    /** The session list beside the chat, on a wide screen (kept). */
    let railOpen = $state(readLocal('agex-rail') !== '0')
    /** The session list over the chat, on a narrow screen. */
    let drawerOpen = $state(false)
    /** The workbench beside the chat, on a wide screen (kept). */
    let showApp = $state(readLocal('agex-workbench') !== '0')
    /** On a narrow screen, which pane shows. @type {'chat' | 'app'} */
    let mobileView = $state('chat')
    /** The app alone, filling the window. */
    let fullscreen = $state(false)

    function toggleSessions() {
        if (narrow) drawerOpen = !drawerOpen
        else {
            railOpen = !railOpen
            store('agex-rail', railOpen)
        }
    }

    function openSettings() {
        drawerOpen = false
        showSettings = true
    }

    function toggleApp() {
        showApp = !showApp
        store('agex-workbench', showApp)
    }

    // an app asking to use the model waits on the person: on a narrow
    // screen, its pane comes forward so the question can be seen
    $effect(() => {
        const name = studio.current?.name
        if (name !== undefined && appAgent.asking[name] !== undefined) mobileView = 'app'
    })

    // the tab's icon carries the sessions' status, for a person in another tab
    $effect(() => {
        void setFaviconStatus(overall(studio.openSessions()))
    })

    // a notification clicked opens the session it came from: a turn's in
    // the chat, whatever the view; an app's at its app, left as it is
    // when that's the session shown (the person may be watching the app)
    onNotificationClick((name, kind) => {
        const shown = studio.current?.name === name
        drawerOpen = false
        if (kind === 'turn') {
            playing = false
            fullscreen = false
            mobileView = 'chat'
        } else if (!shown) {
            mobileView = 'app'
        }
        if (shown) return
        void studio.switchTo(name).catch((e) => console.error("couldn't open the notification's session:", e))
    })

    /** @param {KeyboardEvent} e */
    function onKey(e) {
        if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
            e.preventDefault()
            toggleSessions()
        } else if (e.key === 'Escape' && fullscreen) {
            fullscreen = false
        }
    }

    if (import.meta.env.DEV) installDevHook(studio, sync)

    /** A published session's link (`/run/?gist=…`), and `&play=1`
     *  for its app alone. */
    const params = new URLSearchParams(location.search)
    const gistParam = params.get('gist')
    /** The app alone, as a published link's `play=1` asks. */
    let playing = $state(params.get('play') === '1')
    /** While a published link's session is being fetched: until then the
     *  app alone shows nothing, not the session last looked at. */
    let fetchingGist = $state(gistParam !== null)
    /** What went wrong opening a published link. @type {string | null} */
    let opening = $state(null)

    onMount(() => {
        // what the studio reads off the OpenRouter model (whether it takes
        // images, its window) is at hand before a turn needs it; on
        // another service nothing is asked of OpenRouter
        if (getSettings().accessMode === 'openrouter') loadModels().catch(() => {})
        void (async () => {
            try {
                // with a published link, no blank session first: it is the first
                await studio.init({ empty: gistParam !== null })
            } catch (e) {
                failed = errorText(e)
                return
            }
            if (gistParam !== null) {
                try {
                    await distribution.openGist(gistParam)
                } catch (e) {
                    opening = errorText(e)
                    playing = false
                    if (studio.current === null) await studio.create()
                }
                fetchingGist = false
                // the session is here now: the plain address from here on
                history.replaceState({}, '', '/')
            }
            // every session against the repo, on arrival and on coming back
            void sync.sweep({ force: true })
            void distribution.checkUpdates()
        })()
        const back = () => {
            if (document.visibilityState === 'visible') void sync.sweep()
        }
        window.addEventListener('focus', back)
        document.addEventListener('visibilitychange', back)
        // what ended in the session shown while the page was away is seen now
        const looking = () => studio.backOnScreen()
        window.addEventListener('focus', looking)
        document.addEventListener('visibilitychange', looking)
        // a turn or a delegate runs in this page: leaving stops it
        /** @param {BeforeUnloadEvent} e */
        const leaving = (e) => {
            if (!studio.working()) return
            e.preventDefault()
            e.returnValue = ''
        }
        window.addEventListener('beforeunload', leaving)
        /** @param {MediaQueryListEvent} e */
        const resized = (e) => {
            narrow = e.matches
            drawerOpen = false
        }
        narrowQuery.addEventListener('change', resized)
        return () => {
            narrowQuery.removeEventListener('change', resized)
            window.removeEventListener('focus', back)
            document.removeEventListener('visibilitychange', back)
            window.removeEventListener('focus', looking)
            document.removeEventListener('visibilitychange', looking)
            window.removeEventListener('beforeunload', leaving)
        }
    })

    /** Sync's state for the header: busy, needing the person, or quiet. */
    const syncMark = $derived.by(() => {
        if (!sync.connected) return null
        const states = Object.values(sync.status).map((s) => s.state)
        if (sync.problem !== null || states.some((s) => s === 'diverged' || s === 'remote-gone' || s === 'error')) {
            return { glyph: '⚠', title: sync.problem ?? 'A session needs attention: see the session list' }
        }
        if (states.some((s) => s === 'syncing')) return { glyph: '↻', title: 'Syncing' }
        return null
    })
</script>

{#if playing && fetchingGist}
    <div class="play"><p class="note">Opening the published app…</p></div>
{:else if playing && studio.current}
    <div class="play">
        <div class="app-pane"><AppPreview session={studio.current} /></div>
        <button class="pill" onclick={() => (playing = false)} title="The conversation and files behind this app">agex studio · how it was made</button>
    </div>
{:else}
<div class="shell" class:fullscreen>
    <header>
        <button
            class="icon"
            class:on={narrow ? drawerOpen : railOpen}
            onclick={toggleSessions}
            aria-label={(narrow ? drawerOpen : railOpen) ? 'Hide the sessions' : 'Show the sessions'}
            title="{(narrow ? drawerOpen : railOpen) ? 'Hide' : 'Show'} the sessions (⌘B)"
        >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="9" y1="4" x2="9" y2="20"></line></svg>
        </button>
        <span class="brand">agex studio</span>
        <span class="title">{studio.current?.title || ''}</span>
        {#if syncMark}
            <button class="icon sync-mark" title={syncMark.title} aria-label={syncMark.title} onclick={() => (narrow ? (drawerOpen = true) : (railOpen = true))}>{syncMark.glyph}</button>
        {/if}
        {#if !narrow}
            <button
                class="icon"
                class:on={showApp}
                onclick={toggleApp}
                aria-label={showApp ? 'Hide the app and files' : 'Show the app and files'}
                title={showApp ? 'Hide the app and files' : 'Show the app and files'}
            >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"></rect><line x1="14" y1="4" x2="14" y2="20"></line></svg>
            </button>
        {/if}
        <a class="icon" href="/docs/" target="_blank" rel="noreferrer" aria-label="Help: the docs" title="Help: how the studio works (opens the docs)">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"></circle><path d="M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3"></path><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>
        </a>
        <button class="icon" onclick={openSettings} aria-label="Settings" title="Settings: the model, sync and publishing">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
        </button>
    </header>
    <div class="body">
        {#if narrow && drawerOpen}
            <button class="scrim" onclick={() => (drawerOpen = false)} aria-label="Close the sessions"></button>
        {/if}
        <aside class:rail={!narrow && railOpen} class:drawer={narrow && drawerOpen}>
            <SessionList onPicked={() => (drawerOpen = false)} />
        </aside>
        <main>
            {#if failed}
                <p class="note">The store couldn't open: {failed}</p>
            {:else if studio.current === null}
                <p class="note">{gistParam ? 'Opening the published session…' : 'Opening…'}</p>
            {:else}
                {#if opening}
                    <p class="note warn">The published session couldn't be opened: {opening}</p>
                {/if}
                {#key studio.current.name}
                    {@const session = studio.current}
                    <SplitPane
                        single={!narrow && !showApp && !fullscreen}
                        appOnly={fullscreen}
                        {mobileView}
                        onToggleMobile={() => (mobileView = mobileView === 'chat' ? 'app' : 'chat')}
                    >
                        <Chat {session} onSettings={openSettings} />
                        {#snippet side()}
                            <Workbench {session} {fullscreen} onFullscreen={(on) => (fullscreen = on)} />
                        {/snippet}
                    </SplitPane>
                {/key}
            {/if}
        </main>
    </div>
</div>

{/if}

{#if fullscreen}
    <button class="pill" onclick={() => (fullscreen = false)} title="Back to the chat (Esc)">agex studio · back to the chat</button>
{/if}
{#if showSettings}
    <SettingsDialog onClose={() => (showSettings = false)} />
{/if}

<svelte:window onkeydown={onKey} />

<style>
    .shell {
        display: flex;
        flex-direction: column;
        height: 100%;
    }
    header {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        padding: 0.5rem 1rem;
        border-bottom: 1px solid var(--border);
    }
    .brand {
        font-family: var(--font-display);
        font-size: 1.2rem;
    }
    .title {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--text-muted);
    }
    .icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        background: none;
        border: none;
        border-radius: 6px;
        color: var(--text-muted);
        font-size: 1.05rem;
        cursor: pointer;
    }
    .icon:hover {
        color: var(--text);
        background: var(--surface-hover);
    }
    .icon.on {
        color: var(--text);
    }
    .sync-mark {
        color: var(--warning);
    }
    .body {
        flex: 1;
        min-height: 0;
        display: flex;
        position: relative;
    }
    aside {
        display: none;
        width: 16rem;
        flex-shrink: 0;
        border-right: 1px solid var(--border);
        background: var(--surface);
        min-height: 0;
    }
    aside.rail {
        display: block;
    }
    aside.drawer {
        display: block;
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        z-index: 25;
        width: min(18rem, 85vw);
        box-shadow: 4px 0 20px rgb(0 0 0 / 40%);
    }
    .scrim {
        position: absolute;
        inset: 0;
        z-index: 24;
        border: none;
        padding: 0;
        background: rgb(0 0 0 / 45%);
        cursor: pointer;
    }
    main {
        flex: 1;
        min-width: 0;
        min-height: 0;
        display: flex;
        flex-direction: column;
    }
    main > :global(.split) {
        flex: 1;
    }
    /* the app alone: the studio's chrome steps aside */
    .shell.fullscreen header,
    .shell.fullscreen aside,
    .shell.fullscreen main > .note {
        display: none;
    }
    .note {
        padding: 1rem;
        color: var(--text-muted);
    }
    main > .note {
        padding: 0.4rem 1rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.85rem;
    }
    .warn {
        color: var(--error);
    }
    .play {
        position: fixed;
        inset: 0;
        display: flex;
        flex-direction: column;
    }
    .app-pane {
        flex: 1;
        min-height: 0;
    }
    .pill {
        position: fixed;
        right: 0.8rem;
        bottom: 0.8rem;
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0.3rem 0.8rem;
        font-size: 0.8rem;
        cursor: pointer;
        z-index: 40;
    }
</style>
