<script>
    /** The turn running now, as its events stream in. The artifacts a
     *  reply embeds show as it does; the rest once the turn ends. */
    import AgentItems from './AgentItems.svelte'
    import { notesIn } from './notes.js'
    import UserBubble from './UserBubble.svelte'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, prompt: string, parts: import('./studio.svelte.js').LivePart[] }} */
    let { session, prompt, parts } = $props()

    const items = $derived(
        parts.flatMap((part) => {
            /** @type {import('./activity.js').Item[]} */
            const out = []
            if (part.kind === 'text' || part.kind === 'thinking') out.push(part)
            // the notes a result carried show where they were delivered
            else if (part.kind === 'tool') out.push({ ...part, result: part.result === null ? null : notesIn(part.result).bare, images: [] })
            else if (part.kind === 'notes') for (const n of part.notes) out.push({ kind: 'note', from: n.kind, label: n.label, text: n.text })
            else if (part.kind === 'folded') out.push(part)
            return out
        }),
    )
</script>

<div class="user-row"><UserBubble {session} text={prompt} /></div>
<div class="agent">
    <AgentItems {session} {items} streaming />
</div>

<style>
    .user-row {
        display: flex;
        justify-content: flex-end;
    }
</style>
