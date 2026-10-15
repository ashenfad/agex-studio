<script>
    /**
     * How much the next request carries: the session's context, against
     * the size past which earlier turns fold into a summary. A click
     * says what it means and offers to fold now.
     */
    import { getSettings, settingsStore } from './settings.js'

    /** @type {{ session: import('./studio.svelte.js').ChatSession }} */
    let { session } = $props()

    let open = $state(false)

    const budget = $derived($settingsStore.foldBudget ?? getSettings().foldBudget)
    const tokens = $derived(session.context)
    const share = $derived(budget > 0 && tokens !== null ? Math.min(1, tokens / budget) : 0)
    const level = $derived(share >= 0.9 ? 'high' : share >= 0.6 ? 'mid' : 'low')

    /** @param {number} n */
    const k = (n) => (n < 1000 ? String(n) : `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`)

    const label = $derived(tokens === null ? '' : budget > 0 ? `${k(tokens)} / ${k(budget)}` : k(tokens))

    async function foldNow() {
        open = false
        await session.foldNow()
    }
</script>

<svelte:window onclick={() => (open = false)} />

{#if session.folding}
    <span class="meter folding" title="Folding the conversation into a summary…">folding…</span>
{:else if tokens !== null}
    <span class="wrap">
        <button
            class="meter {level}"
            onclick={(e) => {
                e.stopPropagation()
                open = !open
            }}
            title="Context: about {k(tokens)} tokens with the next request"
            aria-label="Context: about {k(tokens)} tokens{budget > 0 ? ` of ${k(budget)}` : ''}"
            aria-expanded={open}
        >
            <span class="bar" aria-hidden="true"><span class="fill" style="width: {Math.round(share * 100)}%"></span></span>
            {label}
        </button>
        {#if open}
            <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
            <div class="pop" onclick={(e) => e.stopPropagation()}>
                <p>
                    <b>About {k(tokens)} tokens</b> go with the next request: the conversation so far, the agent's
                    instructions and its tools.
                </p>
                <p class="muted">
                    {#if budget > 0 && tokens >= budget}
                        That's past {k(budget)}, so the next turn folds earlier turns into a summary first (Settings).
                    {:else if budget > 0}
                        Past {k(budget)}, earlier turns fold into a summary on their own (Settings).
                    {:else}
                        Folding is off (Settings): the conversation grows until the model's limit.
                    {/if}
                    {#if session.folds.length}Folded {session.folds.length === 1 ? 'once' : `${session.folds.length} times`} so far.{/if}
                </p>
                <button class="fold" onclick={foldNow} disabled={session.busy || !session.foldable || session.interrupted}>Fold now</button>
                <p class="muted small">
                    {#if session.busy}
                        Once the turn running ends.
                    {:else if !session.foldable}
                        Nothing new to fold since the last fold.
                    {:else}
                        The agent's model summarizes everything so far, and the next request starts from the summary. It
                        keeps the gist, not every detail.
                    {/if}
                </p>
            </div>
        {/if}
    </span>
{/if}

<style>
    .wrap {
        position: relative;
    }
    .meter {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        background: none;
        border: none;
        border-radius: 6px;
        color: var(--text-muted);
        font: inherit;
        font-size: 0.75rem;
        font-variant-numeric: tabular-nums;
        padding: 0.2rem 0.4rem;
        cursor: pointer;
    }
    .meter:hover {
        background: var(--surface-hover);
        color: var(--text);
    }
    .meter.folding {
        cursor: default;
    }
    /* the empty track shows against the composer's own blue (which
       --border shares), so the bar reads as a meter when nearly empty */
    .bar {
        width: 2.6rem;
        height: 5px;
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.16);
        overflow: hidden;
    }
    .fill {
        display: block;
        height: 100%;
        background: var(--text-muted);
    }
    .mid .fill {
        background: #d9a441;
    }
    .high .fill {
        background: var(--error);
    }
    .high {
        color: var(--error);
    }
    .pop {
        position: absolute;
        right: 0;
        bottom: calc(100% + 0.4rem);
        z-index: 20;
        width: min(19rem, 80vw);
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 0.7rem 0.8rem;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        font-size: 0.82rem;
        line-height: 1.45;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        cursor: default;
    }
    .pop p {
        margin: 0;
    }
    .muted {
        color: var(--text-muted);
    }
    .small {
        font-size: 0.75rem;
    }
    .fold {
        align-self: flex-start;
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.35rem 0.8rem;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
    }
    .fold:disabled {
        opacity: 0.45;
        cursor: default;
    }
</style>
