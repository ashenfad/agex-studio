<script>
    /** Modal for choosing how to fork a session.
     *
     *  Two modes today:
     *    - Full fork (default): clone everything — chat history,
     *      files, state, cache. Today's behavior.
     *    - Fresh chat, keep files: branch off source HEAD so the
     *      VFS file blobs are shared via kvgit (zero bytes copied),
     *      then wipe the agent-memory keys on the new branch.
     *
     *  Py kernel doesn't yet implement `wipeAgentMemory`, so the
     *  fresh-chat option is disabled when the active session is py.
     *  The host (SessionDrawer) passes `freshDisabled` to surface
     *  this.
     *
     *  Closes via Escape, clicking the overlay, the X button, or
     *  the Cancel button. Fork button fires onConfirm with the
     *  selected mode and the caller is responsible for actually
     *  performing the fork (so this component stays presentation-
     *  only and testable).
     */

    /** @type {{
     *   open: boolean,
     *   sourceTitle: string,
     *   freshDisabled?: boolean,
     *   freshDisabledReason?: string,
     *   onClose: () => void,
     *   onConfirm: (mode: 'full' | 'fresh') => void | Promise<void>,
     * }} */
    let {
        open,
        sourceTitle,
        freshDisabled = false,
        freshDisabledReason = '',
        onClose,
        onConfirm,
    } = $props()

    let mode = $state('full')
    let working = $state(false)

    // Reset selection whenever the modal re-opens so a prior pick
    // doesn't accidentally re-fire if the user closes and reopens
    // for a different session.
    $effect(() => {
        if (open) {
            mode = 'full'
            working = false
        }
    })

    function handleKeydown(e) {
        if (e.key === 'Escape' && !working) onClose()
    }

    async function handleConfirm() {
        if (working) return
        if (mode === 'fresh' && freshDisabled) return
        working = true
        try {
            await onConfirm(mode)
        } finally {
            working = false
        }
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="overlay" onclick={() => !working && onClose()} onkeydown={handleKeydown}>
        <div class="panel" onclick={(e) => e.stopPropagation()}>
            <div class="panel-header">
                <span class="panel-title">Fork session</span>
                <button class="close-btn" onclick={onClose} disabled={working} title="Close">×</button>
            </div>
            <div class="panel-body">
                <div class="source-row">
                    <span class="source-label">Source:</span>
                    <span class="source-title">{sourceTitle}</span>
                </div>

                <label class="option" class:checked={mode === 'full'}>
                    <input
                        type="radio"
                        name="fork-mode"
                        value="full"
                        bind:group={mode}
                        disabled={working}
                    />
                    <div class="option-body">
                        <div class="option-title">Full fork</div>
                        <div class="option-desc">
                            Clone the entire session — chat history, files,
                            and all state. Continues from where this session
                            left off, with no shared updates back to the
                            original.
                        </div>
                    </div>
                </label>

                <label
                    class="option"
                    class:checked={mode === 'fresh'}
                    class:disabled={freshDisabled}
                >
                    <input
                        type="radio"
                        name="fork-mode"
                        value="fresh"
                        bind:group={mode}
                        disabled={working || freshDisabled}
                    />
                    <div class="option-body">
                        <div class="option-title">Fresh chat, keep files</div>
                        <div class="option-desc">
                            New blank conversation that inherits the files
                            in this session's workspace (uploads, app/,
                            helpers/). Useful for retrying with a different
                            angle, model, or framing.
                        </div>
                        {#if freshDisabled && freshDisabledReason}
                            <div class="option-disabled-note">{freshDisabledReason}</div>
                        {/if}
                    </div>
                </label>
            </div>

            <div class="panel-footer">
                <button class="btn" onclick={onClose} disabled={working}>Cancel</button>
                <button
                    class="btn btn-primary"
                    onclick={handleConfirm}
                    disabled={working || (mode === 'fresh' && freshDisabled)}
                >
                    {working ? 'Forking…' : 'Fork'}
                </button>
            </div>
        </div>
    </div>
{/if}

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 200;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .panel {
        width: 90vw;
        max-width: 480px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.6rem 1rem;
        border-bottom: 1px solid var(--border);
    }

    .panel-title {
        font-size: 0.9rem;
        font-weight: 600;
        color: var(--text);
    }

    .close-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 1.4rem;
        cursor: pointer;
        padding: 0 0.3rem;
        line-height: 1;
    }

    .close-btn:hover:not(:disabled) {
        color: var(--text);
    }

    .close-btn:disabled {
        opacity: 0.4;
        cursor: not-allowed;
    }

    .panel-body {
        padding: 0.85rem 1rem 0.5rem;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
    }

    .source-row {
        display: flex;
        gap: 0.4rem;
        font-size: 0.78rem;
        align-items: baseline;
        padding-bottom: 0.4rem;
        border-bottom: 1px solid var(--border);
    }

    .source-label {
        color: var(--text-muted);
    }

    .source-title {
        color: var(--text);
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }

    .option {
        display: flex;
        gap: 0.6rem;
        padding: 0.6rem 0.7rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        cursor: pointer;
        align-items: flex-start;
        transition: border-color 0.12s, background 0.12s;
    }

    .option:hover:not(.disabled) {
        background: var(--surface-hover);
    }

    .option.checked {
        border-color: var(--accent);
        background: color-mix(in srgb, var(--accent) 8%, transparent);
    }

    .option.disabled {
        opacity: 0.55;
        cursor: not-allowed;
    }

    .option input[type="radio"] {
        margin-top: 0.2rem;
        accent-color: var(--accent);
        flex-shrink: 0;
    }

    .option-body {
        flex: 1;
        min-width: 0;
    }

    .option-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text);
        margin-bottom: 0.2rem;
    }

    .option-desc {
        font-size: 0.75rem;
        color: var(--text-muted);
        line-height: 1.45;
    }

    .option-disabled-note {
        margin-top: 0.35rem;
        font-size: 0.7rem;
        color: var(--text-muted);
        font-style: italic;
    }

    .panel-footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.6rem 1rem 0.75rem;
        border-top: 1px solid var(--border);
        background: var(--surface);
    }

    .btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text);
        padding: 0.35rem 0.95rem;
        border-radius: 6px;
        font-size: 0.78rem;
        cursor: pointer;
    }

    .btn:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .btn-primary {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
    }

    .btn-primary:hover:not(:disabled) {
        background: var(--accent-hover);
    }
</style>
