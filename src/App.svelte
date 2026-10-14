<script>
    /**
     * The studio: the session list beside the chat (a drawer on a
     * narrow screen), the files, and the settings for the model.
     */
    import { onMount } from 'svelte'
    import Chat from './lib/Chat.svelte'
    import { installDevHook } from './lib/dev-hook.js'
    import FilesDrawer from './lib/FilesDrawer.svelte'
    import SessionList from './lib/SessionList.svelte'
    import SettingsDialog from './lib/SettingsDialog.svelte'
    import { isConfigured, settingsStore } from './lib/settings.js'
    import { studio } from './lib/studio.svelte.js'

    /** @type {string | null} */
    let failed = $state(null)
    let showSettings = $state(false)
    let showFiles = $state(false)
    let showSessions = $state(false)

    if (import.meta.env.DEV) installDevHook(studio)

    onMount(async () => {
        try {
            await studio.init()
        } catch (e) {
            failed = e instanceof Error ? e.message : String(e)
        }
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
                    <Chat session={studio.current} />
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
