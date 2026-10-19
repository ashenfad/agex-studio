<script>
    /**
     * One stored run, as the chat shows it: the person's message, then
     * the agent's reply in the order it came (thinking, text, and each
     * tool call with its result), read from agex-ts's record. The `ui`
     * artifacts its code wrote are shown where the reply embeds them,
     * and the rest after it.
     */
    import { CLOSING_NOTE } from 'agex-ts'
    import { notesIn } from './notes.js'
    import AgentItems from './AgentItems.svelte'
    import Artifact from './Artifact.svelte'
    import { artifactsOf, unembedded } from './artifacts.js'
    import TurnOpening from './TurnOpening.svelte'

    /** @type {{ session: import('./session.svelte.js').ChatSession, run: import('agex-ts').Run, folds?: import('@agex-ts/world').Fold[], onUndo?: () => void, onEdit?: () => void, at?: string | null }} */
    let { session, run, folds = [], onUndo, onEdit, at = null } = $props()

    /** The folds whose last message is this one: the band goes after it. */
    /** @param {string} id */
    const foldsAfter = (id) => folds.filter((f) => f.through === id)

    /** Each call's result, by call id: they come in the tool message
     *  after the reply that made the call. */
    const results = $derived.by(() => {
        /** @type {Map<string, import('agex-ts').ToolResult>} */
        const out = new Map()
        for (const message of run.messages) {
            for (const part of message.parts) {
                if (part.kind === 'tool_result') out.set(part.callId, part)
            }
        }
        return out
    })

    /** @param {import('agex-ts').Message} message */
    const textOf = (message) =>
        message.parts.map((p) => (p.kind === 'text' ? p.text : '')).join('')

    const opening = $derived(run.messages[0]?.role === 'user' ? textOf(run.messages[0]) : null)
    const rest = $derived(opening === null ? run.messages : run.messages.slice(1))

    /** The reply, as the transcript lays it out: each call with its
     *  result, and a fold's band after the message it ends at. */
    const items = $derived.by(() => {
        /** @type {import('./activity.js').Item[]} */
        const out = []
        for (const message of rest) {
            if (message.role === 'assistant') {
                for (const part of message.parts) {
                    if (part.kind === 'thinking') out.push({ kind: 'thinking', text: part.text })
                    else if (part.kind === 'text' && part.text.startsWith(CLOSING_NOTE)) out.push({ kind: 'closing', text: part.text })
                    else if (part.kind === 'text') out.push({ kind: 'text', text: part.text })
                    else if (part.kind === 'tool_call') {
                        const result = results.get(part.callId)
                        // what the person (or the mechanism) sent mid-turn rode this result
                        const { bare, notes } = result === undefined ? { bare: null, notes: [] } : notesIn(result.content)
                        out.push({
                            kind: 'tool',
                            name: part.name,
                            args: { ...part.args },
                            // a call the run ended before answering has no result
                            result: bare,
                            isError: result?.isError ?? false,
                            images: result?.images ?? [],
                        })
                        for (const n of notes) out.push({ kind: 'note', from: n.kind, label: n.label, text: n.text })
                    }
                }
            } else if (message.role === 'user') {
                out.push({ kind: 'note', from: 'mechanism', label: '', text: textOf(message) })
            }
            for (const fold of foldsAfter(message.id)) out.push({ kind: 'folded', summary: fold.summary })
        }
        return out
    })

    /** The artifacts the reply doesn't embed, shown after it. */
    const trailing = $derived(
        unembedded(
            artifactsOf(results.values()),
            rest.filter((m) => m.role === 'assistant').map(textOf),
        ),
    )
</script>

{#if opening !== null}
    <TurnOpening {session} text={opening} {onUndo} {onEdit} />
{/if}
<div class="agent">
    <AgentItems {session} {at} {items} />
    {#each trailing as artifact (artifact.path)}
        <Artifact {session} {at} path={artifact.path} name={artifact.name} />
    {/each}
    {#if run.status !== 'completed'}
        <div class="status">{run.status}</div>
    {/if}
</div>

<style>
    .agent {
        max-width: 100%;
    }
    .status {
        color: var(--text-muted);
        font-size: 0.85rem;
        font-style: italic;
        margin: 0.3rem 0;
    }
</style>
