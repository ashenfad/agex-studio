<script>
    /**
     * Gallery — static-ish curated showcase of agex.studio sessions.
     *
     * Loaded at `/gallery/` (a third SPA entry point — see
     * `vite.config.js` `copyGalleryEntryPoint`). Reads
     * `/gallery.json` for the curated list and renders one
     * `GalleryCard` per entry; falls into an empty-state block when
     * the list is empty.
     *
     * The list is hand-edited and PRed in alongside thumbnail PNGs
     * under `/gallery/thumbs/<filename>`. Submissions arrive via the
     * GitHub issue template (`gallery-submission.md`); the curator
     * vets, picks a frame, and adds the entry.
     */
    import { onMount } from 'svelte'
    import GalleryCard from './GalleryCard.svelte'

    /** @type {Array<object> | null} */
    let entries = $state(null)
    let loadError = $state('')

    onMount(async () => {
        try {
            // Same-origin fetch — the deploy serves both `/gallery/`
            // and `/gallery.json` from the same GH Pages bucket. No
            // CORS concerns.
            const resp = await fetch('/gallery.json')
            if (!resp.ok) {
                throw new Error(`gallery.json HTTP ${resp.status}`)
            }
            const data = await resp.json()
            entries = Array.isArray(data) ? data : []
        } catch (err) {
            console.error('Failed to load gallery.json:', err)
            loadError = err.message || String(err)
            entries = []
        }
    })

    function openEditor() {
        // Plain navigation back to the editor root. The editor's
        // own header has Sessions / Files / Settings; from there
        // users can hit the same "Browse gallery" entry to come back.
        window.location.href = '/'
    }
</script>

<div class="gallery-page">
    <header class="gallery-header">
        <button class="brand" onclick={openEditor} title="Open the editor">
            <span class="brand-name">agex</span>
            <span class="brand-suffix">.studio</span>
        </button>
        <div class="header-spacer"></div>
        <button class="enter-editor" onclick={openEditor}>
            Open editor →
        </button>
    </header>

    <main class="gallery-body">
        <div class="page-intro">
            <h1>Gallery</h1>
            <p class="intro-prose">
                Apps and chats built in agex.studio. Click any card to try it
                yourself, or open the showcase view to see how the agent put
                it together.
            </p>
        </div>

        {#if entries === null}
            <div class="gallery-status">
                <span class="spinner"></span>
                <p>Loading gallery...</p>
            </div>
        {:else if loadError}
            <div class="gallery-status error">
                <p>Couldn't load the gallery: {loadError}</p>
            </div>
        {:else if entries.length === 0}
            <!-- Empty-state copy. Curated gallery starts empty;
                 this is the placeholder until the first item lands. -->
            <div class="gallery-empty">
                <p class="empty-headline">No entries yet.</p>
                <p class="empty-prose">
                    The gallery is curated from user submissions. If
                    you've built something in agex.studio worth
                    sharing, hit
                    <strong>Submit to gallery</strong> in the publish
                    modal after publishing.
                </p>
            </div>
        {:else}
            <div class="gallery-grid">
                {#each entries as entry, i (entry.gistShorthand || i)}
                    <GalleryCard {entry} />
                {/each}
            </div>
        {/if}
    </main>

</div>

<style>
    .gallery-page {
        height: 100%;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        background: var(--bg);
        color: var(--text);
        /* Same scroll-reclaim as the docs page — the app root has
           overflow: hidden for the editor's no-page-scroll contract;
           the gallery becomes its own scrolling container so cards
           below the fold are reachable. */
    }

    .gallery-header {
        display: flex;
        align-items: center;
        gap: 1rem;
        padding: 0.75rem 1.25rem;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
    }

    /* Brand mark — matches the editor header's treatment so the
       identity carries across surfaces. Display face, SOFT 100,
       weight differential between name and suffix. */
    .brand {
        background: none;
        border: none;
        color: var(--text);
        cursor: pointer;
        font-family: var(--font-display);
        font-size: 1.25rem;
        font-weight: 750;
        font-variation-settings: 'opsz' 72, 'SOFT' 100;
        letter-spacing: -0.02em;
        padding: 0;
        display: inline-flex;
        align-items: baseline;
    }

    .brand-suffix {
        color: var(--text-muted);
        font-weight: 400;
        font-size: 1.05rem;
    }

    .header-spacer {
        flex: 1;
    }

    .enter-editor {
        background: var(--accent);
        color: white;
        border: none;
        padding: 0.45rem 0.85rem;
        border-radius: 6px;
        font-size: 0.85rem;
        font-weight: 500;
        cursor: pointer;
    }

    .enter-editor:hover {
        background: var(--accent-hover);
    }

    .gallery-body {
        flex: 1;
        padding: 2rem 1.25rem;
        max-width: 1100px;
        width: 100%;
        margin: 0 auto;
        box-sizing: border-box;
    }

    .page-intro {
        margin-bottom: 2rem;
    }

    .page-intro h1 {
        font-size: 3rem;
        font-weight: 500;
        margin: 0 0 0.75rem;
        /* Big optical-size + soft for an editorial moment. */
        font-variation-settings: 'opsz' 144, 'SOFT' 100;
        letter-spacing: -0.03em;
        line-height: 1.05;
    }

    .intro-prose {
        color: var(--text-muted);
        font-size: 1rem;
        line-height: 1.55;
        max-width: 60ch;
    }

    .gallery-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: 1.25rem;
    }

    .gallery-status,
    .gallery-empty {
        text-align: center;
        padding: 3rem 1rem;
        color: var(--text-muted);
    }

    .gallery-status.error {
        color: var(--error);
    }

    .gallery-status .spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid var(--text-muted);
        border-top-color: transparent;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        margin-bottom: 0.5rem;
    }

    @keyframes spin {
        to { transform: rotate(360deg); }
    }

    .empty-headline {
        font-size: 1.1rem;
        color: var(--text);
        font-weight: 500;
        margin: 0 0 0.5rem;
    }

    .empty-prose {
        max-width: 50ch;
        margin: 0 auto;
        line-height: 1.5;
    }

</style>
