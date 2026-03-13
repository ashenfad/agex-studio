<script>
    /** @type {{ onSettingsClick: () => void, onSessionsClick: () => void, onFilesClick: () => void, onChapterClick?: () => void, configured: boolean, fileCount: number, inputTokens?: number | null, chapteringTrigger?: number }} */
    let { onSettingsClick, onSessionsClick, onFilesClick, onChapterClick, configured, fileCount = 0, inputTokens = null, chapteringTrigger = 150000 } = $props()

    function formatTokens(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
        return String(n)
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
    <h1>agex</h1>
    <div class="spacer"></div>
    {#if inputTokens != null}
        <button
            class="token-btn"
            onclick={onChapterClick}
            title="Context usage"
        >
            {formatTokens(inputTokens)} / {formatTokens(chapteringTrigger)}
        </button>
    {/if}
    <button
        class="files-btn"
        onclick={onFilesClick}
        title="Files"
    >
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
        </svg>
        {#if fileCount > 0}
            <span class="file-badge">{fileCount}</span>
        {/if}
    </button>
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
    }

    h1 {
        font-size: 1.1rem;
        font-weight: 600;
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
</style>
