<script>
    /** A small "metric" card — label on top, big value below.
     *  Used inside CardRow as one of the items. Designed for at-a-glance
     *  numbers / short strings (`~3.5 hrs`, `4 sessions`, `Mon, Fri`).
     *
     *  @type {{ label: string, value: string, sublabel?: string }} */
    let { label, value, sublabel = '' } = $props()
</script>

<div class="stat-card">
    <div class="stat-label">{label}</div>
    <div class="stat-value">{value}</div>
    {#if sublabel}
        <div class="stat-sublabel">{sublabel}</div>
    {/if}
</div>

<style>
    .stat-card {
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.75rem 0.85rem;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        flex: 1 1 160px;
        min-width: 140px;
    }

    .stat-label {
        font-size: 0.78rem;
        color: var(--text-muted);
        line-height: 1.2;
    }

    .stat-value {
        font-size: 1.4rem;
        font-weight: 600;
        color: var(--text);
        line-height: 1.1;
        word-break: break-word;
    }

    .stat-sublabel {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-top: 0.1rem;
    }
</style>
