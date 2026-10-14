<script>
    /**
     * The chat: the session's stored runs, the turn running now, the
     * messages queued for it, and the composer. A message sent while a
     * turn runs is queued as a note, delivered with the turn's next tool
     * result, and can be taken back until then. Files dropped on the chat
     * attach to the next message. With no model chosen (a published
     * session opened by a visitor, say), the conversation reads and the
     * composer waits for one.
     */
    import Composer from './Composer.svelte'
    import DelegateStrip from './DelegateStrip.svelte'
    import LiveTurn from './LiveTurn.svelte'
    import RunView from './RunView.svelte'
    import { isConfigured, settingsStore } from './settings.js'
    import { studio } from './studio.svelte.js'
    import UserBubble from './UserBubble.svelte'

    /** @type {{ session: import('./studio.svelte.js').ChatSession }} */
    let { session } = $props()

    /** @type {HTMLElement | undefined} */
    let list = $state()
    /** @type {Composer | undefined} */
    let composer = $state()
    /** Files dragged over the chat, to be dropped. */
    let dragging = $state(false)

    /** Whether a drop can attach here: files, a writable session, no turn running.
     *  @param {DragEvent} e */
    const droppable = (e) => !session.readonly && !session.busy && isConfigured($settingsStore) && (e.dataTransfer?.types.includes('Files') ?? false)

    /** @param {DragEvent} e */
    function onDragOver(e) {
        if (!droppable(e)) return
        e.preventDefault()
        dragging = true
    }

    /** @param {DragEvent} e */
    function onDrop(e) {
        if (!dragging) return
        e.preventDefault()
        dragging = false
        void composer?.attach(e.dataTransfer?.files ?? [])
    }

    /** @param {() => Promise<unknown>} fn */
    async function act(fn) {
        try {
            await fn()
        } catch (e) {
            session.error = e instanceof Error ? e.message : String(e)
        }
    }


    /** Whether the view follows the newest content: while the person
     *  is at the bottom, and not once they scroll up to read. */
    let following = true

    function onScroll() {
        if (list == null) return
        following = list.scrollHeight - list.scrollTop - list.clientHeight < 80
    }

    /** Set while a click opens or closes something in the transcript:
     *  what it reveals grows the list, which isn't new content to follow. */
    let revealing = false

    /** @param {MouseEvent} e */
    function onClick(e) {
        if (!(e.target instanceof Element) || e.target.closest('button, summary') === null) return
        revealing = true
        requestAnimationFrame(() => {
            revealing = false
            // whether the reader is still at the bottom, now it has grown
            onScroll()
        })
    }

    // follow the content as it grows, a streamed reply's deltas included
    $effect(() => {
        const el = list
        if (el == null) return
        const observer = new MutationObserver(() => {
            if (following && !revealing) el.scrollTop = el.scrollHeight
        })
        observer.observe(el, { childList: true, subtree: true, characterData: true })
        el.scrollTop = el.scrollHeight
        return () => observer.disconnect()
    })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions (a drop target; the composer's + does the same) -->
<div
    class="chat"
    ondragover={onDragOver}
    ondragleave={(e) => {
        if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) dragging = false
    }}
    ondrop={onDrop}
>
    {#if dragging}<div class="drop">Drop files to attach</div>{/if}
    <div class="messages" bind:this={list} onscroll={onScroll} onclickcapture={onClick}>
        {#each session.runs as run, i (run.runId)}
            <RunView {session} {run} at={session.endOf(i)} folds={session.folds} onUndo={session.busy || session.readonly ? undefined : () => act(() => session.undo(run.runId))} />
        {/each}
        {#if session.interrupted && !session.busy}
            <div class="banner">
                The last turn was cut short by the model's provider.
                <button onclick={() => act(() => session.resume())}>Resume it</button>
                <button class="secondary" onclick={() => act(() => session.abandon())}>Set it aside</button>
            </div>
        {/if}
        {#if session.busy}
            <LiveTurn {session} prompt={session.prompt} parts={session.live} />
        {/if}
        {#each session.queued as q (q.id)}
            <div class="mine">
                <UserBubble {session} text={q.text} label="Queued · reaches the agent with its next step" faded onWithdraw={() => session.withdraw(q.id)} />
            </div>
        {/each}
        {#if session.error}
            <div class="error">{session.error}</div>
        {/if}
    </div>
    {#if session.redoHead !== null}
        <div class="banner">
            Undone: the workspace and the conversation are back where that turn began.
            <button onclick={() => act(() => session.redo())}>Redo</button>
        </div>
    {/if}
    {#if session.notice}<div class="notice">{session.notice}</div>{/if}
    <DelegateStrip {session} />
    {#if session.readonly}
    <div class="delegate-bar">
        <button onclick={() => studio.switchTo(/** @type {string} */ (session.parent))}>← back to {studio.sessions.find((s) => s.name === session.parent)?.title || session.parent}</button>
        <span>A delegate: {session.busy ? 'working' : 'its transcript'}, read-only</span>
    </div>
    {:else}
    <div class="composer"><Composer bind:this={composer} {session} /></div>
    {/if}
</div>

<style>
    .notice {
        padding: 0.4rem var(--gutter);
        font-size: 0.8rem;
        color: var(--text-muted);
        border-top: 1px solid var(--border);
    }
    .delegate-bar {
        display: flex;
        align-items: center;
        gap: 0.8rem;
        padding: 0.6rem var(--gutter);
        border-top: 1px solid var(--border);
        font-size: 0.8rem;
        color: var(--text-muted);
    }
    .delegate-bar button {
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 6px;
        padding: 0.3rem 0.7rem;
        cursor: pointer;
    }
    .chat {
        /* the conversation reads in a column of at most 900px, centered;
           each row pads its sides to it, so it scrolls at the edge */
        --gutter: max(1rem, calc((100% - 900px) / 2));
        position: relative;
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }
    .messages {
        /* the browser's scroll anchoring holds the list's end in place
           as it grows, scrolling a line just opened away; following the
           newest content is done above */
        overflow-anchor: none;
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        padding: 1rem var(--gutter);
    }
    .error {
        color: var(--error);
        font-size: 0.85rem;
    }
    .banner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem var(--gutter);
        font-size: 0.85rem;
        color: var(--text-muted);
        border-top: 1px solid var(--border);
    }
    .banner button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.25rem 0.7rem;
        cursor: pointer;
    }
    .banner .secondary {
        background: transparent;
        border: 1px solid var(--border);
    }
    .composer {
        padding: 0.5rem var(--gutter) 0.8rem;
    }
    .mine {
        display: flex;
        justify-content: flex-end;
    }
    .drop {
        position: absolute;
        inset: 0.5rem;
        z-index: 12;
        display: flex;
        align-items: center;
        justify-content: center;
        border: 2px dashed var(--accent);
        border-radius: 12px;
        background: color-mix(in srgb, var(--bg) 85%, transparent);
        color: var(--text);
        font-size: 1rem;
        pointer-events: none;
    }
</style>
