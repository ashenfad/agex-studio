<script>
    /**
     * One session's actions, in one place: its name; a fork of it (with
     * its conversation, its files alone, or as it is now without its
     * history); a bundle of it to keep or share; publishing it; its
     * app's database (its size, the sessions sharing it, keeping it on
     * this device, an export); and deleting it (with sync on, from this
     * device or everywhere).
     */
    import { onMount, untrack } from 'svelte'
    import { appDbs } from './app-db-clients.js'
    import { formatBytes } from './bytes.js'
    import { errorText } from './errors.js'
    import { askPersist, isPersisted } from './persist.js'
    import Dialog from './Dialog.svelte'
    import { distribution } from './distribution.svelte.js'
    import { studio } from './studio.svelte.js'
    import { sync } from './sync.svelte.js'

    /** @type {{ name: string, onClose: () => void, onPublish: () => void, onPicked?: () => void }} */
    let { name, onClose, onPublish, onPicked = () => {} } = $props()

    const entry = $derived(studio.sessions.find((s) => s.name === name))
    /** The name as it was when the dialog opened; the person edits from there. */
    let title = $state(untrack(() => entry?.title ?? ''))

    let deleting = $state(false)
    let working = $state(false)
    /** @type {string | null} */
    let failed = $state(null)

    /** @param {() => Promise<unknown>} fn @param {{ close?: boolean, picked?: boolean }} [after] */
    async function act(fn, after = {}) {
        failed = null
        working = true
        try {
            await fn()
            if (after.close) onClose()
            if (after.picked) onPicked()
        } catch (e) {
            failed = errorText(e)
        } finally {
            working = false
        }
    }

    async function rename() {
        const next = title.trim()
        if (next === '' || next === entry?.title) return
        await act(async () => {
            await studio.switchTo(name)
            await studio.current?.rename(next)
        })
    }

    /** @param {'full' | 'fresh' | 'compact'} inherit */
    function fork(inherit) {
        return act(
            async () => {
                await studio.switchTo(name)
                await studio.fork(inherit)
            },
            { close: true, picked: true },
        )
    }

    /** @param {Uint8Array} bytes @param {string} fileName */
    function download(bytes, fileName) {
        const a = document.createElement('a')
        a.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }))
        a.download = fileName
        a.click()
        URL.revokeObjectURL(a.href)
    }

    /** @param {'everything' | 'current'} shape */
    function exportAs(shape) {
        return act(async () => {
            const { bytes, fileName } = await distribution.exportBundle(name, shape)
            download(bytes, fileName)
        })
    }

    /** The app's database: undefined while it's looked up, null if the
     *  app has kept none. @type {import('./app-db-clients.js').DbSummary | null | undefined} */
    let db = $state(undefined)
    /** Whether the browser keeps the studio's storage; null if it can't say. */
    /** @type {boolean | null} */
    let persisted = $state(null)
    /** The other sessions sharing the database, by title. */
    const sharing = $derived(
        (db?.sessions ?? []).filter((n) => n !== name).map((n) => studio.sessions.find((s) => s.name === n)?.title || 'Untitled'),
    )

    onMount(() => {
        // a delegate's app uses its lead's database, shown there
        if (name.includes('.')) {
            db = null
            return
        }
        appDbs.describe(name).then(
            (found) => (db = found),
            (e) => {
                db = null
                failed = `The app's database couldn't be read: ${errorText(e)}`
            },
        )
        isPersisted().then((p) => (persisted = p))
    })

    function exportDb() {
        return act(async () => {
            const base = (entry?.title || 'app').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'app'
            download(await appDbs.exportFile(name), `${base}.sqlite`)
        })
    }

    function keep() {
        return act(async () => {
            persisted = await askPersist()
            if (!persisted) throw new Error("The browser didn't agree to keep it: it decides by how the site is used (in Safari, add the studio to the home screen)")
        })
    }
</script>

