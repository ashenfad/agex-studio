<script>
    /**
     * The session's files under /workspace, as a tree in the workbench:
     * folders open and close, and a file opens in a modal to read,
     * download, or delete. Files are added (uploaded, or from Google
     * Drive) under uploads/, from the workbench's bar.
     */
    import { errorText } from './errors.js'
    import { pickFromDrive } from './drive-import.js'
    import FileModal from './FileModal.svelte'

    /** @type {{ session: import('./session.svelte.js').ChatSession }} */
    let { session } = $props()

    /** The folders closed, by path. */
    let closed = $state(/** @type {Record<string, boolean>} */ ({}))
    /** @type {string | null} */
    let opened = $state(null)
    /** What came of the last add: the paths added, or what failed. */
    let added = $state('')
    /** @type {HTMLInputElement | undefined} */
    let picker = $state()

    /** A listed path that prefixes another is a folder. */
    const entries = $derived.by(() => {
        const all = session.files
        return all.map((path) => ({
            path,
            depth: path.split('/').length - 1,
            name: path.split('/').at(-1) ?? path,
            dir: all.some((other) => other.startsWith(`${path}/`)),
        }))
    })
    /** The entries under no closed folder. */
    const shown = $derived(entries.filter((e) => !Object.keys(closed).some((dir) => closed[dir] && e.path.startsWith(`${dir}/`))))

    // the list follows the work: a turn's tool calls may write files
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null
    $effect(() => {
        void session.appStamp
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(() => void session.refreshFiles(), 400)
        return () => {
            if (timer !== null) clearTimeout(timer)
        }
    })

    /** @param {{ name: string, bytes: Uint8Array }[]} files @param {string[]} [errors] */
    async function add(files, errors = []) {
        try {
            const paths = await session.importFiles(files)
            const done = paths.length > 0 ? `Added ${paths.map((p) => p.replace('/workspace/', '')).join(', ')}` : ''
            added = [done, ...errors].filter(Boolean).join('; ')
        } catch (e) {
            added = errorText(e)
        }
    }

    /** Ask for files from this device. */
    export function upload() {
        picker?.click()
    }

    async function uploadChosen() {
        const chosen = [...(picker?.files ?? [])]
        if (picker) picker.value = ''
        await add(await Promise.all(chosen.map(async (f) => ({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }))))
    }

    /** Ask for files from Google Drive. */
    export async function fromDrive() {
        try {
            const { files, errors } = await pickFromDrive()
            await add(files, errors)
        } catch (e) {
            added = errorText(e)
        }
    }
</script>

<input bind:this={picker} type="file" multiple hidden onchange={uploadChosen} />
<div class="files">
    {#if added}
        <p class="added">{added} <button class="dismiss" onclick={() => (added = '')} aria-label="Dismiss">✕</button></p>
    {/if}
    {#if entries.length === 0}
        <p class="empty">No files yet. The agent's work lands here, and files you add go under <code>uploads/</code>.</p>
    {:else}
        <ul>
            {#each shown as e (e.path)}
                <li style:padding-left={`${e.depth * 0.9}rem`}>
                    {#if e.dir}
                        <button class="row dir" onclick={() => (closed[e.path] = !closed[e.path])} aria-expanded={!closed[e.path]}>
                            <span class="chev" class:shut={closed[e.path]}>⌄</span>{e.name}/
                        </button>
                    {:else}
                        <button class="row" onclick={() => (opened = e.path)}><span class="chev"></span>{e.name}</button>
                    {/if}
                </li>
            {/each}
        </ul>
    {/if}
</div>

{#if opened !== null}
    <FileModal {session} path={opened} onClose={() => (opened = null)} />
{/if}

<style>
    .files {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        background: var(--bg);
    }
    ul {
        list-style: none;
        margin: 0;
        padding: 0.5rem 0.6rem;
    }
    .row {
        display: flex;
        align-items: baseline;
        gap: 0.3rem;
        width: 100%;
        background: none;
        border: none;
        border-radius: 4px;
        color: var(--text);
        cursor: pointer;
        font: inherit;
        font-size: 0.88rem;
        text-align: left;
        padding: 0.18rem 0.4rem;
    }
    .row:hover {
        background: var(--surface-hover);
    }
    .dir {
        color: var(--text-muted);
    }
    .chev {
        display: inline-block;
        width: 0.8rem;
        font-size: 0.7rem;
        transition: transform 0.15s ease;
    }
    .chev.shut {
        transform: rotate(-90deg);
    }
    .added {
        display: flex;
        gap: 0.5rem;
        align-items: center;
        margin: 0;
        padding: 0.4rem 0.8rem;
        border-bottom: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 0.8rem;
    }
    .dismiss {
        margin-left: auto;
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
    }
    .empty {
        padding: 1rem;
        color: var(--text-muted);
        font-size: 0.9rem;
    }
</style>
