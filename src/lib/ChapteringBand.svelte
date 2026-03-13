<script>
    /** @type {{ count?: number, onOpen?: () => void, onUndo?: () => void }} */
    let { count = 0, onOpen, onUndo } = $props()

    const label = $derived(count === 1 ? '1 chapter created' : `${count} chapters created`)
</script>

<div class="chaptering-band">
    {#if onOpen}
        <button class="chaptering-label clickable" onclick={onOpen}>{label}</button>
    {:else}
        <span class="chaptering-label">{label}</span>
    {/if}
    {#if onUndo}
        <button class="chaptering-undo" onclick={onUndo} title="Undo chaptering">undo</button>
    {/if}
</div>

<style>
    .chaptering-band {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 0;
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
