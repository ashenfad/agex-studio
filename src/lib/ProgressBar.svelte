<script>
    /**
     * Labeled progress bar used by the export and publish flows. When
     * `total` is falsy the fill goes indeterminate (a sliding sliver)
     * and the counts row shows `pending` text instead of "done / total".
     * Pass no `pending` to hide the counts row entirely (e.g. the
     * publish "uploading" stage, which is pure indeterminate).
     */
    /** @type {{ label: string, done?: number, total?: number, pending?: string }} */
    let { label, done = 0, total = 0, pending } = $props()
</script>

<div class="progress-label">{label}</div>
<div class="progress-bar">
    <div
        class="progress-fill"
        class:indeterminate={!total}
        style={total ? `width: ${Math.round((done / total) * 100)}%` : ''}
    ></div>
</div>
{#if total}
    <div class="progress-counts">{done} / {total}</div>
{:else if pending}
    <div class="progress-counts">{pending}</div>
{/if}

<style>
    .progress-label {
        font-size: 0.8rem;
        color: var(--text);
        margin-bottom: 0.4rem;
    }

    .progress-bar {
        height: 6px;
        background: var(--input-bg, var(--surface));
        border-radius: 3px;
        overflow: hidden;
        position: relative;
    }

    .progress-fill {
        height: 100%;
        background: var(--accent);
        transition: width 0.15s ease-out;
    }

    .progress-fill.indeterminate {
        width: 30%;
        animation: progress-indeterminate 1.2s ease-in-out infinite;
    }

    @keyframes progress-indeterminate {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
    }

    .progress-counts {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-top: 0.35rem;
        text-align: right;
    }
</style>
