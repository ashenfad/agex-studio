<script>
    /**
     * One session's actions, in one place: its name; a fork of it (with
     * its conversation, its files alone, or as it is now without its
     * history; sharing its app's database or with a copy of its own); a
     * bundle of it to keep or share; publishing it; its variables
     * (configuration anyone may read: `window.env` in its app, `env` for
     * its agent), set, changed and removed; its app's database (its size, the sessions sharing it, keeping it on
     * this device, an export, its checkpoints to restore); and deleting it (with sync on, from this
     * device or everywhere). With sync on, the database's sync too, and
     * the choice when it changed here and elsewhere in ways that don't
     * fit together.
     */
    import { onMount, untrack } from 'svelte'
    import { appDbs } from './app-db-clients.js'
    import { formatBytes } from './bytes.js'
    import { formatDate } from './format-time.js'
    import { errorText } from './errors.js'
    import { askPersist, isPersisted } from './persist.js'
    import Dialog from './Dialog.svelte'
    import { distribution } from './distribution.svelte.js'
    import { PLANE } from './store.js'
    import { studio } from './studio.svelte.js'
    import { sync } from './sync.svelte.js'
    import { VARIABLES_KEY, variablesOf } from './variables.js'
    import { vault } from './vault.svelte.js'

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

    /** The session, if this page has it open: its variables are live there. */
    const openSession = $derived(studio.current?.name === name ? studio.current : (studio.opened(name) ?? null))
    /** Its variables as read from its plane, when it isn't open here. @type {Record<string, string>} */
    let readVariables = $state({})
    const variables = $derived(openSession?.variables ?? readVariables)
    /** The names its agent has as keys: a variable under one is left out of the agent's world. */
    const keyNames = $derived(new Set(Object.keys(vault.agentSecrets(name))))
    /** Values being edited, by name. @type {Record<string, string>} */
    let edits = $state({})
    let newName = $state('')
    let newValue = $state('')
    /** What the last change was refused for, a line each. @type {string[]} */
    let variableErrors = $state([])

    /** Set or remove variables (null removes), as the session's own
     *  method checks them. @param {Record<string, string | null>} changes */
    async function setVariables(changes) {
        let done = false
        await act(async () => {
            let session = studio.opened(name)
            if (session === undefined) {
                await studio.switchTo(name)
                session = studio.opened(name)
            }
            variableErrors = (await session?.setVariables(changes)) ?? ['the session isn\'t open']
            done = variableErrors.length === 0
        })
        return done
    }

    /** Keep an edited value, if it changed. @param {string} n */
    async function saveEdit(n) {
        const value = edits[n]
        if (value === undefined || value === variables[n]) return
        if (await setVariables({ [n]: value })) delete edits[n]
    }

    async function addVariable() {
        const n = newName.trim()
        if (n === '') return
        if (await setVariables({ [n]: newValue })) {
            newName = ''
            newValue = ''
        }
    }

    /** Whether a fork takes a copy of the app's database of its own,
     *  rather than sharing it. */
    let ownDb = $state(false)

    /** @param {'full' | 'fresh' | 'compact'} inherit */
    function fork(inherit) {
        return act(
            async () => {
                await studio.switchTo(name)
                await studio.fork(inherit, { ownDb: db != null && ownDb })
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

    /** The database's checkpoints, newest first.
     *  @type {import('./app-db-clients.js').Checkpoint[]} */
    let checkpoints = $state([])
    /** What a new checkpoint is called. */
    let label = $state('')
    /** The checkpoint whose restore waits on a second click. @type {string | null} */
    let confirming = $state(null)
    /** What the last restore did. @type {string | null} */
    let restored = $state(null)

    /** Read the database and its checkpoints again. */
    async function readDb() {
        const found = await appDbs.describe(name)
        db = found
        checkpoints = found === null ? [] : (await appDbs.checkpoints(name)).reverse()
    }

    onMount(() => {
        // a session not open here: its variables as its plane has them
        if (studio.opened(name) === undefined) {
            studio
                .withWorkspace(name, async (ws) => variablesOf(await ws.plane(PLANE).get(VARIABLES_KEY)))
                .then((v) => (readVariables = v))
                .catch(() => {})
        }
        // a delegate's app uses its lead's database, shown there
        if (name.includes('.')) {
            db = null
            return
        }
        readDb().catch((e) => {
            db = null
            failed = `The app's database couldn't be read: ${errorText(e)}`
        })
        isPersisted().then((p) => (persisted = p))
    })

    function takeCheckpoint() {
        return act(async () => {
            await appDbs.checkpoint(name, label.trim())
            label = ''
            restored = null
            await readDb()
        })
    }

    /** @param {string} id */
    function restore(id) {
        return act(async () => {
            confirming = null
            const result = await appDbs.restore(name, id)
            // a restore is a change here: synced like any
            if (result.how !== 'none') sync.dbChanged(name)
            restored =
                result.how === 'none'
                    ? 'It was at that checkpoint already.'
                    : `Restored: ${result.undone === 1 ? '1 change' : `${result.undone} changes`} undone. The app reloads.`
            await readDb()
        })
    }

    /** @param {string} id */
    function forget(id) {
        return act(async () => {
            await appDbs.deleteCheckpoint(name, id)
            await readDb()
        })
    }

    function exportDb() {
        return act(async () => {
            const base = (entry?.title || 'app').replace(/[^\p{L}\p{N} _-]+/gu, '').trim() || 'app'
            download(await appDbs.exportFile(name), `${base}.sqlite`)
        })
    }

    /** Where the database's sync stands. */
    const dbSync = $derived(db ? sync.dbState(name) : undefined)

    /** Settle the database's conflict on `side`. @param {'mine' | 'theirs'} side */
    function settleDb(side) {
        return act(async () => {
            await sync.resolveDb(name, side)
            await readDb()
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
        {#if db}
            <label class="check">
                <input type="checkbox" disabled={working} bind:checked={ownDb} />
                <span>
                    With its own copy of the app's database
                    <small>{ownDb ? 'As it is now: what either app writes after stays its own' : 'Otherwise the two share it: what either app writes, the other sees'}</small>
                </span>
            </label>
        {/if}
    </section>

    <section>
        <h3>Share</h3>
        <div class="row">
            <button disabled={working} onclick={() => exportAs('current')} title="A bundle (.agex) of everything as it is now: much smaller">Export as it is now</button>
            <button disabled={working} onclick={() => exportAs('everything')} title="A bundle (.agex) with its history, so each turn can be undone">Export with its history</button>
            <button disabled={working} onclick={onPublish}>Publish…</button>
        </div>
    </section>

    <section>
        <h3>Variables</h3>
        <p class="hint">
            Configuration anyone may read, like a service's URL: the app has them as <code>window.env</code>, the agent as <code>env</code>. They go with the session when
            it's shared or published, so a key never goes here: keys are in Settings, under Keys.
        </p>
        {#if Object.keys(variables).length > 0}
            <ul class="variables">
                {#each Object.entries(variables) as [n, value] (n)}
                    <li>
                        <code class="name">{n}</code>
                        <input
                            class="input small"
                            aria-label="Value of {n}"
                            value={edits[n] ?? value}
                            oninput={(e) => (edits[n] = e.currentTarget.value)}
                            onkeydown={(e) => e.key === 'Enter' && saveEdit(n)}
                            onblur={() => saveEdit(n)}
                        />
                        <button disabled={working} onclick={() => setVariables({ [n]: null })} aria-label="Remove {n}">Remove</button>
                        {#if keyNames.has(n)}<small>Hidden from the agent: one of its keys has this name.</small>{/if}
                    </li>
                {/each}
            </ul>
        {/if}
        <div class="row">
            <input class="input small name" bind:value={newName} placeholder="NAME" aria-label="New variable's name" />
            <input class="input small" bind:value={newValue} placeholder="Value" aria-label="New variable's value" onkeydown={(e) => e.key === 'Enter' && addVariable()} />
            <button disabled={working || newName.trim() === ''} onclick={addVariable}>Add</button>
        </div>
        {#if variableErrors.length > 0}
            <ul class="failed" role="alert">
                {#each variableErrors as e, i (i)}<li>{e}</li>{/each}
            </ul>
        {/if}
    </section>

    {#if db}
        <section>
            <h3>App database</h3>
            <p class="hint">
                {formatBytes(db.bytes)}, {db.tables.length === 1 ? '1 table' : `${db.tables.length} tables`}{#if db.tables.length > 0}: {db.tables.join(', ')}{/if}.
                {#if sharing.length > 0}Shared with {sharing.join(', ')}.{/if}
            </p>
            {#if dbSync?.state === 'conflict'}
                <div class="attention">
                    <p>{dbSync.detail} Nothing has changed until you pick a side; the other is kept as a checkpoint here.</p>
                    <div class="row">
                        <button disabled={working} onclick={() => settleDb('mine')} title="This device's data stands; the synced changes are kept as a checkpoint">Keep this device's</button>
                        {#if dbSync.conflict?.step !== 'adopt'}
                            <button disabled={working} onclick={() => settleDb('theirs')} title="The synced data stands; this device's changes are kept as a checkpoint">Use the synced</button>
                        {/if}
                    </div>
                </div>
            {:else if dbSync?.state === 'too-large'}
                <p class="hint">{dbSync.detail} Syncing it uploads a copy of it whole now and then.</p>
            {:else if dbSync?.state === 'error'}
                <p class="hint">Its sync failed: {dbSync.detail}</p>
            {:else if dbSync?.state === 'waiting'}
                <p class="hint">{dbSync.detail} It syncs again shortly.</p>
            {:else if dbSync?.state === 'pending'}
                <p class="hint">{dbSync.detail}</p>
            {:else if sync.syncs(name)}
                <p class="hint">{dbSync?.state === 'synced' ? 'Synced with the session.' : 'It syncs with the session.'}</p>
            {:else}
                <p class="hint">
                    On this device only{sync.connected ? ' until the session syncs (once it has a name)' : ': sync is off'}, so export it to keep a copy.
                    {#if persisted === false}The browser may also clear it when space runs low.{/if}
                </p>
            {/if}
            <div class="row">
                {#if dbSync?.state === 'too-large'}
                    <button disabled={working} onclick={() => act(() => sync.allowLarge(db?.id ?? '', name))}>Sync it anyway</button>
                {:else if dbSync?.state === 'error' || dbSync?.state === 'waiting'}
                    <button disabled={working} onclick={() => act(() => sync.syncDbNow(name))}>Retry</button>
                {/if}
                <button disabled={working} onclick={exportDb} title="A SQLite file (.sqlite) any SQLite tool opens">Export as .sqlite</button>
                {#if persisted === false}
                    <button disabled={working} onclick={keep} title="Ask the browser not to clear the studio's data when space runs low">Keep it on this device</button>
                {/if}
            </div>
            <h4>Checkpoints</h4>
            <p class="hint">
                Points to bring the app's data back to. One is taken before each change to its tables (the last 10 are kept), and you can take your own.
            </p>
            {#if checkpoints.length > 0}
                <ul class="checkpoints">
                    {#each checkpoints as cp (cp.id)}
                        <li>
                            <span class="what">
                                {cp.label || 'Checkpoint'}
                                <small>{cp.auto ? 'automatic' : 'yours'} · {formatDate(new Date(cp.time).toISOString())}</small>
                            </span>
                            {#if confirming === cp.id}
                                <span class="confirm">
                                    Everything stored since is lost.
                                    <button class="danger" disabled={working} onclick={() => restore(cp.id)}>Restore</button>
                                    <button disabled={working} onclick={() => (confirming = null)}>Cancel</button>
                                </span>
                            {:else}
                                <button disabled={working} onclick={() => (confirming = cp.id)} title="Bring the app's data back to this">Restore…</button>
                                <button class="icon" disabled={working} onclick={() => forget(cp.id)} title="Delete this checkpoint" aria-label="Delete this checkpoint">×</button>
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
            {#if restored}<p class="hint">{restored}</p>{/if}
            <div class="row">
                <input
                    class="input small"
                    bind:value={label}
                    placeholder="What it's before (optional)"
                    onkeydown={(e) => e.key === 'Enter' && takeCheckpoint()}
                />
                <button disabled={working} onclick={takeCheckpoint}>Take a checkpoint</button>
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
                <button disabled={working} onclick={() => act(() => studio.remove(name, { keepDb: true }), { close: true })} title="It stays in the sync repo, and shows in the list as a cloud session">From this device</button>
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
    h4 {
        font-family: var(--font-body);
        font-size: 0.8rem;
        font-weight: 600;
        margin: 0.8rem 0 0.25rem;
    }
    .checkpoints {
        list-style: none;
        margin: 0 0 0.5rem;
        padding: 0;
        max-height: 12rem;
        overflow-y: auto;
        border: 1px solid var(--border);
        border-radius: 6px;
    }
    .checkpoints li {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
        padding: 0.35rem 0.5rem;
        font-size: 0.85rem;
    }
    .checkpoints li + li {
        border-top: 1px solid var(--border);
    }
    .checkpoints .what {
        flex: 1;
        min-width: 10rem;
        overflow-wrap: anywhere;
    }
    .checkpoints small {
        display: block;
        font-size: 0.72rem;
        color: var(--text-muted);
    }
    .checkpoints .confirm {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.78rem;
        color: var(--text-muted);
    }
    .checkpoints button {
        padding: 0.2rem 0.55rem;
        font-size: 0.8rem;
    }
    .checkpoints .icon {
        padding: 0.2rem 0.45rem;
    }
    .input.small {
        flex: 1;
        min-width: 10rem;
        padding: 0.3rem 0.55rem;
        font-size: 0.85rem;
    }
    .check {
        display: flex;
        align-items: flex-start;
        gap: 0.45rem;
        margin-top: 0.5rem;
        font-size: 0.85rem;
        cursor: pointer;
    }
    .check input {
        margin-top: 0.2rem;
    }
    .check small {
        display: block;
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
    .attention {
        border: 1px solid var(--caution);
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        margin-block: 0.5rem;
    }
    .attention p {
        margin: 0 0 0.5rem;
        font-size: 0.8rem;
    }
    .danger {
        border-color: var(--error) !important;
        color: var(--error) !important;
    }
    .failed {
        color: var(--error);
        font-size: 0.8rem;
    }
    ul.failed {
        margin: 0.4rem 0 0;
        padding-left: 1rem;
    }
    .variables {
        list-style: none;
        margin: 0 0 0.5rem;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }
    .variables li {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
    }
    .variables .name {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        min-width: 7rem;
        overflow-wrap: anywhere;
    }
    .variables small {
        flex-basis: 100%;
        font-size: 0.72rem;
        color: var(--text-muted);
    }
    .input.small.name {
        flex: 0 1 9rem;
        min-width: 6rem;
        font-family: var(--font-mono);
    }
    .hint code {
        font-family: var(--font-mono);
        font-size: 0.78rem;
    }
</style>
