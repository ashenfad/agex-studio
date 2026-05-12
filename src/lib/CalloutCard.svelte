<script>
    /** A callout card — icon (per tone) + title + body text.
     *  Used inside CardRow as one of the items. Designed for emphasized
     *  observations / insights / warnings that benefit from a card
     *  treatment instead of a paragraph in a markdown bubble.
     *
     *  @type {{ title: string, body: string, tone?: 'info' | 'success' | 'warning' }} */
    let { title, body, tone = 'info' } = $props()

    /** Render the body as multiple paragraphs if the agent included
     *  blank-line separators. Otherwise single paragraph. Markdown
     *  is intentionally NOT applied here — callouts are short text
     *  blurbs, not arbitrary markdown. Keeps the visual contract
     *  predictable. */
    const paragraphs = $derived(
        body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
    )
</script>

<div class="callout-card" class:tone-success={tone === 'success'} class:tone-warning={tone === 'warning'}>
    <div class="callout-header">
        <span class="callout-icon" aria-hidden="true">
            {#if tone === 'success'}
                <!-- shield/check -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
                    <polyline points="9 12 11 14 15 10"></polyline>
                </svg>
            {:else if tone === 'warning'}
                <!-- triangle/exclamation -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                    <line x1="12" y1="9" x2="12" y2="13"></line>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
            {:else}
                <!-- info circle -->
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
            {/if}
        </span>
        <h4 class="callout-title">{title}</h4>
    </div>
    {#if paragraphs.length > 0}
        <div class="callout-body">
            {#each paragraphs as p}
                <p>{p}</p>
            {/each}
        </div>
    {/if}
</div>

<style>
    .callout-card {
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.85rem 0.9rem;
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
        flex: 1 1 200px;
        min-width: 180px;
    }

    .callout-header {
        display: flex;
        align-items: center;
        gap: 0.45rem;
    }

    /* Tone gives the icon a color tint. The card body / border stay
       neutral so a row of mixed-tone callouts reads as a uniform set
       of cards rather than a noisy traffic light. */
    .callout-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        color: #7cb7ff; /* info default */
        flex-shrink: 0;
    }

    .callout-card.tone-success .callout-icon { color: var(--success); }
    .callout-card.tone-warning .callout-icon { color: var(--warning); }

    .callout-title {
        font-size: 0.92rem;
        font-weight: 600;
        color: var(--text);
        margin: 0;
        line-height: 1.25;
    }

    .callout-body {
        font-size: 0.82rem;
        color: var(--text);
        line-height: 1.45;
    }

    .callout-body p {
        margin: 0 0 0.4em;
    }

    .callout-body p:last-child {
        margin-bottom: 0;
    }
</style>
