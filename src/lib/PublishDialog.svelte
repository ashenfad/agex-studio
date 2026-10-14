<script>
    /**
     * Publish a session as a secret gist: how much of it (as it is now,
     * or with its history), to the gist it went to before or a new one,
     * and, once published, the links that open it.
     */
    import { runUrl } from './gist.js'
    import { studio } from './studio.svelte.js'

    /** @type {{ name: string, onClose: () => void }} */
    let { name, onClose } = $props()

    const title = $derived(studio.sessions.find((s) => s.name === name)?.title || 'Untitled')

    /** @type {"current" | "everything"} */
    let shape = $state('current')
    let fresh = $state(false)
    let understood = $state(false)
    /** @type {import('./gist.js').GistRef | null} */
    let prior = $state(null)
    /** @type {{ stage: 'choose' } | { stage: 'working' } | { stage: 'done', gist: import('./gist.js').GistRef & { url: string, replaced: boolean, size: number } } | { stage: 'failed', message: string }} */
    let step = $state({ stage: 'choose' })
    /** @type {string | null} */
    let copied = $state(null)

    $effect(() => {
        void studio.published(name).then((p) => (prior = p))
    })

    async function publish() {
        step = { stage: 'working' }
        try {
            step = { stage: 'done', gist: await studio.publish(name, { shape, fresh }) }
        } catch (e) {
            step = { stage: 'failed', message: e instanceof Error ? e.message : String(e) }
        }
    }

    /** @param {string} text */
    async function copy(text) {
        await navigator.clipboard.writeText(text)
        copied = text
    }

    /** @param {number} n */
    const size = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)
</script>

<div class="backdrop" role="presentation" onclick={onClose}>
    <div class="dialog" role="dialog" aria-label="Publish" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Publish “{title}”</h2>
        {#if step.stage === 'done'}
            {@const gist = step.gist}
            <p class="hint">Published{gist.replaced ? ' to a new gist: the earlier one was gone' : ''} ({size(gist.size)}). Anyone with a link can open it; publishing again updates it, and the links stay.</p>
            {#each [{ label: 'The app alone', url: runUrl(location.origin, gist, { play: true }) }, { label: 'The app and how it was made', url: runUrl(location.origin, gist) }] as link (link.url)}
                <div class="link">
                    <span>{link.label}</span>
                    <code>{link.url}</code>
                    <button class="secondary" onclick={() => copy(link.url)}>{copied === link.url ? 'Copied' : 'Copy'}</button>
                </div>
            {/each}
            <p class="hint"><a href={gist.url} target="_blank" rel="noreferrer">The gist on GitHub</a></p>
            <div class="actions"><button onclick={onClose}>Done</button></div>
        {:else}
            <label class="check">
                <input type="radio" bind:group={shape} value="current" />
                As it is now: the files and the conversation, without the history (smaller)
            </label>
            <label class="check">
                <input type="radio" bind:group={shape} value="everything" />
                With its history, so each turn can be undone
            </label>
            {#if prior}
                <label class="check">
                    <input type="checkbox" bind:checked={fresh} />
                    As a new gist, rather than updating the one it was published to
                </label>
            {/if}
            <label class="check">
                <input type="checkbox" bind:checked={understood} />
                Anyone with the link can see all of it: the files, the conversation, and the app.
            </label>
            {#if step.stage === 'failed'}<p class="hint warn">{step.message}</p>{/if}
            <div class="actions">
                <button class="secondary" onclick={onClose}>Cancel</button>
                <button onclick={publish} disabled={!understood || step.stage === 'working'}>{step.stage === 'working' ? 'Publishing…' : prior && !fresh ? 'Update' : 'Publish'}</button>
            </div>
        {/if}
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 50%);
        display: grid;
        place-items: center;
        /* the modal layer: above the drawer, the switch button, the pill */
        z-index: 50;
    }
    .dialog {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 1.2rem;
        width: min(32rem, 92vw);
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }
    h2 {
        font-family: var(--font-display);
        font-size: 1.2rem;
    }
    .check {
        display: flex;
        gap: 0.5rem;
        align-items: flex-start;
        font-size: 0.85rem;
    }
    .hint {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin: 0;
    }
    .hint a {
        color: var(--accent);
    }
    .warn {
        color: var(--error);
    }
    .link {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.8rem;
    }
    .link span {
        width: 100%;
        color: var(--text-muted);
    }
    .link code {
        flex: 1;
        min-width: 0;
        overflow-x: auto;
        white-space: nowrap;
        background: var(--input-bg);
        padding: 0.3rem 0.4rem;
        border-radius: 4px;
    }
    .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
    }
    button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.4rem 1rem;
        cursor: pointer;
    }
    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .secondary {
        background: transparent;
        border: 1px solid var(--border);
        color: var(--text);
    }
</style>
