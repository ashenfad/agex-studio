<script>
    /**
     * A reply's text: Markdown, with each embed of a workspace file
     * (`![name](/workspace/ui/x.plotly.json)`) rendered in its place.
     */
    import { splice } from './artifacts.js'
    import Artifact from './Artifact.svelte'
    import { renderMarkdown } from './markdown.js'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, text: string, at?: string | null }} */
    let { session, text, at = null } = $props()

    const parts = $derived(splice(text))
</script>

<div class="text">
    {#each parts as part, i (i)}
        {#if 'md' in part}
            <!-- each its own, so the markdown rules don't reach an artifact's tables -->
            <div class="markdown">{@html renderMarkdown(part.md)}</div>
        {:else}
            <Artifact {session} {at} path={part.path} name={part.name} />
        {/if}
    {/each}
</div>

<style>
    .text {
        line-height: 1.55;
    }
    .markdown {
        margin: 0.3rem 0;
    }
</style>
