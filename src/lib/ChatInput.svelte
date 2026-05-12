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
    class="input-wrap"
    class:drag-over={dragOver}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}
>
    <div class="input-card" class:focus-within={false}>
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

        <textarea
            bind:this={textarea}
            bind:value={text}
            onkeydown={handleKeydown}
            placeholder="Ask the agent..."
            rows="1"
            disabled={busy}
        ></textarea>

        <div class="toolbar">
            <div class="toolbar-left">
                <div class="add-wrap">
                    <button
                        class="icon-btn add-btn"
                        onclick={() => (menuOpen = !menuOpen)}
                        title="Attach files"
                        aria-label="Attach files"
                        aria-expanded={menuOpen}
                        disabled={busy}
                    >
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                    </button>
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
            </div>

            <div class="toolbar-right">
                {#if busy}
                    <button class="action-btn stop" onclick={onCancel} disabled={cancelling}>
                        {cancelling ? 'Stopping…' : 'Stop'}
                    </button>
                {:else}
                    <button
                        class="action-btn send"
                        onclick={send}
                        disabled={sendDisabled || !hasContent}
                        title="Send (Enter)"
                        aria-label="Send"
                    >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                            <line x1="12" y1="19" x2="12" y2="5"></line>
                            <polyline points="5 12 12 5 19 12"></polyline>
                        </svg>
                    </button>
                {/if}
            </div>
        </div>
    </div>

    {#if dragOver}
        <div class="drop-overlay">Drop files to attach</div>
    {/if}
</div>

<style>
    .input-wrap {
        position: relative;
        padding: 0.6rem 1rem 0.85rem;
        flex-shrink: 0;
    }

    /* Single rounded container holding the chips + text + toolbar.
       Text and toolbar live inside the same border so the whole
       thing reads as one input element (Claude.ai / ChatGPT shape).
       The outer .input-wrap handles padding + drag-drop overlay so
       the card itself stays focused. */
    .input-card {
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 0.5rem 0.6rem 0.5rem 0.75rem;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
        transition: border-color 0.15s ease;
    }

    .input-card:focus-within {
        border-color: var(--accent);
    }

    /* Attachment chips at the top of the card. Wrap on overflow so
       a big attachment count stacks across multiple lines instead of
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

    /* Textarea is borderless inside the card — the card's border is
       the visible boundary. Background transparent so the card's bg
       comes through on hover/focus. */
    textarea {
        width: 100%;
        background: transparent;
        color: var(--text);
        border: none;
        padding: 0.35rem 0.25rem;
        font-family: inherit;
        font-size: 0.95rem;
        line-height: 1.45;
        resize: none;
        outline: none;
        min-height: 1.6rem;
        max-height: 10rem;
    }

    textarea::placeholder {
        color: var(--text-muted);
    }

    /* Toolbar row at the bottom of the card. Left side holds the
       attach button (and any future affordances — model picker,
       etc.); right side holds the primary send/stop action. */
    .toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .toolbar-left,
    .toolbar-right {
        display: flex;
        align-items: center;
        gap: 0.25rem;
    }

    /* Borderless icon buttons — the attach `+` and any siblings.
       Reads as part of the card's furniture, not a separate control. */
    .icon-btn {
        background: none;
        color: var(--text-muted);
        border: none;
        border-radius: 6px;
        padding: 0.35rem;
        cursor: pointer;
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    .icon-btn:hover:not(:disabled) {
        background: var(--surface-hover);
        color: var(--text);
    }

    .icon-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .add-wrap {
        position: relative;
        display: inline-flex;
    }

    /* Dropdown — opens upward (toolbar is at viewport bottom).
       Backdrop catches click-out per the SessionDrawer pattern. */
    .menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
    }

    .add-menu {
        position: absolute;
        bottom: calc(100% + 0.4rem);
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

    /* Primary action — send (icon) or stop (text). Compact square
       to balance against the borderless icon-btn on the left. */
    .action-btn {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 8px;
        padding: 0.4rem 0.55rem;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.85rem;
        flex-shrink: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2rem;
        min-height: 2rem;
    }

    .action-btn:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    .action-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .action-btn.stop {
        background: #e74c3c;
        padding: 0.4rem 0.85rem;
    }

    .action-btn.stop:hover:not(:disabled) {
        background: #c0392b;
    }

    /* Drop overlay sits over the input card during a drag. */
    .drop-overlay {
        position: absolute;
        inset: 0.6rem 1rem 0.85rem;
        display: flex;
        align-items: center;
        justify-content: center;
        background: color-mix(in srgb, var(--accent) 25%, transparent);
        border: 2px dashed var(--accent);
        border-radius: 14px;
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--accent);
        pointer-events: none;
    }
</style>
