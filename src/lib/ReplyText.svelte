<script>
    /**
     * A reply's text: Markdown, with each embed of a workspace file
     * (`![name](/workspace/ui/x.plotly.json)`) rendered in its place,
     * and each link to one (`[plan](/workspace/notes/plan.md)`)
     * opening that file, as it is now, in the file viewer.
     */
    import { splice } from './artifacts.js'
    import Artifact from './Artifact.svelte'
    import FileModal from './FileModal.svelte'
    import { fileLinkTarget, renderMarkdown } from './markdown.js'

    /** @type {{ session: import('./studio.svelte.js').ChatSession, text: string, at?: string | null }} */
    let { session, text, at = null } = $props()

    const parts = $derived(splice(text))
    /** The opened file, relative to /workspace as the viewer takes it. */
    /** @type {string | null} */
    let opened = $state(null)

    /** A click on a file link opens the file instead of following the
     *  link's `#`; Enter on a focused link arrives here as a click too.
     *  @param {MouseEvent} e */
    function onclick(e) {
        const a = e.target instanceof Element ? e.target.closest('a[data-ws-path]') : null
        if (a === null) return
        e.preventDefault()
        // a value the renderer didn't write (raw HTML can set it) opens nothing
        opened = fileLinkTarget(a.getAttribute('data-ws-path'))
    }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="text" {onclick}>
    {#each parts as part, i (i)}
        {#if 'md' in part}
            <!-- each its own, so the markdown rules don't reach an artifact's tables -->
            <div class="markdown">{@html renderMarkdown(part.md)}</div>
        {:else}
            <Artifact {session} {at} path={part.path} name={part.name} />
        {/if}
    {/each}
</div>

{#if opened !== null}
    <FileModal {session} path={opened} onClose={() => (opened = null)} />
{/if}

<style>
    .text {
        line-height: 1.55;
    }
    .markdown {
        margin: 0.3rem 0;
    }
</style>
