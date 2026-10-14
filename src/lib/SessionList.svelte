<script>
    /**
     * The sessions: newest first, the one looked at marked, and for
     * each a menu to rename, fork (with its conversation, or its files
     * alone) and delete.
     */
    import { formatDate } from './format-time.js'
    import { studio } from './studio.svelte.js'

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
    <button class="new" onclick={() => act(() => studio.create()).then(onPicked)}>+ New session</button>
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
                    <button class="more" aria-label="Session actions" onclick={() => (menuFor = menuFor === s.name ? null : s.name)}>⋯</button>
                {/if}
                {#if menuFor === s.name}
                    <div class="menu">
                        <button onclick={() => startRename(s.name, s.title)}>Rename</button>
                        <button onclick={() => act(async () => { await studio.switchTo(s.name); await studio.fork('full') }).then(onPicked)}>Fork</button>
                        <button onclick={() => act(async () => { await studio.switchTo(s.name); await studio.fork('fresh') }).then(onPicked)}>Fork with files only</button>
                        <button class="danger" onclick={() => { confirming = s.name; menuFor = null }}>Delete…</button>
                    </div>
                {/if}
                {#if confirming === s.name}
                    <div class="menu">
                        <span>Delete “{s.title || 'New session'}” for good?</span>
                        <button class="danger" onclick={() => act(() => studio.remove(s.name)).then(() => (confirming = null))}>Delete</button>
                        <button onclick={() => (confirming = null)}>Keep</button>
                    </div>
                {/if}
            </li>
        {/each}
    </ul>
</nav>

<style>
    .sessions {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 0.6rem;
        height: 100%;
        overflow-y: auto;
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
</style>