<Dialog label="Session" {onClose} width="30rem">
    <label class="field">
        <span>Name</span>
        <input
            class="input"
            bind:value={title}
            placeholder="New session"
            onkeydown={(e) => e.key === 'Enter' && rename()}
            onblur={rename}
        />
    </label>

    <section>
        <h3>Fork</h3>
        <p class="hint">A new session to try something else, leaving this one as it is.</p>
        <div class="choices">
            <button disabled={working} onclick={() => fork('full')}><b>With its conversation</b><span>Everything, history and all</span></button>
            <button disabled={working} onclick={() => fork('fresh')}><b>Its files only</b><span>A fresh conversation over the same files</span></button>
            <button disabled={working} onclick={() => fork('compact')}><b>As it is now</b><span>Files and conversation without the history: much smaller</span></button>
        </div>
    </section>

    <section>
        <h3>Share</h3>
        <div class="row">
            <button disabled={working} onclick={() => exportAs('current')} title="A bundle (.agex) of everything as it is now: much smaller">Export as it is now</button>
            <button disabled={working} onclick={() => exportAs('everything')} title="A bundle (.agex) with its history, so each turn can be undone">Export with its history</button>
            <button disabled={working} onclick={onPublish}>Publish…</button>
        </div>
    </section>

    {#if db}
        <section>
            <h3>App database</h3>
            <p class="hint">
                {formatBytes(db.bytes)}, {db.tables.length === 1 ? '1 table' : `${db.tables.length} tables`}{#if db.tables.length > 0}: {db.tables.join(', ')}{/if}.
                {#if sharing.length > 0}Shared with {sharing.join(', ')}.{/if}
            </p>
            <p class="hint">
                On this device only: sync doesn't carry it yet, so export it to keep a copy.
                {#if persisted === false}The browser may also clear it when space runs low.{/if}
            </p>
            <div class="row">
                <button disabled={working} onclick={exportDb} title="A SQLite file (.sqlite) any SQLite tool opens">Export as .sqlite</button>
                {#if persisted === false}
                    <button disabled={working} onclick={keep} title="Ask the browser not to clear the studio's data when space runs low">Keep it on this device</button>
                {/if}
            </div>
        </section>
    {/if}

    <section>
        <h3>Delete</h3>
        {#if !deleting}
            <div class="row"><button class="danger" disabled={working} onclick={() => (deleting = true)}>Delete…</button></div>
        {:else if sync.synced(name)}
            <p class="hint">It's in the sync repo too.</p>
            <div class="row">
                <button disabled={working} onclick={() => act(() => studio.remove(name), { close: true })} title="It stays in the sync repo, and shows in the list as a cloud session">From this device</button>
                <button class="danger" disabled={working} onclick={() => act(() => sync.deleteEverywhere(name), { close: true })} title="Into the sync repo's trash, on every device: restorable until it's emptied">Everywhere</button>
                <button disabled={working} onclick={() => (deleting = false)}>Keep it</button>
            </div>
        {:else}
            <p class="hint">Delete “{entry?.title || 'New session'}” for good?</p>
            <div class="row">
                <button class="danger" disabled={working} onclick={() => act(() => studio.remove(name), { close: true })}>Delete it</button>
                <button disabled={working} onclick={() => (deleting = false)}>Keep it</button>
            </div>
        {/if}
    </section>

    {#if failed}<p class="failed">{failed}</p>{/if}
</Dialog>

<style>
    h3 {
        font-family: var(--font-body);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-bottom: 0.35rem;
    }
    .field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    .field .input {
        padding: 0.45rem 0.6rem;
        font-size: 0.95rem;
    }
    .hint {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin-bottom: 0.4rem;
    }
    .choices {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }
    .choices button {
        display: flex;
        flex-direction: column;
        align-items: flex-start;
        gap: 0.1rem;
        text-align: left;
        padding: 0.45rem 0.7rem;
    }
    .choices span {
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    .row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
    }
    section button {
        background: var(--bg);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 6px;
        padding: 0.3rem 0.7rem;
        font: inherit;
        font-size: 0.85rem;
        cursor: pointer;
    }
    section button:hover:not(:disabled) {
        border-color: var(--text-muted);
    }
    section button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .danger {
        border-color: var(--error) !important;
        color: var(--error) !important;
    }
    .failed {
        color: var(--error);
        font-size: 0.8rem;
    }
</style>
