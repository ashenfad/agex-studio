<script>
    /**
     * One session's actions, in one place: its name; a fork of it (with
     * its conversation, its files alone, or as it is now without its
     * history); a bundle of it to keep or share; publishing it; and
     * deleting it (with sync on, from this device or everywhere).
     */
    import { untrack } from 'svelte'
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
            failed = e instanceof Error ? e.message : String(e)
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

    /** @param {'everything' | 'current'} shape */
    function exportAs(shape) {
        return act(async () => {
            const { bytes, fileName } = await distribution.exportBundle(name, shape)
            const a = document.createElement('a')
            a.href = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/octet-stream' }))
            a.download = fileName
            a.click()
            URL.revokeObjectURL(a.href)
        })
    }
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="backdrop" onclick={onClose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="dialog" role="dialog" aria-label="Session" tabindex="-1" onclick={(e) => e.stopPropagation()}>
        <header>
            <h2>Session</h2>
            <button class="close" onclick={onClose} aria-label="Close">✕</button>
        </header>

        <label class="field">
            <span>Name</span>
            <input
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
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 50%);
        /* the modal layer: above the drawer, the switch button, the pill */
        z-index: 50;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
    }
    .dialog {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        width: min(30rem, 100%);
        max-height: 100%;
        overflow-y: auto;
        padding: 1rem 1.2rem 1.2rem;
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
        box-shadow: 0 10px 40px rgb(0 0 0 / 50%);
    }
    header {
        display: flex;
        align-items: center;
    }
    h2 {
        font-family: var(--font-display);
        font-size: 1.15rem;
        flex: 1;
    }
    h3 {
        font-family: var(--font-body);
        font-size: 0.72rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-bottom: 0.35rem;
    }
    .close {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 1rem;
    }
    .field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    input {
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.45rem 0.6rem;
        font: inherit;
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
