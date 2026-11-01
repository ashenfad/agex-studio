<script>
    /**
     * The frame every card an agent asks the person with shares (a key,
     * sites, and the cards to come): its title, why the agent asks, what
     * the card asks for, what follows from answering, and its buttons.
     */

    /** @type {{ title: import('svelte').Snippet, why: string, children?: import('svelte').Snippet, note?: import('svelte').Snippet, errors?: string[], actions: import('svelte').Snippet }} */
    let { title, why, children, note, errors = [], actions } = $props()

    const uid = $props.id()
</script>

<section class="ask" aria-labelledby="{uid}-title">
    <h2 id="{uid}-title">{@render title()}</h2>
    <p class="why">{why}</p>
    {@render children?.()}
    {#if note}<p class="note">{@render note()}</p>{/if}
    {#if errors.length > 0}
        <ul class="errors" role="alert">
            {#each errors as e, i (i)}<li>{e}</li>{/each}
        </ul>
    {/if}
    <div class="actions">{@render actions()}</div>
</section>

<style>
    .ask {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.6rem 0.7rem;
        margin: 0.5rem 0;
        background: var(--surface);
        font-size: 0.85rem;
    }
    h2 {
        margin: 0;
        font-size: 0.9rem;
        font-weight: 600;
    }
    p {
        margin: 0;
    }
    .why {
        color: var(--text-muted);
    }
    .note {
        color: var(--caution, #d9a441);
        font-size: 0.8rem;
    }
    .ask :global(code) {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        overflow-wrap: anywhere;
    }
    .errors {
        list-style: none;
        margin: 0;
        padding: 0;
        color: var(--error);
        font-size: 0.8rem;
    }
    .actions {
        display: flex;
        gap: 0.5rem;
    }
</style>
