<script>
    /**
     * One stored run, as the chat shows it: the person's message, then
     * the agent's reply in the order it came (thinking, text, and each
     * tool call with its result), read from agex-ts's record.
     */
    import { CLOSING_NOTE } from 'agex-ts'
    import { renderMarkdown } from './markdown.js'
    import ToolCall from './ToolCall.svelte'

    /** @type {{ run: import('agex-ts').Run }} */
    let { run } = $props()

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
</script>

{#if opening !== null}
    <div class="user">{opening}</div>
{/if}
<div class="agent">
    {#each rest as message (message.id)}
        {#if message.role === 'assistant'}
            {#each message.parts as part, i (i)}
                {#if part.kind === 'thinking' && part.text.trim() !== ''}
                    <details class="thinking"><summary>thinking</summary>{part.text}</details>
                {:else if part.kind === 'text' && part.text.startsWith(CLOSING_NOTE)}
                    <div class="closing">{part.text}</div>
                {:else if part.kind === 'text'}
                    <div class="text">{@html renderMarkdown(part.text)}</div>
                {:else if part.kind === 'tool_call'}
                    {@const result = results.get(part.callId)}
                    <ToolCall
                        name={part.name}
                        args={{ ...part.args }}
                        result={result?.content ?? null}
                        isError={result?.isError ?? false}
                    />
                {/if}
            {/each}
        {:else if message.role === 'user'}
            <div class="note">{textOf(message)}</div>
        {/if}
    {/each}
    {#if run.status !== 'completed'}
        <div class="status">{run.status}</div>
    {/if}
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
    .agent {
        max-width: 100%;
    }
    .text :global(p) {
        margin: 0.4rem 0;
    }
    .thinking {
        color: var(--text-muted);
        font-size: 0.85rem;
        white-space: pre-wrap;
        margin: 0.3rem 0;
    }
    .thinking summary {
        cursor: pointer;
    }
    .note,
    .closing,
    .status {
        color: var(--text-muted);
        font-size: 0.85rem;
        font-style: italic;
        margin: 0.3rem 0;
    }
</style>
