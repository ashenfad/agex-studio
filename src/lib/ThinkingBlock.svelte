<script>
    /**
     * The model's reasoning, as one quiet line: "Thinking…" while it
     * streams, open so it can be read as it arrives; "Thought" once the
     * model moves on, folded, and opened by a click. Models think in
     * markdown, so it renders as such.
     */
    import { renderMarkdown } from './markdown.js'

    /** @type {{ text: string, live?: boolean }} */
    let { text, live = false } = $props()

    /** The person's choice, once they make one; till then it follows `live`. */
    /** @type {boolean | null} */
    let chosen = $state(null)
    const open = $derived(chosen ?? live)
</script>

<div>
    <button class="act-line" class:open class:act-live={live} onclick={() => (chosen = !open)}>
        <span class="act-verb">{live ? 'Thinking' : 'Thought'}</span>
        {#if live}<span class="act-rest">…</span>{/if}
        <span class="act-chev">⌄</span>
    </button>
    {#if open}
        <div class="act-body think markdown">{@html renderMarkdown(text)}</div>
    {/if}
</div>

<style>
    .think {
        color: var(--text-muted);
        font-size: 0.82rem;
        line-height: 1.5;
    }
</style>
