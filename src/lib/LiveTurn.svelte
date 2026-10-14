<script>
    /** The turn running now, as its events stream in. The artifacts a
     *  reply embeds show as it does; the rest once the turn ends. */
    import AgentItems from './AgentItems.svelte'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, prompt: string, parts: import('./studio.svelte.js').LivePart[] }} */
    let { session, prompt, parts } = $props()

    const items = $derived(
        parts.flatMap((part) => {
            /** @type {import('./activity.js').Item[]} */
            const out = []
            if (part.kind === 'text' || part.kind === 'thinking') out.push(part)
            else if (part.kind === 'tool') out.push({ ...part, images: [] })
            else if (part.kind === 'notes') for (const text of part.texts) out.push({ kind: 'note', text })
            else if (part.kind === 'folded') out.push(part)
            return out
        }),
    )
</script>

<div class="user-row"><div class="user">{prompt}</div></div>
<div class="agent">
    <AgentItems {session} {items} streaming />
</div>

<style>
    .user-row {
        display: flex;
        justify-content: flex-end;
    }
    .user {
        max-width: 80%;
        background: var(--user-bubble);
        padding: 0.5rem 0.8rem;
        border-radius: 10px;
        white-space: pre-wrap;
    }
</style>
