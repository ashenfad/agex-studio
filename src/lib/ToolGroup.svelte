<script>
    /**
     * A run of work (tool calls, with the thinking between them) as one
     * quiet line in plain words: "Ran code 3 times, edited 1 file".
     * Opening it lists a line per step and per stretch of thinking, in
     * the order they came, each opening to its detail: a long run reads
     * as a sentence until someone asks for more. A run of one call is
     * that call's own line, with no sentence over it.
     */
    import { groupPhrases } from './activity.js'
    import ThinkingBlock from './ThinkingBlock.svelte'
    import ToolStep from './ToolStep.svelte'

    /** @type {{ entries: import('./activity.js').Item[], live?: boolean }} */
    let { entries, live = false } = $props()

    let open = $state(false)
    const tools = $derived(
        /** @type {import('./activity.js').ToolItem[]} */ (entries.filter((e) => e.kind === 'tool')),
    )
    const running = $derived(live && tools.some((t) => t.result === null))
    const failed = $derived(tools.filter((t) => t.isError).length)
    const phrases = $derived(groupPhrases(tools))
</script>

{#snippet steps()}
    {#each entries as e, i (i)}
        {#if e.kind === 'tool'}
            <ToolStep tool={e} {live} />
        {:else if e.kind === 'thinking'}
            <ThinkingBlock text={e.text} />
        {/if}
    {/each}
{/snippet}

{#if tools.length === 1}
    {@render steps()}
{:else}
    <div>
        <button class="act-line group" class:open class:act-live={running} onclick={() => (open = !open)}>
            {#each phrases as ph, i (i)}
                <span class="act-verb">{ph.verb}</span>
                <span class="act-rest">{ph.rest}{i < phrases.length - 1 ? ',' : ''}</span>
            {/each}
            {#if failed}<span class="act-rest failed">· {failed} failed</span>{/if}
            <span class="act-chev">⌄</span>
        </button>
        {#if open}
            <div class="act-body">{@render steps()}</div>
        {/if}
    </div>
{/if}

<style>
    /* a long sentence wraps rather than clipping each of its phrases */
    .group {
        flex-wrap: wrap;
    }
    .group .act-rest {
        flex-shrink: 0;
    }
    .failed {
        color: var(--error);
    }
</style>
