<script>
    /**
     * The studio: the session list beside the chat (a drawer on a
     * narrow screen), the files, and the settings for the model.
     */
    import { onMount } from 'svelte'
    import AppPreview from './lib/AppPreview.svelte'
    import Chat from './lib/Chat.svelte'
    import { installDevHook } from './lib/dev-hook.js'
    import FilesDrawer from './lib/FilesDrawer.svelte'
    import SessionList from './lib/SessionList.svelte'
    import SettingsDialog from './lib/SettingsDialog.svelte'
    import { isConfigured, settingsStore } from './lib/settings.js'
    import { studio } from './lib/studio.svelte.js'
    import { sync } from './lib/sync.svelte.js'

    /** @type {string | null} */
    let failed = $state(null)
    let showSettings = $state(false)
    let showFiles = $state(false)
    let showSessions = $state(false)
    /** The preview beside the chat (on a narrow screen, instead of it). */
    let showApp = $state(true)

    if (import.meta.env.DEV) installDevHook(studio, sync)

    onMount(() => {
        void (async () => {
            try {
                await studio.init()
            } catch (e) {
                failed = e instanceof Error ? e.message : String(e)
                return
            }
            // every session against the repo, on arrival and on coming back
            void sync.sweep({ force: true })
        })()
        const back = () => {
            if (document.visibilityState === 'visible') void sync.sweep()
        }
        window.addEventListener('focus', back)
        document.addEventListener('visibilitychange', back)
        return () => {
            window.removeEventListener('focus', back)
            document.removeEventListener('visibilitychange', back)
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

    async function openFiles() {
        await studio.current?.refreshFiles()
        showFiles = true
    }
</script>

<div class="shell">
    <header>
        <button class="icon sessions-toggle" onclick={() => (showSessions = !showSessions)} aria-label="Sessions">☰</button>
        <span class="brand">agex studio</span>
        <span class="title">{studio.current?.title || ''}</span>
        {#if syncMark}
            <button class="icon sync-mark" title={syncMark.title} aria-label={syncMark.title} onclick={() => (showSessions = true)}>{syncMark.glyph}</button>
        {/if}
        <button class="icon" class:on={showApp} onclick={() => (showApp = !showApp)} aria-label="App preview" title="App preview">▣</button>
        <button class="icon" onclick={openFiles} aria-label="Files" disabled={studio.current === null}>📁</button>
        <button class="icon" onclick={() => (showSettings = true)} aria-label="Settings">⚙</button>
    </header>
    <div class="body">
        <aside class:open={showSessions}>
            <SessionList onPicked={() => (showSessions = false)} />
        </aside>
        <main>
            {#if failed}
                <p class="note">The store couldn't open: {failed}</p>
            {:else if studio.current === null}
                <p class="note">Opening…</p>
            {:else if !isConfigured($settingsStore)}
                <p class="note">
                    Choose a model to start: <button class="link" onclick={() => (showSettings = true)}>settings</button>.
                </p>
            {:else}
                {#key studio.current.name}
                    <div class="work" class:with-app={showApp}>
                        <div class="chat-pane"><Chat session={studio.current} /></div>
                        {#if showApp}
                            <div class="app-pane"><AppPreview session={studio.current} /></div>
                        {/if}
                    </div>
                {/key}
            {/if}
        </main>
    </div>
</div>

{#if showSettings}
    <SettingsDialog onClose={() => (showSettings = false)} />
{/if}
{#if showFiles && studio.current}
    <FilesDrawer session={studio.current} onClose={() => (showFiles = false)} />
{/if}

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
        background: none;
        border: none;
        color: var(--text);
        font-size: 1.1rem;
        cursor: pointer;
    }
    .sessions-toggle {
        display: none;
    }
    .body {
        flex: 1;
        min-height: 0;
        display: flex;
    }
    aside {
        width: 16rem;
        flex-shrink: 0;
        border-right: 1px solid var(--border);
        background: var(--surface);
    }
    main {
        flex: 1;
        min-width: 0;
        min-height: 0;
    }
    .work {
        display: grid;
        grid-template-columns: 1fr;
        height: 100%;
    }
    .work.with-app {
        grid-template-columns: minmax(20rem, 2fr) 3fr;
    }
    .chat-pane,
    .app-pane {
        min-width: 0;
        min-height: 0;
    }
    .app-pane {
        border-left: 1px solid var(--border);
    }
    .icon.on {
        color: var(--accent);
    }
    @media (max-width: 720px) {
        .sessions-toggle {
            display: block;
        }
        aside {
            display: none;
            position: fixed;
            top: 3rem;
            bottom: 0;
            left: 0;
            z-index: 5;
        }
        aside.open {
            display: block;
        }
        /* one pane at a time: the app instead of the chat while shown */
        .work.with-app {
            grid-template-columns: 1fr;
        }
        .work.with-app .chat-pane {
            display: none;
        }
        .app-pane {
            border-left: none;
        }
    }
    .note {
        padding: 1rem;
        color: var(--text-muted);
    }
    .link {
        background: none;
        border: none;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
        text-decoration: underline;
    }
</style>
