<script>
    /**
     * What sits beside the chat: the app the session builds, and its
     * files, as two tabs under one bar. The bar carries what the tab
     * shown can do: rebuilding the app, its agent calls, full screen; or
     * adding files. The app stays loaded while the files are shown.
     */
    import AppPreview from './AppPreview.svelte'
    import { dbOwner } from './app-db-clients.js'
    import { APP_CALLS, appAgent } from './app-tasks.svelte.js'
    import { dbRestores } from './db-restore.svelte.js'
    import { isDriveImportAvailable } from './drive-import.js'
    import FilesPanel from './FilesPanel.svelte'

    /** @type {{ session: import('./session.svelte.js').ChatSession, fullscreen?: boolean, onFullscreen?: (on: boolean) => void }} */
    let { session, fullscreen = false, onFullscreen } = $props()

    /** @type {'app' | 'files'} */
    let tab = $state('app')
    let loading = $state(false)
    let empty = $state(false)
    /** @type {AppPreview | undefined} */
    let preview = $state()
    /** @type {FilesPanel | undefined} */
    let files = $state()
    const drive = isDriveImportAvailable()

    // an app asking to use the model, or the agent asking to restore
    // the app's data, waits on the person, and the question shows with
    // the app: its tab comes forward
    $effect(() => {
        if (appAgent.asking[session.name] !== undefined || dbRestores.asking[dbOwner(session.name)] !== undefined) tab = 'app'
    })

    /** The files listed, folders aside. */
    const fileCount = $derived(session.files.filter((f) => !session.files.some((o) => o.startsWith(`${f}/`))).length)

    /** This page's budget for the app's agent calls, once it has one. */
    const budget = $derived(appAgent.budgets[session.name] ?? null)
</script>

<div class="bench">
    <div class="bar" role="tablist">
        {#if !fullscreen}
            <button role="tab" class="tab" class:on={tab === 'app'} aria-selected={tab === 'app'} onclick={() => (tab = 'app')}>App</button>
            <button role="tab" class="tab" class:on={tab === 'files'} aria-selected={tab === 'files'} onclick={() => (tab = 'files')}>
                Files{#if fileCount}<span class="count">{fileCount}</span>{/if}
            </button>
        {/if}
        <span class="gap"></span>
        {#if tab === 'app' || fullscreen}
            {#if loading}<span class="muted">loading…</span>{/if}
            {#if budget}
                <span class="muted" title="The app's calls to an agent this visit, on your model">agent {budget.used}/{budget.limit}</span>
                {#if budget.used >= budget.limit}
                    <button class="more" onclick={() => appAgent.allowMore(session.name)}>Allow {APP_CALLS} more</button>
                {/if}
            {/if}
            <button class="act" onclick={() => preview?.rebuild()} disabled={empty} title="Rebuild the app from its files" aria-label="Rebuild the app">↻</button>
            <button
                class="act full"
                onclick={() => onFullscreen?.(!fullscreen)}
                title={fullscreen ? 'Back to the studio (Esc)' : 'The app alone, full screen'}
                aria-label={fullscreen ? 'Exit full screen' : 'Full screen'}
            >
                {#if fullscreen}
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>
                {:else}
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
                {/if}
            </button>
        {:else}
            <button class="add" onclick={() => files?.upload()} disabled={session.busy} title={session.busy ? 'A turn is running' : 'Add files from this device to uploads/'}>Upload</button>
            {#if drive}
                <button class="add" onclick={() => files?.fromDrive()} disabled={session.busy} title={session.busy ? 'A turn is running' : 'Add files from Google Drive to uploads/'}>From Drive</button>
            {/if}
        {/if}
    </div>
    <div class="panel" hidden={tab !== 'app' && !fullscreen}>
        <AppPreview bind:this={preview} bind:loading bind:empty {session} />
    </div>
    {#if tab === 'files' && !fullscreen}
        <FilesPanel bind:this={files} {session} />
    {/if}
</div>

<style>
    .bench {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        background: var(--bg);
    }
    .bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0 0.6rem;
        min-height: 2.4rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.85rem;
    }
    .gap {
        flex: 1;
    }
    .tab {
        align-self: stretch;
        display: flex;
        align-items: center;
        gap: 0.35rem;
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        color: var(--text-muted);
        cursor: pointer;
        font: inherit;
        padding: 0 0.4rem;
    }
    .tab:hover {
        color: var(--text);
    }
    .tab.on {
        color: var(--text);
        border-bottom-color: var(--accent);
    }
    .count {
        font-size: 0.7rem;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 999px;
        padding: 0 0.4rem;
        color: var(--text-muted);
    }
    .muted {
        color: var(--text-muted);
        font-size: 0.78rem;
    }
    .act {
        display: flex;
        align-items: center;
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 1rem;
        padding: 0.2rem;
    }
    .act:hover:not(:disabled) {
        color: var(--text);
    }
    .act:disabled {
        opacity: 0.4;
        cursor: default;
    }
    .more,
    .add {
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 4px;
        padding: 0.15rem 0.6rem;
        font-size: 0.8rem;
        cursor: pointer;
    }
    .add:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .panel {
        flex: 1;
        min-height: 0;
    }
    @media (max-width: 768px) {
        .full {
            display: none;
        }
    }
</style>
