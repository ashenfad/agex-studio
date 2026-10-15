<script>
    /**
     * Where the person writes: one card holding the files attached to the
     * next message (as chips), the message itself (growing as it does),
     * and a row with `+` to attach files (from this device, or Google
     * Drive) and the send button, which is Stop while a turn runs with
     * nothing written.
     *
     * Files attach at once, added under uploads/ as one commit each time;
     * the chips say which the next message names to the agent. Pasting an
     * image attaches it too. Sent while a turn runs, a message is queued:
     * it reaches the agent with its next tool result.
     */
    import ContextMeter from './ContextMeter.svelte'
    import { isDriveImportAvailable, pickFromDrive } from './drive-import.js'
    import { withAttachments } from './notes.js'
    import { isConfigured, settingsStore } from './settings.js'

    /** @type {{ session: import('./session.svelte.js').ChatSession }} */
    let { session } = $props()

    /** @type {HTMLTextAreaElement | undefined} */
    let textarea = $state()
    /** @type {HTMLInputElement | undefined} */
    let picker = $state()
    let menuOpen = $state(false)
    /** Attachments under way (read, fetched, or being added): the
     *  message waits for them, so it goes with every file it was given. */
    let pending = $state(0)
    const attaching = $derived(pending > 0)
    /** What went wrong attaching, or what didn't come. */
    let problem = $state('')
    const drive = isDriveImportAvailable()

    const configured = $derived(isConfigured($settingsStore))
    const written = $derived(session.draft.trim() !== '' || session.attached.length > 0)

    // the box grows with the message, up to a point, then scrolls
    $effect(() => {
        void session.draft
        if (!textarea) return
        textarea.style.height = 'auto'
        textarea.style.height = `${Math.min(textarea.scrollHeight, 220)}px`
    })

    /**
     * Attach files: added under uploads/ now, named with the next message.
     *
     * @param {{ name: string, bytes: Uint8Array }[]} files @param {string[]} [errors]
     */
    async function attachFiles(files, errors = []) {
        problem = errors.join('; ')
        if (files.length === 0) return
        const paths = await session.importFiles(files)
        session.attached = [...new Set([...session.attached, ...paths])]
    }

    /** Run an attachment, counted as under way from its first step (a
     *  file's read included) to its last. @param {() => Promise<void>} fn */
    async function underway(fn) {
        pending += 1
        try {
            await fn()
        } catch (e) {
            problem = e instanceof Error ? e.message : String(e)
        } finally {
            pending -= 1
        }
    }

    /** Attach files the browser handed over (picked, dropped, pasted).
     *  @param {Iterable<File>} list @param {(f: File, i: number) => string} [nameOf] */
    export function attach(list, nameOf = (f) => f.name) {
        const files = [...list]
        return underway(async () => {
            await attachFiles(await Promise.all(files.map(async (f, i) => ({ name: nameOf(f, i), bytes: new Uint8Array(await f.arrayBuffer()) }))))
        })
    }

    function fromDrive() {
        menuOpen = false
        return underway(async () => {
            const { files, errors } = await pickFromDrive()
            await attachFiles(files, errors)
        })
    }

    function send() {
        if (!written || !configured || attaching) return
        const message = withAttachments(session.draft.trim(), session.attached)
        session.draft = ''
        session.attached = []
        problem = ''
        void session.say(message)
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
            e.preventDefault()
            send()
        }
    }

    /** A pasted image attaches, named for when it came.
     *  @param {ClipboardEvent} e */
    function onPaste(e) {
        const files = [...(e.clipboardData?.files ?? [])]
        if (files.length === 0) return
        e.preventDefault()
        const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
        void attach(files, (f, i) => {
            const ext = f.type.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin'
            return f.name && f.name !== 'image.png' ? f.name : `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ''}.${ext}`
        })
    }

    /** @param {string} path */
    function detach(path) {
        session.attached = session.attached.filter((p) => p !== path)
    }

    const placeholder = $derived(
        !configured ? (session.runs.length > 0 ? 'To carry on the conversation, choose a model in settings' : 'Choose a model to start') : session.busy ? 'Add a note to the turn running (it reaches the agent with its next step)…' : 'Ask for something…',
    )
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<div class="card" class:disabled={!configured}>
    {#if session.attached.length || attaching}
        <div class="chips">
            {#each session.attached as p (p)}
                <span class="chip" title={p}>
                    {p.split('/').at(-1)}
                    <button class="remove" onclick={() => detach(p)} aria-label="Don't attach {p.split('/').at(-1)}" title="Don't attach it (it stays in uploads/)">×</button>
                </span>
            {/each}
            {#if attaching}<span class="chip pending">adding…</span>{/if}
        </div>
    {/if}
    <textarea bind:this={textarea} bind:value={session.draft} onkeydown={onKey} onpaste={onPaste} rows="1" disabled={!configured} {placeholder}></textarea>
    <div class="row">
        <div class="attach">
            <button
                class="icon"
                onclick={(e) => {
                    e.stopPropagation()
                    menuOpen = !menuOpen
                }}
                disabled={!configured || session.busy || attaching}
                title={session.busy ? 'Files attach once the turn ends' : 'Attach files'}
                aria-label="Attach files"
                aria-expanded={menuOpen}
            >
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
            </button>
            {#if menuOpen}
                <div class="menu" role="menu">
                    <button role="menuitem" onclick={() => { menuOpen = false; picker?.click() }}>Upload from this device</button>
                    {#if drive}<button role="menuitem" onclick={fromDrive}>From Google Drive</button>{/if}
                </div>
            {/if}
            <input bind:this={picker} type="file" multiple hidden onchange={() => { const files = [...(picker?.files ?? [])]; if (picker) picker.value = ''; void attach(files) }} />
        </div>
        {#if problem}<span class="problem">{problem}</span>{/if}
        <span class="gap"></span>
        <ContextMeter {session} />
        {#if (session.busy || session.folding) && !written}
            <button class="send stop" onclick={() => session.cancel()} title={session.folding ? 'Stop folding (nothing is folded)' : 'Stop this turn (the work so far is kept)'} aria-label="Stop">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
            </button>
        {:else}
            <button class="send" onclick={send} disabled={!written || !configured || attaching} title={attaching ? 'Adding the files…' : session.busy ? 'Queue it for the turn running (Enter)' : 'Send (Enter)'} aria-label="Send">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
            </button>
        {/if}
    </div>
</div>

<style>
    .card {
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 0.55rem 0.6rem 0.45rem 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        transition: border-color 0.15s;
    }
    .card:focus-within {
        border-color: var(--text-muted);
    }
    .card.disabled {
        opacity: 0.7;
    }
    .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
    }
    .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 999px;
        font-size: 0.74rem;
        padding: 0.12rem 0.55rem;
        max-width: 14rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .chip.pending {
        color: var(--text-muted);
    }
    .remove {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 0.9rem;
        line-height: 1;
        padding: 0;
    }
    .remove:hover {
        color: var(--text);
    }
    textarea {
        resize: none;
        background: none;
        border: none;
        outline: none;
        color: var(--text);
        font: inherit;
        line-height: 1.45;
        padding: 0.15rem 0;
        max-height: 220px;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }
    .gap {
        flex: 1;
    }
    .attach {
        position: relative;
    }
    .icon {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 1.9rem;
        height: 1.9rem;
        border-radius: 50%;
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        cursor: pointer;
    }
    .icon:hover:not(:disabled) {
        color: var(--text);
        background: var(--surface-hover);
    }
    .icon:disabled {
        opacity: 0.45;
        cursor: default;
    }
    .menu {
        position: absolute;
        bottom: calc(100% + 0.4rem);
        left: 0;
        z-index: 15;
        display: flex;
        flex-direction: column;
        min-width: 13rem;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.25rem;
        box-shadow: 0 6px 20px rgb(0 0 0 / 40%);
    }
    .menu button {
        background: none;
        border: none;
        border-radius: 5px;
        color: var(--text);
        cursor: pointer;
        font: inherit;
        font-size: 0.85rem;
        text-align: left;
        padding: 0.4rem 0.6rem;
    }
    .menu button:hover {
        background: var(--surface-hover);
    }
    .problem {
        color: var(--error);
        font-size: 0.75rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }
    .send {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 2rem;
        height: 2rem;
        border-radius: 50%;
        border: none;
        background: var(--accent);
        color: white;
        cursor: pointer;
        flex-shrink: 0;
    }
    .send:disabled {
        opacity: 0.35;
        cursor: default;
    }
    .send.stop {
        background: var(--text);
        color: var(--bg);
    }
</style>
