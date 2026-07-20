<script>
    /** @type {{ count?: number, onOpen?: () => void, onUndo?: () => void }} */
    let { count, onOpen, onUndo } = $props()

    // The main feed (MessageList) passes `count` — the band summarizes a
    // chaptering run there. Inside a chapter modal the band is rendered
    // prop-less, purely as a "chaptered here" divider: the folded
    // chapters already show as their own cards below it, so there's no
    // count to report. A missing `count` is that divider-only case —
    // render just the rule, not a misleading "0 chapters created".
    const showLabel = $derived(count != null)
    const label = $derived(count === 1 ? '1 chapter created' : `${count} chapters created`)
</script>

<div class="chaptering-band" class:divider-only={!showLabel}>
    {#if showLabel}
        {#if onOpen}
            <button class="chaptering-label clickable" onclick={onOpen}>{label}</button>
        {:else}
            <span class="chaptering-label">{label}</span>
        {/if}
        {#if onUndo}
            <button class="chaptering-undo" onclick={onUndo} title="Undo chaptering">undo</button>
        {/if}
    {/if}
</div>

<style>
    .chaptering-band {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 0;
    }

    /* Prop-less (in-modal) usage: no label between the rules, so drop
       the gap and the two halves join into one continuous divider. */
    .chaptering-band.divider-only {
        gap: 0;
    }

    .chaptering-band::before,
    .chaptering-band::after {
        content: '';
        flex: 1;
        height: 1px;
        background: var(--border);
    }

    .chaptering-label {
        font-size: 0.7rem;
        color: var(--text-muted);
        white-space: nowrap;
        flex-shrink: 0;
    }

    .chaptering-label.clickable {
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
        text-decoration: underline;
        text-decoration-style: dotted;
        text-underline-offset: 2px;
    }

    .chaptering-label.clickable:hover {
        color: var(--text);
    }

    .chaptering-undo {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.6rem;
        cursor: pointer;
        padding: 0;
        opacity: 0;
        transition: opacity 0.15s;
        flex-shrink: 0;
    }

    .chaptering-band:hover .chaptering-undo {
        opacity: 1;
    }

    .chaptering-undo:hover {
        color: var(--accent);
    }
</style>
