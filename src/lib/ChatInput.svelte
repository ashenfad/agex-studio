<script>
    /**
     * @type {{
     *   onSend: (text: string, attachments: Array<{name: string, bytes: Uint8Array}>) => void,
     *   onCancel?: () => void,
     *   onDriveImport?: () => Promise<void>,
     *   driveAvailable?: boolean,
     *   busy?: boolean,
     *   cancelling?: boolean,
     *   sendDisabled: boolean,
     *   prefill?: string,
     * }}
     */
    let {
        onSend,
        onCancel,
        onDriveImport,
        driveAvailable = false,
        busy = false,
        cancelling = false,
        sendDisabled,
        prefill = '',
    } = $props()

    import { tick } from 'svelte'
    import {
        pendingAttachments,
        queueFiles,
        removeAttachment,
        clearAttachments,
    } from './pending-attachments.js'

    let text = $state('')
    let menuOpen = $state(false)
    let dragOver = $state(false)
    let importing = $state(false)
    /** @type {HTMLTextAreaElement | undefined} */
    let textarea = $state(undefined)
    /** @type {HTMLInputElement | undefined} */
    let fileInput = $state(undefined)

    $effect(() => {
        if (prefill) {
            text = prefill
            tick().then(() => textarea?.focus())
        }
    })

    /** Send is enabled when there's either text OR attachments —
     *  allows "files only" sends that just create the upload bubble
     *  without invoking the agent. */
    const hasContent = $derived(
        text.trim().length > 0 || $pendingAttachments.length > 0,
    )

    function send() {
        if (!hasContent || sendDisabled) return
        const trimmed = text.trim()
        const attachments = $pendingAttachments
        onSend(trimmed, attachments)
        text = ''
        clearAttachments()
        tick().then(() => textarea?.focus())
    }

    function handleKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (!sendDisabled && hasContent) send()
        }
    }

    function openLocalPicker() {
        menuOpen = false
        fileInput?.click()
    }

    async function handleFileInput(e) {
        const files = e.target.files
        if (files) await queueFiles(files)
        e.target.value = ''  // reset so re-picking the same file works
    }

    async function handleDriveImport() {
        menuOpen = false
        if (!onDriveImport || importing) return
        importing = true
        try {
            await onDriveImport()
        } finally {
            importing = false
        }
    }

    function handleDragOver(e) {
        e.preventDefault()
        dragOver = true
    }

    function handleDragLeave(e) {
        // Only clear if we're truly leaving the input bar (not just
        // crossing a child boundary).
        if (e.currentTarget === e.target) dragOver = false
    }

    async function handleDrop(e) {
        e.preventDefault()
        dragOver = false
        if (e.dataTransfer?.files) await queueFiles(e.dataTransfer.files)
    }

    /** Format byte counts for chip labels — matches the style used
     *  by the file drawer's size pill. */
    function formatBytes(n) {
        if (n < 1024) return `${n}B`
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`
        return `${(n / 1024 / 1024).toFixed(1)}MB`
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="input-bar"
    class:drag-over={dragOver}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
>
    {#if $pendingAttachments.length > 0}
        <div class="chips">
            {#each $pendingAttachments as att, i (i)}
                <div class="chip" title={att.name}>
                    <span class="chip-name">{att.name}</span>
                    <span class="chip-size">{formatBytes(att.bytes.length)}</span>
                    <button
                        class="chip-remove"
                        onclick={() => removeAttachment(i)}
                        title="Remove"
                        aria-label="Remove {att.name}"
                    >×</button>
                </div>
            {/each}
        </div>
    {/if}

    <div class="input-row">
        <div class="add-wrap">
            <button
                class="add-btn"
                onclick={() => (menuOpen = !menuOpen)}
                title="Attach files"
                aria-label="Attach files"
                aria-expanded={menuOpen}
                disabled={busy}
            >+</button>
            {#if menuOpen}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="menu-backdrop"
                    onclick={() => (menuOpen = false)}
                    onkeydown={(e) => e.key === 'Escape' && (menuOpen = false)}
                ></div>
                <div class="add-menu" role="menu">
                    <button class="menu-item" role="menuitem" onclick={openLocalPicker}>
                        Local files
                    </button>
                    {#if driveAvailable}
                        <button
                            class="menu-item"
                            role="menuitem"
                            onclick={handleDriveImport}
                            disabled={importing}
                        >
                            {importing ? 'Importing…' : 'Google Drive'}
                        </button>
                    {/if}
                </div>
            {/if}
        </div>

        <input
            bind:this={fileInput}
            type="file"
            multiple
            style="display: none"
            onchange={handleFileInput}
        />

        <textarea
            bind:this={textarea}
            bind:value={text}
            onkeydown={handleKeydown}
            placeholder="Ask the agent..."
            rows="1"
            disabled={busy}
        ></textarea>

        {#if busy}
            <button class="stop" onclick={onCancel} disabled={cancelling}>
                {cancelling ? 'Stopping...' : 'Stop'}
            </button>
        {:else}
            <button class="send" onclick={send} disabled={sendDisabled || !hasContent}>
                Send
            </button>
        {/if}
    </div>

    {#if dragOver}
        <div class="drop-overlay">Drop files to attach</div>
    {/if}
</div>

<style>
    .input-bar {
        position: relative;
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        padding: 0.6rem 1rem 0.75rem;
        border-top: 1px solid var(--border);
        flex-shrink: 0;
    }

    .input-bar.drag-over {
        background: color-mix(in srgb, var(--accent) 6%, transparent);
    }

    .input-row {
        display: flex;
        gap: 0.5rem;
        align-items: flex-end;
    }

    /* Attachment chips above the input row. Wrap on overflow so a
       big attachment count stacks across multiple lines instead of
       overflowing horizontally. */
    .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
    }

    .chip {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.2rem 0.4rem 0.2rem 0.55rem;
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 4px;
        font-size: 0.78rem;
        color: var(--text);
        max-width: 220px;
    }

    .chip-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .chip-size {
        color: var(--text-muted);
        font-size: 0.7rem;
        flex-shrink: 0;
    }

    .chip-remove {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 1rem;
        line-height: 1;
        padding: 0 0.2rem;
        cursor: pointer;
        flex-shrink: 0;
    }

    .chip-remove:hover {
        color: var(--text);
    }

    /* `+` attach button + dropdown menu. Same split-button pattern
       as SessionDrawer's create dropdown — backdrop catches click-out,
       menu positions absolutely above the button (since the input bar
       is at the bottom of the viewport). */
    .add-wrap {
        position: relative;
    }

    .add-btn {
        background: var(--surface-hover);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        font-size: 1.1rem;
        line-height: 1;
        cursor: pointer;
        flex-shrink: 0;
    }

    .add-btn:hover:not(:disabled) {
        background: var(--input-bg);
        border-color: var(--accent);
    }

    .add-btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
    }

    .add-menu {
        position: absolute;
        bottom: calc(100% + 0.3rem);
        left: 0;
        z-index: 201;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 -4px 12px rgba(0, 0, 0, 0.4);
        min-width: 160px;
        padding: 0.25rem;
    }

    .menu-item {
        display: block;
        width: 100%;
        padding: 0.45rem 0.6rem;
        background: none;
        color: var(--text);
        border: none;
        border-radius: 4px;
        font-size: 0.85rem;
        text-align: left;
        cursor: pointer;
    }

    .menu-item:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .menu-item:disabled {
        opacity: 0.6;
        cursor: not-allowed;
    }

    textarea {
        flex: 1;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        font-family: inherit;
        font-size: 0.9rem;
        resize: none;
        outline: none;
        min-height: 2.4rem;
    }

    textarea:focus {
        border-color: var(--accent);
    }

    textarea::placeholder {
        color: var(--text-muted);
    }

    button.send,
    button.stop {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.5rem 1.25rem;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.9rem;
        flex-shrink: 0;
    }

    button.send:hover:not(:disabled),
    button.stop:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    button.send:disabled,
    button.stop:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    button.stop {
        background: #e74c3c;
    }

    button.stop:hover:not(:disabled) {
        background: #c0392b;
    }

    /* Drop overlay sits over the input bar during a drag. Bigger
       feedback than just the background tint — confirms the drop
       target. */
    .drop-overlay {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--accent) 25%, transparent);
        border: 2px dashed var(--accent);
        border-radius: 6px;
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--accent);
        pointer-events: none;
        margin: 0.3rem;
    }
</style>
