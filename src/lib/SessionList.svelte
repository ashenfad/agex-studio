<script>
    /**
     * The sessions: newest first, the one looked at marked, and for
     * each a menu to rename, fork (with its conversation, its files
     * alone, or as it is now without its history), export as a bundle,
     * and delete. A bundle (.agex) opens as a new session. With sync on, each shows its sync (a glyph,
     * and the choices when it needs the person), and below them the
     * repo's other sessions to download and its trash.
     */
    import { formatDate } from './format-time.js'
    import PublishDialog from './PublishDialog.svelte'
    import { studio } from './studio.svelte.js'
    import { sync } from './sync.svelte.js'

    /** A row's sync glyph and what it says, or null when quiet.
     *  @param {string} name */
    function mark(name) {
        const st = sync.connected ? sync.status[name] : undefined
        if (st === undefined || st.state === 'synced') return null
        if (st.state === 'syncing') return { glyph: '↻', title: 'Syncing…' }
        if (st.state === 'pending') return { glyph: '↑', title: `Sync queued${st.detail ? ` (${st.detail})` : ''}` }
        return { glyph: '⚠', title: st.detail }
    }

    let emptying = $state(false)
    /** The session the publish dialog is for. @type {string | null} */
    let publishing = $state(null)

    /** @type {string | null} */
    let exporting = $state(null)
    /** @type {HTMLInputElement | undefined} */
    let picker = $state()

    /** @param {string} name @param {"everything" | "current"} shape */
    async function exportAs(name, shape) {
        await act(async () => {
            const { bytes, fileName } = await studio.exportBundle(name, shape)
            const a = document.createElement('a')
            a.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }))
            a.download = fileName
            a.click()
            URL.revokeObjectURL(a.href)
        })
        exporting = null
    }

    async function importPicked() {
        const file = picker?.files?.[0]
        if (picker) picker.value = ''
        if (file === undefined) return
        await act(async () => {
            await studio.importBundle(new Uint8Array(await file.arrayBuffer()))
        })
        onPicked()
    }

    /** @type {{ onPicked?: () => void }} */
    let { onPicked = () => {} } = $props()

    /** @type {string | null} */
    let menuFor = $state(null)
    /** @type {string | null} */
    let confirming = $state(null)
    /** @type {string | null} */
    let renaming = $state(null)
    let draft = $state('')
    /** @type {string | null} */
    let failed = $state(null)

    /** @param {() => Promise<unknown>} fn */
    async function act(fn) {
        failed = null
        menuFor = null
        try {
            await fn()
        } catch (e) {
            failed = e instanceof Error ? e.message : String(e)
        }
    }

    /** @param {string} name */
    async function pick(name) {
        await act(() => studio.switchTo(name))
        onPicked()
    }

    /** @param {string} name @param {string} title */
    function startRename(name, title) {
        renaming = name
        draft = title
        menuFor = null
    }

    async function finishRename() {
        const name = renaming
        renaming = null
        if (name === null || draft.trim() === '') return
        await act(async () => {
            await studio.switchTo(name)
            await studio.current?.rename(draft.trim())
        })
    }
</script>

