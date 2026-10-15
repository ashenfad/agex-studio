<script>
    /**
     * Publish a session as a secret gist: how much of it (as it is now,
     * or with its history), to the gist it went to before or a new one,
     * and, once published, the links that open it.
     */
    import Dialog from './Dialog.svelte'
    import { runUrl } from './gist.js'
    import { distribution } from './distribution.svelte.js'
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
        void distribution.published(name).then((p) => (prior = p))
    })

    async function publish() {
        step = { stage: 'working' }
        try {
            step = { stage: 'done', gist: await distribution.publish(name, { shape, fresh }) }
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

<Dialog label="Publish" title="Publish “{title}”" {onClose} width="32rem">
    {#if step.stage === 'done'}
        {@const gist = step.gist}
        <p class="hint">Published{gist.replaced ? ' to a new gist: the earlier one was gone' : ''} ({size(gist.size)}). Anyone with a link can open it; publishing again updates it, and the links stay.</p>
        {#each [{ label: 'The app alone', url: runUrl(location.origin, gist, { play: true }) }, { label: 'The app and how it was made', url: runUrl(location.origin, gist) }] as link (link.url)}
            <div class="link">
                <span>{link.label}</span>
                <code>{link.url}</code>
                <button class="btn secondary" onclick={() => copy(link.url)}>{copied === link.url ? 'Copied' : 'Copy'}</button>
            </div>
        {/each}
        <p class="hint"><a href={gist.url} target="_blank" rel="noreferrer">The gist on GitHub</a></p>
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
    {/if}
    {#snippet actions()}
        {#if step.stage === 'done'}
            <button class="btn" onclick={onClose}>Done</button>
        {:else}
            <button class="btn secondary" onclick={onClose}>Cancel</button>
            <button class="btn" onclick={publish} disabled={!understood || step.stage === 'working'}>{step.stage === 'working' ? 'Publishing…' : prior && !fresh ? 'Update' : 'Publish'}</button>
        {/if}
    {/snippet}
</Dialog>

<style>
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
</style>
