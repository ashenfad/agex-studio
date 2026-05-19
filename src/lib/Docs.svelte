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
        min-height: 100vh;
        display: flex;
        flex-direction: column;
        background: var(--bg);
        color: var(--text);
    }

    .docs-header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.75rem 1.25rem;
        border-bottom: 1px solid var(--border);
        flex-shrink: 0;
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
        flex: 1;
        display: flex;
        max-width: 1100px;
        width: 100%;
        margin: 0 auto;
        box-sizing: border-box;
        min-height: 0;
    }

    .docs-sidebar {
        flex-shrink: 0;
        width: 200px;
        padding: 1.5rem 0.75rem 1.5rem 1.25rem;
        border-right: 1px solid var(--border);
    }

    .docs-sidebar nav {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        position: sticky;
        top: 1rem;
    }

    .sidebar-item {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.4rem 0.65rem;
        border-radius: 5px;
        font-size: 0.9rem;
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
        flex: 1;
        padding: 1.5rem 1.5rem 4rem;
        min-width: 0;
    }

    .markdown-body {
        max-width: 70ch;
        line-height: 1.6;
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

    /* Mobile: sidebar collapses behind the toggle. With only one
       section initially this is irrelevant, but the pattern is in
       place for when the docs grow. */
    @media (max-width: 768px) {
        .sidebar-toggle {
            display: inline-flex;
            align-items: center;
            justify-content: center;
        }
        .docs-sidebar {
            display: none;
            width: 100%;
            padding: 0.5rem 1rem;
            border-right: none;
            border-bottom: 1px solid var(--border);
        }
        .docs-sidebar.open {
            display: block;
        }
        .docs-body {
            flex-direction: column;
        }
    }
</style>
