<script>
    /** @type {{ onSettingsClick: () => void, onSessionsClick: () => void, onFilesClick: () => void, onAppReloadClick?: () => void, onChapterClick?: () => void, configured: boolean, fileCount: number, showAppReload?: boolean, inputTokens?: number | null, chapteringTrigger?: number, activeKernel?: 'py' | 'ts' }} */
    let { onSettingsClick, onSessionsClick, onFilesClick, onAppReloadClick, onChapterClick, configured, fileCount = 0, showAppReload = false, inputTokens = null, chapteringTrigger = 150000, activeKernel = 'ts' } = $props()

    function formatTokens(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
        return String(n)
    }

    function percentTokens(used, total) {
        if (!total || total <= 0) return 0
        return Math.round((used / total) * 100)
    }
</script>

<header>
    <button
        class="sessions-btn"
        onclick={onSessionsClick}
        title="Sessions"
    >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
        </svg>
    </button>
    <h1 class="brand">
        <span class="brand-name">agex</span><span class="brand-suffix">.studio</span>
    </h1>
    {#if activeKernel === 'py'}
        <span
            class="kernel-warn"
            title="Python kernel: experimental. The agex-py sandbox (sandtrap) is a softer boundary than the TS interpreter sandbox; use only with trusted code."
        >py · exp</span>
    {/if}
    <div class="spacer"></div>
    {#if inputTokens != null}
        <button
            class="token-btn"
            onclick={onChapterClick}
            title="Context usage"
        >
            <span class="tokens-verbose">{formatTokens(inputTokens)} / {formatTokens(chapteringTrigger)}</span>
            <span class="tokens-compact">{percentTokens(inputTokens, chapteringTrigger)}%</span>
        </button>
    {/if}
    {#if showAppReload}
        <button
            class="app-reload-btn"
            onclick={onAppReloadClick}
            title="Reload app preview"
        >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
            </svg>
        </button>
    {/if}
    {#if fileCount > 0}
        <!-- File drawer is browse-only since uploads moved to the
             chat input's `+` button. With nothing to show and no
             controls inside, an empty drawer is just dead UI — hide
             the entry point until at least one file exists. -->
        <button
            class="files-btn"
            onclick={onFilesClick}
            title="Files"
        >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="file-badge">{fileCount}</span>
        </button>
    {/if}
    <a
        class="help-link"
        href="/docs/"
        title="Help & documentation"
        aria-label="Help & documentation"
    >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10"></circle>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
            <line x1="12" y1="17" x2="12.01" y2="17"></line>
        </svg>
    </a>
    <button
        class="settings-btn"
        class:unconfigured={!configured}
        onclick={onSettingsClick}
        title="Settings"
    >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
        </svg>
    </button>
</header>

<style>
    header {
        padding: 0.75rem 1rem;
        border-bottom: 1px solid var(--border);
        display: flex;
        align-items: center;
        gap: 1rem;
        flex-shrink: 0;
        /* Container queries below adapt the header to its own width
           rather than the viewport's — important because the chat
           pane width varies independently of viewport when the
           SplitPane ratio changes. */
        container-type: inline-size;
        container-name: header;
    }

    h1 {
        font-size: 1.25rem;
        margin: 0;
        /* Brand mark renders in the display face (set globally on
           all headings). Pull `opsz` up and SOFT to the soft end —
           the brand wants the chunky-organic personality of
           Fraunces at its most distinctive. */
        font-variation-settings: 'opsz' 72, 'SOFT' 100;
        letter-spacing: -0.02em;
    }

    /* Two-tone brand mark: `agex` heavy (the product, ~750 weight)
       and full-size, `.studio` regular, muted, and slightly smaller
       (1.05rem against the h1's 1.25rem) — gives a typographic
       contrast that reads as "product · domain" rather than two
       equal halves. Matches the brand treatment in Gallery and
       Docs headers so all three surfaces present one identity. */
    .brand-name {
        font-weight: 750;
    }

    .brand-suffix {
        font-weight: 400;
        color: var(--text-muted);
        font-size: 1.05rem;
    }

    /* Active-kernel "experimental" badge. Visible only on py
       sessions, sits next to the title so it's always in view
       without nagging the user. Warning color tinted with low
       saturation — informational, not alarming. */
    .kernel-warn {
        font-size: 0.6rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.1rem 0.35rem;
        border-radius: 3px;
        background: color-mix(in srgb, var(--warning) 18%, transparent);
        color: var(--warning);
        cursor: help;
    }

    .token-btn {
        background: none;
        border: 1px solid transparent;
        color: var(--text-muted);
        font-size: 0.7rem;
        white-space: nowrap;
        cursor: pointer;
        padding: 0.15rem 0.4rem;
        border-radius: 4px;
        display: flex;
        align-items: center;
        gap: 0.3rem;
    }

    .token-btn:hover {
        color: var(--text);
        border-color: var(--border);
    }

    .spacer {
        flex: 1;
    }

    .sessions-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.3rem;
        border-radius: 4px;
        display: flex;
        align-items: center;
    }

    .sessions-btn:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .files-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.3rem;
        border-radius: 4px;
        display: flex;
        align-items: center;
        position: relative;
    }

    .files-btn:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .app-reload-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.3rem;
        border-radius: 4px;
        display: flex;
        align-items: center;
    }

    .app-reload-btn:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .file-badge {
        position: absolute;
        inset: 3px 0 0 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 0.55rem;
        font-weight: 700;
        color: var(--text);
        pointer-events: none;
    }

    .help-link {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.3rem;
        border-radius: 4px;
        display: flex;
        align-items: center;
        text-decoration: none;
    }

    .help-link:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .settings-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0.3rem;
        border-radius: 4px;
        display: flex;
        align-items: center;
    }

    .settings-btn:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .settings-btn.unconfigured {
        color: var(--accent);
        animation: pulse 2s ease-in-out infinite;
    }

    @keyframes pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.5; }
    }

    /* Tokens display: verbose `101.2k / 800k` by default, percent
       `23%` when the header gets tight. Both spans render; CSS
       picks which is visible based on the header's own width. */
    .tokens-compact {
        display: none;
    }

    @container header (max-width: 480px) {
        .tokens-verbose {
            display: none;
        }
        .tokens-compact {
            display: inline;
        }
    }

    /* Even tighter: drop the brand mark entirely. Below ~360px the
       brand is competing with the icon row and tokens for space and
       loses readability anyway. */
    @container header (max-width: 360px) {
        h1.brand {
            display: none;
        }
    }
</style>
