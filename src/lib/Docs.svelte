<script>
    /**
     * Docs — sectioned help pages at `/docs/`.
     *
     * Hash-routed multi-page so individual sections are linkable:
     *   /docs/                 → defaults to first section
     *   /docs/#getting-started → loads getting-started.md
     *
     * Section markdown lives in `public/docs/<slug>.md` and renders
     * through the same `renderMarkdown` helper the chat / chapter
     * modals use. Adding a section = drop a new .md file + add an
     * entry to the SECTIONS array below.
     *
     * Stays a separate route from `/gallery/` because the intents
     * differ: gallery is "look at things people built," docs is
     * "learn how the studio works." Mixing them muddies both.
     */
    import { onMount } from 'svelte'
    import { renderMarkdown } from './markdown.js'

    /** Section registry. Order = sidebar order = default-section
     *  fallback. `slug` matches the `.md` filename and the URL hash;
     *  `title` is the sidebar label and the rendered page heading. */
    const SECTIONS = [
        { slug: 'getting-started', title: 'Getting started' },
    ]

    /** @type {string} */
    let activeSlug = $state(SECTIONS[0].slug)
    /** @type {string | null} */
    let content = $state(null)
    let loadError = $state('')
    /** Mobile sidebar visibility. Sidebar is always-shown on
     *  wide viewports; on narrow viewports it toggles via a
     *  button so the docs body gets the full width. */
    let sidebarOpen = $state(false)

    function slugFromHash() {
        const h = (typeof window !== 'undefined' ? window.location.hash : '') || ''
        const candidate = h.replace(/^#/, '')
        if (SECTIONS.find((s) => s.slug === candidate)) return candidate
        return SECTIONS[0].slug
    }

    async function loadSection(slug) {
        activeSlug = slug
        content = null
        loadError = ''
        try {
            const resp = await fetch(`/docs/${slug}.md`)
            if (!resp.ok) {
                throw new Error(`docs/${slug}.md HTTP ${resp.status}`)
            }
            content = await resp.text()
        } catch (err) {
            console.error(`Failed to load docs/${slug}.md:`, err)
            loadError = err.message || String(err)
            content = ''
        }
    }

    function selectSection(slug) {
        // Update the hash so the section is bookmarkable, then load.
        // pushState (not assign-to-hash) so we don't trigger the
        // hashchange listener below and double-load.
        const url = new URL(window.location.href)
        url.hash = slug
        window.history.pushState({}, '', url.toString())
        sidebarOpen = false
        loadSection(slug)
    }

    onMount(() => {
        loadSection(slugFromHash())
        const onHashChange = () => loadSection(slugFromHash())
        window.addEventListener('hashchange', onHashChange)
        return () => window.removeEventListener('hashchange', onHashChange)
    })

    function openEditor() {
        window.location.href = '/'
    }
</script>

<div class="docs-page">
    <header class="docs-header">
        <button class="brand" onclick={openEditor} title="Open the editor">
            <span class="brand-name">agex</span><span class="brand-suffix">.studio</span>
        </button>
        <span class="header-sep">·</span>
        <span class="header-section">docs</span>
        <div class="header-spacer"></div>
        <button
            class="sidebar-toggle"
            onclick={() => (sidebarOpen = !sidebarOpen)}
            aria-label="Toggle docs sidebar"
            title="Sections"
        >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="3" y1="12" x2="21" y2="12"></line>
                <line x1="3" y1="6" x2="21" y2="6"></line>
                <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
        </button>
        <button class="enter-editor" onclick={openEditor}>
            Open editor →
        </button>
    </header>

    <div class="docs-body">
        <aside class="docs-sidebar" class:open={sidebarOpen}>
            <nav>
                {#each SECTIONS as s (s.slug)}
                    <button
                        class="sidebar-item"
                        class:active={s.slug === activeSlug}
                        onclick={() => selectSection(s.slug)}
                    >
                        {s.title}
                    </button>
                {/each}
            </nav>
        </aside>

        <main class="docs-main">
            {#if content === null}
                <div class="docs-status">
                    <span class="spinner"></span>
                    <p>Loading…</p>
                </div>
            {:else if loadError}
                <div class="docs-status error">
                    <p>Couldn't load section: {loadError}</p>
                </div>
            {:else}
                <article class="markdown markdown-body">
                    {@html renderMarkdown(content)}
                </article>
            {/if}
        </main>
    </div>
</div>

<style>
    .docs-page {
        height: 100%;
        overflow-y: auto;
        background: var(--bg);
        color: var(--text);
        /* The app's root chain (html/body/#app) has overflow: hidden
           — that's the editor's contract (no page scroll, chat
           scrolls internally). The docs page reclaims its own scroll
           by becoming the scrolling container itself. Sticky
           positioning inside this container resolves against THIS
           element, so the sticky header/sidebar work naturally. */
    }

    .docs-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 1.25rem;
        border-bottom: 1px solid var(--border);
        background: var(--bg);
        position: sticky;
        top: 0;
        z-index: 10;
    }

    .brand {
        background: none;
        border: none;
        color: var(--text);
        cursor: pointer;
        font-size: 1.1rem;
        font-weight: 600;
        padding: 0;
        display: inline-flex;
        align-items: baseline;
    }

    .brand-suffix {
        color: var(--text-muted);
        font-weight: 400;
        font-size: 0.95rem;
    }

    .header-sep {
        color: var(--text-muted);
        opacity: 0.5;
    }

    .header-section {
        color: var(--text-muted);
        font-size: 0.95rem;
    }

    .header-spacer {
        flex: 1;
    }

    .sidebar-toggle {
        display: none;
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.3rem;
        border-radius: 4px;
    }

    .sidebar-toggle:hover {
        color: var(--text);
        background: var(--surface-hover);
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

    .docs-body {
        display: grid;
        /* Sidebar gets a fixed track so it doesn't grow with content;
           main gets `minmax(0, 1fr)` so wide children (long URLs,
           tables) can't push the column wider than the viewport.
           Without `minmax(0, ...)`, a single unbreakable token would
           force horizontal page scroll. */
        grid-template-columns: 180px minmax(0, 1fr);
        gap: 2rem;
        max-width: 1100px;
        width: 100%;
        margin: 0 auto;
        padding: 0 1.25rem;
        box-sizing: border-box;
        align-items: start;
    }

    .docs-sidebar {
        padding-top: 2rem;
        position: sticky;
        /* Stick just below the sticky header (header is ~50px tall
           with its padding). 1rem of breathing room beneath. */
        top: 3.5rem;
    }

    .docs-sidebar nav {
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
    }

    .sidebar-item {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.4rem 0.65rem;
        border-radius: 5px;
        font-size: 0.88rem;
        text-align: left;
        text-decoration: none;
        transition: color 0.15s, background 0.15s;
    }

    .sidebar-item:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .sidebar-item.active {
        color: var(--text);
        background: var(--surface-hover);
        font-weight: 500;
    }

    .docs-main {
        padding: 2rem 0 4rem;
        min-width: 0;
    }

    /* Docs-specific markdown overrides. The global `.markdown`
       styles in app.css are tuned for chat (small headings, tight
       spacing) — appropriate for inline activity-card content,
       cramped for a dedicated docs page. Bump heading sizes and
       open up vertical rhythm here without disturbing the chat
       rendering. */
    .markdown-body {
        max-width: 70ch;
        line-height: 1.65;
        font-size: 0.95rem;
    }

    .markdown-body :global(h1) {
        font-size: 1.75rem;
        margin: 0 0 1rem;
        line-height: 1.25;
    }
    .markdown-body :global(h2) {
        font-size: 1.25rem;
        margin: 1.75rem 0 0.5rem;
        line-height: 1.3;
    }
    .markdown-body :global(h3) {
        font-size: 1.05rem;
        margin: 1.25rem 0 0.4rem;
    }
    .markdown-body :global(p) {
        margin: 0.7em 0;
    }
    .markdown-body :global(ul),
    .markdown-body :global(ol) {
        margin: 0.7em 0;
    }
    .markdown-body :global(li) {
        margin: 0.35em 0;
    }
    .markdown-body :global(hr) {
        border: none;
        border-top: 1px solid var(--border);
        margin: 2rem 0;
    }

    /* Wrap long URLs / unbreakable tokens so they can't push the
       content column past its grid track. `overflow-wrap: anywhere`
       only kicks in when needed; normal prose still wraps at word
       boundaries. Scoped to links so we don't mangle prose. */
    .markdown-body :global(a) {
        overflow-wrap: anywhere;
    }

    /* Table styling: the global `.markdown table` has width: 100%
       which works here, but we want cell content to wrap and a
       softer border-styling for the docs context. */
    .markdown-body :global(table) {
        width: 100%;
        border-collapse: collapse;
        margin: 1rem 0;
        font-size: 0.9rem;
    }
    .markdown-body :global(th),
    .markdown-body :global(td) {
        text-align: left;
        padding: 0.5rem 0.65rem;
        border-bottom: 1px solid var(--border);
        word-break: break-word;
    }
    .markdown-body :global(th) {
        font-weight: 600;
        color: var(--text);
    }

    .docs-status {
        text-align: center;
        padding: 3rem 1rem;
        color: var(--text-muted);
    }

    .docs-status.error {
        color: var(--error);
    }

    .docs-status .spinner {
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

    /* Mobile: sidebar collapses behind the toggle button.
       Grid collapses to single column; sidebar shows above the
       main content only when the toggle is open. */
    @media (max-width: 768px) {
        .sidebar-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .docs-body {
            grid-template-columns: minmax(0, 1fr);
            gap: 0;
        }
        .docs-sidebar {
            display: none;
            position: static;
            padding: 0.75rem 0 0.5rem;
            border-bottom: 1px solid var(--border);
        }
        .docs-sidebar.open {
            display: block;
        }
        .docs-main {
            padding: 1.25rem 0 4rem;
        }
        /* Slightly smaller headings on narrow viewports so they
           don't dominate the column at phone widths. */
        .markdown-body :global(h1) {
            font-size: 1.5rem;
        }
        .markdown-body :global(h2) {
            font-size: 1.15rem;
        }
    }
</style>
