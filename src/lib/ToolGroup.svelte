<script>
    /**
     * A run of work (tool calls, with the thinking between them) as one
     * quiet line in plain words: "Ran code 3 times, edited 1 file".
     * Opening it lists a line per step and per stretch of thinking, in
     * the order they came, each opening to its detail: a long run reads
     * as a sentence until someone asks for more.
     */
    import { groupPhrases } from './activity.js'
    import ThinkingBlock from './ThinkingBlock.svelte'
    import ToolStep from './ToolStep.svelte'

    /** @type {{ entries: import('./activity.js').Item[] }} */
    let { entries } = $props()

    let open = $state(false)
    const tools = $derived(
        /** @type {import('./activity.js').ToolItem[]} */ (entries.filter((e) => e.kind === 'tool')),
    )
    const running = $derived(tools.some((t) => t.result === null))
    const failed = $derived(tools.filter((t) => t.isError).length)
    const phrases = $derived(groupPhrases(tools))
</script>

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
        <div class="act-body">
            {#each entries as e, i (i)}
                {#if e.kind === 'tool'}
                    <ToolStep tool={e} />
                {:else if e.kind === 'thinking'}
                    <ThinkingBlock text={e.text} />
                {/if}
            {/each}
        </div>
    {/if}
</div>

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