<nav class="sessions">
    <div class="top">
        <button class="new" onclick={() => act(() => studio.create()).then(onPicked)}>+ New session</button>
        <button class="import" onclick={() => picker?.click()} title="Open a session bundle (.agex)">Import…</button>
        <input bind:this={picker} type="file" accept=".agex" hidden onchange={importPicked} />
    </div>
    {#if failed}<p class="failed">{failed}</p>{/if}
    <ul>
        {#each studio.sessions as s (s.name)}
            <li class:current={studio.current?.name === s.name}>
                {#if renaming === s.name}
                    <!-- svelte-ignore a11y_autofocus -->
                    <input
                        bind:value={draft}
                        autofocus
                        onkeydown={(e) => {
                            if (e.key === 'Enter') finishRename()
                            if (e.key === 'Escape') renaming = null
                        }}
                        onblur={finishRename}
                    />
                {:else}
                    <button class="row" onclick={() => pick(s.name)}>
                        <span class="title">{s.title || 'New session'}</span>
                        <span class="when">{formatDate(new Date(s.updatedAt).toISOString())}</span>
                    </button>
                    {#if studio.opened(s.name)?.jobs.length}
                        {@const open = /** @type {import('./studio.svelte.js').ChatSession} */ (studio.opened(s.name))}
                        {@const working = open.jobs.filter((j) => j.status === 'running').length}
                        {@const waiting = open.unread.length - working}
                        {#if working || waiting}
                            <span class="delegates" title={`${working} delegate(s) working, ${waiting} answer(s) unread`}>⑂{working || waiting}</span>
                        {/if}
                    {/if}
                    {#if mark(s.name)}
                        {@const m = mark(s.name)}
                        <span class="sync" title={m?.title}>{m?.glyph}</span>
                    {/if}
                    <button class="more" aria-label="Session actions" onclick={() => (menuFor = menuFor === s.name ? null : s.name)}>⋯</button>
                {/if}
                {#if menuFor === s.name}
                    <div class="menu">
                        <button onclick={() => startRename(s.name, s.title)}>Rename</button>
                        <button onclick={() => act(async () => { await studio.switchTo(s.name); await studio.fork('full') }).then(onPicked)}>Fork</button>
                        <button onclick={() => act(async () => { await studio.switchTo(s.name); await studio.fork('fresh') }).then(onPicked)}>Fork with files only</button>
                        <button onclick={() => act(async () => { await studio.switchTo(s.name); await studio.fork('compact') }).then(onPicked)} title="Everything as it is now, without the history: much smaller">Fork as it is now</button>
                        <button onclick={() => { exporting = s.name; menuFor = null }}>Export…</button>
                        <button onclick={() => { publishing = s.name; menuFor = null }}>Publish…</button>
                        <button class="danger" onclick={() => { confirming = s.name; menuFor = null }}>Delete…</button>
                    </div>
                {/if}
                {#if studio.updates[s.name]}
                    <div class="menu">
                        <span>A newer version was published.</span>
                        <button onclick={() => act(() => studio.update(s.name)).then(onPicked)}>Open it</button>
                        <button onclick={() => studio.dismissUpdate(s.name)}>Not now</button>
                    </div>
                {/if}
                {#if exporting === s.name}
                    <div class="menu">
                        <span>Export as a bundle (.agex):</span>
                        <button onclick={() => exportAs(s.name, 'current')} title="Everything as it is now: much smaller">As it is now</button>
                        <button onclick={() => exportAs(s.name, 'everything')} title="With its history, so each turn can be undone">With its history</button>
                        <button onclick={() => (exporting = null)}>Cancel</button>
                    </div>
                {/if}
                {#if confirming === s.name}
                    <div class="menu">
                        {#if sync.synced(s.name)}
                            <span>Delete “{s.title || 'New session'}”?</span>
                            <button onclick={() => act(() => studio.remove(s.name)).then(() => (confirming = null))} title="It stays in the sync repo, and shows below as a cloud session">From this device</button>
                            <button class="danger" onclick={() => act(() => sync.deleteEverywhere(s.name)).then(() => (confirming = null))} title="Into the sync repo's trash, on every device: restorable until it's emptied">Everywhere</button>
                        {:else}
                            <span>Delete “{s.title || 'New session'}” for good?</span>
                            <button class="danger" onclick={() => act(() => studio.remove(s.name)).then(() => (confirming = null))}>Delete</button>
                        {/if}
                        <button onclick={() => (confirming = null)}>Keep</button>
                    </div>
                {/if}
                {#if sync.connected && sync.status[s.name]?.state === 'diverged'}
                    <div class="menu attention">
                        <span>Changed on another device too.</span>
                        <button onclick={() => act(() => sync.useSynced(s.name))} title="This device's version is kept as a session of its own">Use the synced version</button>
                        <button onclick={() => act(() => sync.keepMine(s.name))} title="Written on top of the synced version, which stays in the history">Keep this device's</button>
                    </div>
                {:else if sync.connected && sync.status[s.name]?.state === 'remote-gone'}
                    <div class="menu attention">
                        <span>{sync.status[s.name]?.detail}</span>
                        <button onclick={() => act(() => sync.syncAgain(s.name))}>Sync it again</button>
                        <button class="danger" onclick={() => act(() => studio.remove(s.name))}>Delete here too</button>
                    </div>
                {:else if sync.connected && sync.status[s.name]?.state === 'error'}
                    <div class="menu attention">
                        <span>Sync failed: {sync.status[s.name]?.detail}</span>
                        <button onclick={() => act(() => sync.syncNow(s.name))}>Retry</button>
                    </div>
                {/if}
            </li>
        {/each}
    </ul>
    {#if sync.connected}
        {#if sync.problem}<p class="failed">Sync: {sync.problem}</p>{/if}
        {#if sync.cloud.length > 0}
            <h3>In the sync repo</h3>
            <ul>
                {#each sync.cloud as c (c.name)}
                    <li class="cloud">
                        <span class="row static">
                            <span class="title">☁ {c.title || 'Untitled'}</span>
                            {#if c.updatedAt}<span class="when">{formatDate(new Date(c.updatedAt).toISOString())}</span>{/if}
                        </span>
                        <button class="small" onclick={() => act(() => sync.download(c.name))}>Download</button>
                    </li>
                {/each}
            </ul>
        {/if}
        {#if sync.trash.length > 0}
            <details class="trash">
                <summary>Trash ({sync.trash.length})</summary>
                <ul>
                    {#each sync.trash as t (t.name)}
                        <li>
                            <span class="row static"><span class="title">{t.title || 'Untitled'}</span></span>
                            <button class="small" onclick={() => act(() => sync.restore(t.name))}>Restore</button>
                        </li>
                    {/each}
                </ul>
                {#if emptying}
                    <div class="menu">
                        <span>Delete these for good, on every device?</span>
                        <button class="danger" onclick={() => act(() => sync.emptyTrash()).then(() => (emptying = false))}>Empty the trash</button>
                        <button onclick={() => (emptying = false)}>Keep</button>
                    </div>
                {:else}
                    <button class="small" onclick={() => (emptying = true)}>Empty the trash…</button>
                {/if}
            </details>
        {/if}
    {/if}
</nav>

{#if publishing}
    <PublishDialog name={publishing} onClose={() => (publishing = null)} />
{/if}

<style>
    .sessions {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.6rem;
        height: 100%;
        overflow-y: auto;
    }
    .top {
        display: flex;
        gap: 0.4rem;
    }
    .top .new {
        flex: 1;
    }
    .import {
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 6px;
        padding: 0.45rem 0.6rem;
        cursor: pointer;
    }
    .new {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.45rem;
        cursor: pointer;
    }
    ul {
        list-style: none;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }
    li {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        border-radius: 6px;
    }
    li.current {
        background: var(--surface-hover);
    }
    .row {
        flex: 1;
        min-width: 0;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        background: none;
        border: none;
        color: var(--text);
        text-align: left;
        padding: 0.4rem 0.5rem;
        cursor: pointer;
    }
    .title {
        width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .when {
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    .more {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0 0.5rem;
    }
    .menu {
        width: 100%;
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        padding: 0.3rem 0.5rem 0.5rem;
        font-size: 0.8rem;
    }
    .menu button {
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 4px;
        padding: 0.2rem 0.5rem;
        cursor: pointer;
    }
    .menu .danger {
        border-color: var(--error);
        color: var(--error);
    }
    input {
        width: 100%;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 0.35rem;
        font: inherit;
    }
    .failed {
        color: var(--error);
        font-size: 0.8rem;
    }
    .delegates {
        color: var(--accent);
        font-size: 0.75rem;
        padding: 0 0.2rem;
    }
    .sync {
        color: var(--text-muted);
        font-size: 0.85rem;
        padding: 0 0.2rem;
    }
    .attention span {
        color: var(--error);
        width: 100%;
    }
    h3 {
        font-size: 0.75rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        margin-top: 0.6rem;
        padding: 0 0.5rem;
    }
    .static {
        cursor: default;
    }
    .small {
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 4px;
        padding: 0.15rem 0.5rem;
        font-size: 0.75rem;
        cursor: pointer;
        margin-right: 0.4rem;
    }
    .trash {
        margin-top: 0.6rem;
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .trash summary {
        cursor: pointer;
        padding: 0 0.5rem;
    }
</style>
