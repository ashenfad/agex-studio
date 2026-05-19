<script>
    /**
     * One card in the gallery grid. Reads a single entry from
     * `gallery.json` and renders thumb, name, description, tag chips,
     * kernel badge, and the open buttons.
     *
     * URL construction: the entry's `gistShorthand` is a 4-part
     * pinned form (`USER/ID/SHA/SLUG`) — gallery entries are
     * byte-immutable by design (see commit e40ab42). We derive the
     * showcase and play URLs from that shorthand.
     *
     * The `description` field renders as markdown (curator-trusted
     * content from `public/gallery.json`), so curators can drop in
     * inline emphasis / links to highlight specific phrases.
     */
    import { renderMarkdown } from './markdown.js'

    /** @type {{ entry: {
     *   name: string,
     *   description?: string,
     *   gistShorthand: string,
     *   kernel?: 'ts' | 'py',
     *   hasApp?: boolean,
     *   tags?: string[],
     *   thumbnail?: string,
     * } }} */
    let { entry } = $props()

    const base = typeof window !== 'undefined' ? window.location.origin : ''
    const showcaseUrl = `${base}/run/?gist=${entry.gistShorthand}`
    const playUrl = `${showcaseUrl}&play=1`
    const thumbSrc = entry.thumbnail ? `/gallery/thumbs/${entry.thumbnail}` : ''
    const kernel = entry.kernel || 'ts'
</script>

<article class="card">
    <div class="thumb" class:placeholder={!thumbSrc} data-kernel={kernel}>
        {#if thumbSrc}
            <img src={thumbSrc} alt="" loading="lazy" />
        {:else}
            <!-- Placeholder block — kernel-tinted so the grid still
                 reads coherently when thumbs are missing during the
                 curation window between "JSON entry added" and
                 "screenshot captured." -->
            <span class="placeholder-mark">{kernel.toUpperCase()}</span>
        {/if}
    </div>
    <div class="body">
        <div class="title-row">
            <h2 class="title">{entry.name}</h2>
            <span class="kernel-badge kernel-{kernel}">{kernel.toUpperCase()}</span>
        </div>
        {#if entry.description}
            <div class="description markdown">{@html renderMarkdown(entry.description)}</div>
        {/if}
        {#if entry.tags && entry.tags.length > 0}
            <div class="tags">
                {#each entry.tags as tag}
                    <span class="tag">#{tag}</span>
                {/each}
            </div>
        {/if}
    </div>
    <div class="actions">
        {#if entry.hasApp}
            <!-- Two-button layout for app sessions: Try it (play mode,
                 no chat chrome) leads, See how (showcase, split view)
                 is secondary. Order matches the publish modal's
                 'Share with users' / 'Share with builders' framing. -->
            <a class="btn primary" href={playUrl} target="_blank" rel="noopener">
                Try it
            </a>
            <a class="btn secondary" href={showcaseUrl} target="_blank" rel="noopener">
                See how →
            </a>
        {:else}
            <a class="btn primary single" href={showcaseUrl} target="_blank" rel="noopener">
                Open →
            </a>
        {/if}
    </div>
</article>

<style>
    .card {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transition: transform 0.15s, border-color 0.15s;
    }

    .card:hover {
        border-color: color-mix(in srgb, var(--accent) 50%, var(--border));
        transform: translateY(-2px);
    }

    .thumb {
        aspect-ratio: 16 / 9;
        background: var(--surface-hover);
        overflow: hidden;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .thumb img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
    }

    /* Kernel-tinted placeholder for entries without a thumbnail yet.
       Subtle background tint + a large kernel mark — readable as
       "TS app" vs "Py app" at a glance even without imagery. */
    .thumb.placeholder[data-kernel="ts"] {
        background: color-mix(in srgb, var(--accent) 18%, var(--surface-hover));
    }
    .thumb.placeholder[data-kernel="py"] {
        background: color-mix(in srgb, var(--warning, #d29922) 18%, var(--surface-hover));
    }

    .placeholder-mark {
        font-size: 2rem;
        font-weight: 700;
        color: var(--text-muted);
        letter-spacing: 0.1em;
        opacity: 0.6;
    }

    .body {
        padding: 0.85rem 1rem 0.5rem;
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 0.45rem;
    }

    .title-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }

    .title {
        /* Card title in the display face. Small-size opsz (12)
           keeps the serifs from looking spindly at this scale;
           moderate softness (40) reads as polished, not playful. */
        font-size: 1.05rem;
        font-weight: 600;
        margin: 0;
        line-height: 1.25;
        font-variation-settings: 'opsz' 12, 'SOFT' 40;
        letter-spacing: -0.005em;
    }

    .kernel-badge {
        font-size: 0.6rem;
        font-weight: 700;
        padding: 0.1rem 0.35rem;
        border-radius: 3px;
        letter-spacing: 0.05em;
        flex-shrink: 0;
    }

    .kernel-badge.kernel-ts {
        background: color-mix(in srgb, var(--accent) 18%, transparent);
        color: var(--accent);
    }

    .kernel-badge.kernel-py {
        background: color-mix(in srgb, var(--warning, #d29922) 18%, transparent);
        color: var(--warning, #d29922);
    }

    .description {
        font-size: 0.82rem;
        color: var(--text-muted);
        line-height: 1.45;
        margin: 0;
    }

    .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
    }

    .tag {
        font-size: 0.7rem;
        color: var(--text-muted);
        background: var(--surface-hover);
        padding: 0.1rem 0.4rem;
        border-radius: 3px;
    }

    .actions {
        display: flex;
        gap: 0.5rem;
        padding: 0.5rem 1rem 0.85rem;
    }

    .btn {
        flex: 1;
        text-align: center;
        padding: 0.45rem 0.65rem;
        border-radius: 6px;
        font-size: 0.82rem;
        font-weight: 500;
        text-decoration: none;
        transition: background 0.15s, color 0.15s;
    }

    .btn.primary {
        background: var(--accent);
        color: white;
    }

    .btn.primary:hover {
        background: var(--accent-hover);
    }

    .btn.secondary {
        background: transparent;
        color: var(--text-muted);
        border: 1px solid var(--border);
    }

    .btn.secondary:hover {
        color: var(--text);
        border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
    }

    .btn.single {
        max-width: 50%;
        margin: 0 auto;
    }
</style>
