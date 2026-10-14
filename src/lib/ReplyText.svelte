<script>
    /**
     * A reply's text: Markdown, with each embed of a workspace file
     * (`![name](/workspace/ui/x.plotly.json)`) rendered in its place.
     */
    import { splice } from './artifacts.js'
    import Artifact from './Artifact.svelte'
    import { renderMarkdown } from './markdown.js'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, text: string }} */
    let { session, text } = $props()

    const parts = $derived(splice(text))
</script>

<div class="text">
    {#each parts as part, i (i)}
        {#if 'md' in part}
            {@html renderMarkdown(part.md)}
        {:else}
            <Artifact {session} path={part.path} name={part.name} />
        {/if}
    {/each}
</div>

<style>
    .text :global(p) {
        margin: 0.4rem 0;
    }
</style>
