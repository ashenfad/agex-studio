<script>
    /** The turn running now, as its events stream in, opening as the
     *  stored turn will (the person's message, a delegate's task, or the
     *  answers that woke it). The artifacts a reply embeds show as it
     *  does; the rest once the turn ends. */
    import AgentItems from './AgentItems.svelte'
    import { notesIn } from './notes.js'
    import TurnOpening from './TurnOpening.svelte'

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

<!-- a woken turn's opening comes as it starts: until then, nothing -->
{#if prompt !== ''}<TurnOpening {session} text={prompt} />{/if}
<div class="agent">
    <AgentItems {session} {items} streaming />
</div>

