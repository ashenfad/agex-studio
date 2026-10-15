<script>
    /**
     * How a turn opened, as the chat shows it, stored or live alike: the
     * task a delegate was given ("Task from lead: …"), the delegates'
     * answers that woke the session (a card each, opening the delegate),
     * or the person's message. Only what the person said offers undo
     * (and, for an ordinary message, edit): a turn the answers started
     * goes when the turn before it is undone.
     */
    import { delegateTask, deliveredAnswers } from './delegation.svelte.js'
    import { studio } from './studio.svelte.js'
    import UserBubble from './UserBubble.svelte'

    /** @type {{ session: import('./session.svelte.js').ChatSession, text: string, onUndo?: () => void, onEdit?: () => void }} */
    let { session, text, onUndo, onEdit } = $props()

    /** Delegates' answers the opening delivered: shown as cards. */
    const delivered = $derived(deliveredAnswers(text))
    /** A delegate's first turn: the task it was given, not its brief. */
    const asked = $derived(delegateTask(text))
    /** Whether the person spoke here: a message, or words beside the answers. */
    const spoke = $derived(asked === null && (delivered === null || delivered.said !== ''))
    /** Who gave a delegate its task: the session's name in the list,
     *  else its own last part. */
    const from = $derived.by(() => {
        if (asked === null) return ''
        return studio.sessions.find((s) => s.name === asked.parent)?.title || asked.parent.split('.').at(-1)
    })
</script>

{#if spoke || asked !== null}
<div class="user-row">
    <span class="tools">
        {#if onEdit && asked === null && delivered === null}
            <button class="tool" title="Edit: undo this turn and everything after it, and put the message back to change and send again" aria-label="Edit this message" onclick={onEdit}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
            </button>
        {/if}
        {#if onUndo && spoke}
            <button class="tool" title="Undo this turn and everything after it (Redo brings it back)" aria-label="Undo this turn" onclick={onUndo}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7v6h6"></path><path d="M21 17a9 9 0 0 0-15-6.7L3 13"></path></svg>
            </button>
        {/if}
    </span>
    {#if asked !== null}
        <div class="user"><span class="from">Task from {from}:</span> {asked.task}</div>
    {:else if delivered === null}
        <UserBubble {session} {text} />
    {:else if delivered.said !== ''}
        <UserBubble {session} text={delivered.said} />
    {/if}
</div>
{/if}
{#if delivered !== null}
    {#each delivered.answers as answer (answer.name)}
        <button class="answer" title="Open {answer.name}" onclick={() => studio.switchTo(answer.name)}>
            ⑂ <b>{answer.name.split('.').at(-1)}</b> answered{answer.preview ? `: ${answer.preview}` : ''} <span class="open">open →</span>
        </button>
    {/each}
{/if}

<style>
    .answer {
        display: block;
        flex-shrink: 0;
        width: 100%;
        text-align: left;
        background: var(--surface);
        border: 1px solid var(--border);
        border-left: 3px solid var(--accent);
        color: var(--text);
        border-radius: 6px;
        padding: 0.4rem 0.6rem;
        margin: 0.3rem 0;
        font-size: 0.85rem;
        cursor: pointer;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .from {
        opacity: 0.7;
        font-size: 0.85em;
    }
    .answer .open {
        color: var(--text-muted);
        font-size: 0.75rem;
    }
    .user-row {
        display: flex;
        justify-content: flex-end;
        align-items: center;
        gap: 0.4rem;
    }
    /* a message's tools, beside it on hover or when the keyboard is on
       one; always where there's no hovering (a touch screen). Faded
       out, not hidden, so Tab still reaches them. Not on :focus-within,
       which would keep them after a click. */
    .tools {
        display: flex;
        gap: 0.1rem;
        opacity: 0;
        transition: opacity 0.15s;
    }
    .user-row:hover .tools,
    .tools:has(:focus-visible) {
        opacity: 1;
    }
    @media (hover: none) {
        .tools {
            opacity: 1;
        }
    }
    .tool {
        display: flex;
        align-items: center;
        background: none;
        border: none;
        border-radius: 5px;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.3rem;
    }
    .tool:hover {
        color: var(--text);
        background: var(--surface-hover);
    }
    .user {
        max-width: 80%;
        background: var(--user-bubble);
        padding: 0.5rem 0.8rem;
        border-radius: 10px;
        white-space: pre-wrap;
    }
</style>
