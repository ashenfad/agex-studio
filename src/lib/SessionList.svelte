<script>
    /**
     * The sessions: newest first, the one looked at marked, each with a
     * dot for its status (working; ended while the person was away,
     * gone wrong or not: see status.js). A name is
     * renamed by a double-click; a row's tray, on hover, forks it (⑂,
     * with its conversation) or opens its dialog (⋯: its name, the
     * other forks, export, publish, delete). A bundle (.agex) opens as a
     * new session. With sync on, each shows its sync (a glyph, and the
     * choices when it needs the person), and below them the repo's other
     * sessions to download and its trash.
     */
    import { formatDate } from './format-time.js'
    import { STATUS_TITLES, statusOf } from './status.js'
    import PublishDialog from './PublishDialog.svelte'
    import SessionDialog from './SessionDialog.svelte'
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

    /** @type {HTMLInputElement | undefined} */
    let picker = $state()

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

    /** The session whose dialog is open. @type {string | null} */
    let dialogFor = $state(null)
    /** @type {string | null} */
    let renaming = $state(null)
    let draft = $state('')
    /** @type {string | null} */
    let failed = $state(null)

    /** @param {() => Promise<unknown>} fn */
    async function act(fn) {
        failed = null
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
                    {@const shown = studio.opened(s.name)}
                    {@const status = shown ? statusOf(shown) : null}
                    <div class="line">
                        <button class="row" onclick={() => pick(s.name)} ondblclick={() => startRename(s.name, s.title)} title="Open it; double-click to rename">
                            <span class="title">
                                {#if status}<span class="dot {status}" role="img" aria-label={STATUS_TITLES[status]} title={STATUS_TITLES[status]}></span>{/if}{s.title || 'New session'}
                            </span>
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
                        <span class="tray">
                            <button
                                class="tool"
                                aria-label="Fork it"
                                title="Fork: a new session with this one's conversation and files, to try something else"
                                onclick={() => act(async () => { await studio.switchTo(s.name); await studio.fork('full') }).then(onPicked)}
                            >⑂</button>
                            <button class="tool" aria-label="More for this session" title="Rename, fork, export, publish, delete" onclick={() => (dialogFor = s.name)}>⋯</button>
                        </span>
                    </div>
                {/if}
                {#if studio.updates[s.name]}
                    <div class="menu">
                        <span>A newer version was published.</span>
                        <button onclick={() => act(() => studio.update(s.name)).then(onPicked)}>Open it</button>
                        <button onclick={() => studio.dismissUpdate(s.name)}>Not now</button>
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

{#if dialogFor}
    {@const name = dialogFor}
    <SessionDialog
        {name}
        onClose={() => (dialogFor = null)}
        onPublish={() => {
            dialogFor = null
            publishing = name
        }}
        {onPicked}
    />
{/if}
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
    /* A row: its title, its badges, and its tools over the end of it. */
    .line {
        /* what the tools fade into: the row's own background */
        --row-bg: var(--surface);
        position: relative;
        flex: 1;
        min-width: 0;
        display: flex;
        align-items: center;
        border-radius: 6px;
    }
    li.current .line {
        --row-bg: var(--surface-hover);
    }
    .line:hover {
        --row-bg: var(--surface-hover);
        background: var(--row-bg);
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
    /* a session's status, before its title: the accent pulsing while it
       works, amber when a turn went wrong while the person was away,
       green when one finished then */
    .dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        border-radius: 50%;
        margin-right: 0.4rem;
        vertical-align: 0.1em;
    }
    .dot.working {
        background: var(--accent);
        animation: pulse 1.2s ease-in-out infinite;
    }
    .dot.attention {
        background: var(--caution);
    }
    .dot.unseen {
        background: var(--success);
    }
    @media (prefers-reduced-motion: reduce) {
        .dot.working {
            animation: none;
        }
    }
    .when {
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    /* A row's tools sit over the end of its title, not beside it:
       hidden and click-through at rest, so the title has the row's
       whole width and a click anywhere on it opens the session; shown
       on hover, and on keyboard focus within the row. Keyboard focus,
       not any focus: a click leaves the row's button focused, and
       :focus-within would keep the tools over the title of the session
       just opened. */
    .tray {
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        display: flex;
        align-items: center;
        padding: 0 0.2rem 0 1.4rem;
        border-radius: 0 6px 6px 0;
        background: linear-gradient(to right, transparent, var(--row-bg) 1.1rem);
        opacity: 0;
        pointer-events: none;
        transition: opacity 0.15s;
    }
    .line:hover .tray,
    .line:has(:focus-visible) .tray {
        opacity: 1;
        pointer-events: auto;
    }
    /* where there's no hovering (a touch screen), the tools stay, beside
       the title */
    @media (hover: none) {
        .tray {
            position: static;
            padding-left: 0;
            background: none;
            opacity: 1;
            pointer-events: auto;
        }
    }
    .tool {
        background: none;
        border: none;
        border-radius: 4px;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.15rem 0.35rem;
        font-size: 0.9rem;
    }
    .tool:hover {
        color: var(--text);
        background: var(--surface);
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
