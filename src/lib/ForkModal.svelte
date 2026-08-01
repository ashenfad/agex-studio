<script>
    /** Modal for choosing how to fork a session.
     *
     *  Three modes:
     *    - Full fork (default): clone everything — chat history,
     *      files, state, cache. Today's behavior.
     *    - Fresh chat, keep files: squash the source's VFS files
     *      onto a fresh empty branch — keeps the workspace, drops
     *      the conversation context (see `forkSessionFreshChat`).
     *    - Compact copy (ts only): tip-only snapshot — app, files,
     *      and the full conversation, with edit history and agent
     *      cache dropped; optionally with observed images re-encoded
     *      smaller (default ON — compact means compact).
     *
     *  `freshDisabled` / `compactDisabled` (+ reasons) let a host
     *  disable options and explain why. `compactEstimates`
     *  ({full, flat, flatDownsampled} bytes, or null) renders the
     *  size delta on the compact option once profiled.
     *
     *  Closes via Escape, clicking the overlay, the X button, or
     *  the Cancel button. Fork button fires onConfirm with the
     *  selected mode (+ options) and the caller performs the fork
     *  (the component stays presentation-only and testable).
     */
    import { formatBytes } from './bytes.js'

    /** @type {{
     *   open: boolean,
     *   sourceTitle: string,
     *   freshDisabled?: boolean,
     *   freshDisabledReason?: string,
     *   compactDisabled?: boolean,
     *   compactDisabledReason?: string,
     *   compactEstimates?: { full: number, flat: number, flatDownsampled: number } | null,
     *   onClose: () => void,
     *   onConfirm: (mode: 'full' | 'fresh' | 'compact',
     *               opts?: { images: 'downsample' | 'full' }) => void | Promise<void>,
     * }} */
    let {
        open,
        sourceTitle,
        freshDisabled = false,
        freshDisabledReason = '',
        compactDisabled = false,
        compactDisabledReason = '',
        compactEstimates = null,
        onClose,
        onConfirm,
    } = $props()

    /** @type {'full' | 'fresh' | 'compact'} */
    let mode = $state('full')
    let compactSmallImages = $state(true)
    let working = $state(false)

    // Reset selection whenever the modal re-opens so a prior pick
    // doesn't accidentally re-fire if the user closes and reopens
    // for a different session.
    $effect(() => {
        if (open) {
            mode = 'full'
            compactSmallImages = true
            working = false
        }
    })

    /** "8.4 MB → ~1.3 MB" for the compact option, tracking the
     *  smaller-images checkbox; '' until estimates arrive. */
    let compactSizeHint = $derived.by(() => {
        if (!compactEstimates) return ''
        const after = compactSmallImages
            ? compactEstimates.flatDownsampled
            : compactEstimates.flat
        return `${formatBytes(compactEstimates.full)} → ~${formatBytes(Math.max(0, after))}`
    })

    function handleKeydown(e) {
        if (e.key === 'Escape' && !working) onClose()
    }

    async function handleConfirm() {
        if (working) return
        if (mode === 'fresh' && freshDisabled) return
        if (mode === 'compact' && compactDisabled) return
        working = true
        try {
            await onConfirm(
                mode,
                mode === 'compact'
                    ? { images: compactSmallImages ? 'downsample' : 'full' }
                    : undefined,
            )
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

                <!-- A <div>, not a <label> like its siblings: this card
                     nests the smaller-images checkbox, and HTML forbids
                     a label inside a label (and a label wrapping two
                     labelable controls). The onclick keeps the
                     whole-card click affordance; the radio itself stays
                     keyboard-reachable as part of the group. -->
                <!-- svelte-ignore a11y_click_events_have_key_events -->
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="option"
                    class:checked={mode === 'compact'}
                    class:disabled={compactDisabled}
                    onclick={() => { if (!working && !compactDisabled) mode = 'compact' }}
                >
                    <input
                        type="radio"
                        name="fork-mode"
                        value="compact"
                        bind:group={mode}
                        disabled={working || compactDisabled}
                    />
                    <div class="option-body">
                        <div class="option-title">
                            Compact copy
                            {#if compactSizeHint}
                                <span class="option-size">{compactSizeHint}</span>
                            {/if}
                        </div>
                        <div class="option-desc">
                            Everything as it is now — app, files, and the full
                            conversation — without the edit history. The chat
                            continues exactly where it left off.
                        </div>
                        {#if mode === 'compact'}
                            <label class="option-sub" onclick={(e) => e.stopPropagation()}>
                                <input
                                    type="checkbox"
                                    bind:checked={compactSmallImages}
                                    disabled={working}
                                />
                                <span>Smaller images (screenshots re-encoded; uploads untouched)</span>
                            </label>
                        {/if}
                        {#if compactDisabled && compactDisabledReason}
                            <div class="option-disabled-note">{compactDisabledReason}</div>
                        {/if}
                    </div>
                </div>
            </div>

            <div class="panel-footer">
                <button class="btn" onclick={onClose} disabled={working}>Cancel</button>
                <button
                    class="btn btn-primary"
                    onclick={handleConfirm}
                    disabled={working || (mode === 'fresh' && freshDisabled) || (mode === 'compact' && compactDisabled)}
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

    /* Size delta beside the compact option title — muted and
       tabular so the arrow reads as data, not prose. */
    .option-size {
        margin-left: 0.4rem;
        font-size: 0.72rem;
        font-weight: 400;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
    }

    /* Nested checkbox revealed when compact is the selected mode. */
    .option-sub {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        margin-top: 0.45rem;
        font-size: 0.75rem;
        color: var(--text);
        cursor: pointer;
    }

    .option-sub input[type="checkbox"] {
        accent-color: var(--accent);
        flex-shrink: 0;
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
