<script>
    /**
     * The chat: the session's stored runs, the turn running now, and
     * the composer. A message sent while a turn runs is queued as a
     * note, delivered with the turn's next tool result.
     */
    import LiveTurn from './LiveTurn.svelte'
    import RunView from './RunView.svelte'

    /** @type {{ session: import('./studio.svelte.js').ChatSession }} */
    let { session } = $props()

    let draft = $state('')
    /** @type {HTMLElement | undefined} */
    let list = $state()

    async function send() {
        const prompt = draft.trim()
        if (prompt === '') return
        draft = ''
        void session.say(prompt)
    }

    /** @param {() => Promise<unknown>} fn */
    async function act(fn) {
        try {
            await fn()
        } catch (e) {
            session.error = e instanceof Error ? e.message : String(e)
        }
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            void send()
        }
    }

    /** Whether the view follows the newest content: while the person
     *  is at the bottom, and not once they scroll up to read. */
    let following = true

    function onScroll() {
        if (list == null) return
        following = list.scrollHeight - list.scrollTop - list.clientHeight < 80
    }

    // follow the content as it grows, a streamed reply's deltas included
    $effect(() => {
        const el = list
        if (el == null) return
        const observer = new MutationObserver(() => {
            if (following) el.scrollTop = el.scrollHeight
        })
        observer.observe(el, { childList: true, subtree: true, characterData: true })
        el.scrollTop = el.scrollHeight
        return () => observer.disconnect()
    })
</script>

<div class="chat">
    <div class="messages" bind:this={list} onscroll={onScroll}>
        {#each session.runs as run (run.runId)}
            <RunView {session} {run} folds={session.folds} onUndo={session.busy ? undefined : () => act(() => session.undo(run.runId))} />
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
    <div class="composer">
        <textarea
            bind:value={draft}
            onkeydown={onKey}
            rows="2"
            placeholder={session.busy ? 'Add a note to the turn running…' : 'Ask for something…'}
        ></textarea>
        {#if session.busy}
            <button class="stop" onclick={() => session.cancel()}>Stop</button>
        {/if}
        <button onclick={send} disabled={draft.trim() === ''}>Send</button>
    </div>
</div>

<style>
    .chat {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
    }
    .messages {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        padding: 1rem;
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
        padding: 0.5rem 1rem;
        font-size: 0.85rem;
        color: var(--text-muted);
        border-top: 1px solid var(--border);
    }
    .banner button {
        padding: 0.25rem 0.7rem;
    }
    .secondary {
        background: transparent;
        border: 1px solid var(--border);
    }
    .composer {
        display: flex;
        gap: 0.5rem;
        padding: 0.6rem 1rem;
        border-top: 1px solid var(--border);
    }
    textarea {
        flex: 1;
        resize: none;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.5rem;
        font: inherit;
    }
    button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0 1rem;
        cursor: pointer;
    }
    button:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .stop {
        background: var(--surface);
        border: 1px solid var(--border);
    }
</style>
