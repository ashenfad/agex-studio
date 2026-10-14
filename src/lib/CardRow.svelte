<script>
    import StatCard from './StatCard.svelte'
    import CalloutCard from './CalloutCard.svelte'

    /** Horizontal-with-wrap row of stat / callout cards.
     *
     *  Each item is dispatched by its `type`:
     *    - `{ type: 'stat', label, value, sublabel? }` → StatCard
     *    - `{ type: 'callout', title, body, tone? }` → CalloutCard
     *
     *  Items of unknown types are silently skipped — defensive, since
     *  `normalizePart` already filters non-card kinds before they
     *  reach here, but a future shape addition shouldn't crash the
     *  renderer if it slips through.
     *
     *  @type {{ items: Array<object> }} */
    let { items } = $props()
</script>

<div class="card-row">
    {#each items as item, i (i)}
        {#if item.type === 'stat'}
            <StatCard
                label={item.label}
                value={item.value}
                sublabel={item.sublabel || ''}
            />
        {:else if item.type === 'callout'}
            <CalloutCard
                title={item.title || ''}
                body={item.body || ''}
                tone={item.tone || 'info'}
            />
        {/if}
    {/each}
</div>

<style>
    /* Cards wrap when they don't fit in one line — at chat-bubble
       widths (≤ 900px) a row of 4 stat cards typically fits, a row
       of 3 callouts often does too, and anything wider gracefully
       reflows to two rows on narrow viewports. */
    .card-row {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
        margin: 0.4em 0;
        width: 100%;
    }
</style>
