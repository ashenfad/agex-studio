<script>
    /** The turn running now, as its events stream in. */
    import { renderMarkdown } from './markdown.js'
    import ToolCall from './ToolCall.svelte'

    /** @type {{ prompt: string, parts: import('./studio.svelte.js').LivePart[] }} */
    let { prompt, parts } = $props()
</script>

<div class="user">{prompt}</div>
<div class="agent">
    {#each parts as part, i (i)}
        {#if part.kind === 'thinking'}
            <details class="thinking" open><summary>thinking</summary>{part.text}</details>
        {:else if part.kind === 'text'}
            <div class="text">{@html renderMarkdown(part.text)}</div>
        {:else if part.kind === 'tool'}
            <ToolCall name={part.name} args={part.args} result={part.result} isError={part.isError} />
        {:else if part.kind === 'notes'}
            {#each part.texts as text}<div class="note">delivered: {text}</div>{/each}
        {:else if part.kind === 'folded'}
            <div class="note">earlier turns folded into a summary</div>
        {/if}
    {/each}
    <div class="working">working…</div>
</div>

<style>
    .user {
        align-self: flex-end;
        max-width: 80%;
        background: var(--user-bubble);
        padding: 0.5rem 0.8rem;
        border-radius: 10px;
        white-space: pre-wrap;
    }
    .thinking {
        color: var(--text-muted);
        font-size: 0.85rem;
        white-space: pre-wrap;
        margin: 0.3rem 0;
    }
    .note,
    .working {
        color: var(--text-muted);
        font-size: 0.85rem;
        font-style: italic;
        margin: 0.3rem 0;
    }
</style>
