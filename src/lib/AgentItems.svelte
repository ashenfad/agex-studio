<script>
    /**
     * An agent's turn, stored or streaming, as the transcript lays it
     * out: prose as markdown, with the artifacts it embeds in place;
     * each run of work as one line that opens to its steps; and the
     * mechanism's own notes, quietly; what the person sent mid-turn as
     * their own bubble, where it reached the agent.
     */
    import { groupWork } from './activity.js'
    import { renderMarkdown } from './markdown.js'
    import ReplyText from './ReplyText.svelte'
    import ThinkingBlock from './ThinkingBlock.svelte'
    import ToolGroup from './ToolGroup.svelte'
    import UserBubble from './UserBubble.svelte'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, items: import('./activity.js').Item[], streaming?: boolean, at?: string | null }} */
    let { session, items, streaming = false, at = null } = $props()

    const groups = $derived(groupWork(items, { streaming }))
    /** Whether the newest item already shows the turn is under way. */
    const tailLive = $derived.by(() => {
        const last = items.at(-1)
        return last?.kind === 'thinking' || last?.kind === 'text' || (last?.kind === 'tool' && last.result === null)
    })
</script>

{#each groups as g, i (i)}
    {#if g.kind === 'work'}
        <ToolGroup entries={g.entries} live={streaming} />
    {:else if g.kind === 'thinking'}
        {#if g.text.trim() !== ''}
            <ThinkingBlock text={g.text} live={streaming && i === groups.length - 1} />
        {/if}
    {:else if g.kind === 'text'}
        <ReplyText {session} {at} text={g.text} />
    {:else if g.kind === 'note' && g.from === 'principal'}
        <div class="mine"><UserBubble {session} text={g.text} label="Sent mid-turn" /></div>
    {:else if g.kind === 'note'}
        <div class="note">{g.label ? `${g.label}: ` : ''}{g.text.split('\n')[0]}</div>
    {:else if g.kind === 'closing'}
        <div class="note">{g.text}</div>
    {:else if g.kind === 'folded'}
        <details class="folded">
            <summary>The conversation up to here is folded into a summary for the model</summary>
            <div class="markdown">{@html renderMarkdown(g.summary)}</div>
        </details>
    {/if}
{/each}
{#if streaming && !tailLive}
    <div class="act-line act-live"><span class="act-verb">Working</span><span class="act-rest">…</span></div>
{/if}

<style>
    .mine {
        display: flex;
        justify-content: flex-end;
        margin: 0.4rem 0;
    }
    .note {
        color: var(--text-muted);
        font-size: 0.85rem;
        font-style: italic;
        margin: 0.3rem 0;
    }
    .folded {
        border-top: 1px dashed var(--border);
        border-bottom: 1px dashed var(--border);
        color: var(--text-muted);
        font-size: 0.8rem;
        margin: 0.6rem 0;
        padding: 0.3rem 0;
    }
    .folded summary {
        cursor: pointer;
    }
</style>
