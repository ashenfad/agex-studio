<script>
    /**
     * Mobile app switcher — a bottom sheet for flipping between kept apps
     * (and back to chat) while viewing an app full-screen on a phone.
     *
     * The mobile counterpart to the desktop AppLauncherRail. On mobile
     * the app view is already full-screen single-pane, so there's no
     * separate "full-screen mode" — this just augments the app view. It's
     * opened from the mobile FAB (which becomes an "apps" trigger only
     * when there's another kept app to reach), and it carries the "Show
     * chat" exit so one control owns switching + leaving.
     *
     * Dumb component: parent owns the app list, the switch, and the exit.
     */
    import { fly, fade } from 'svelte/transition'

    /** @type {{
     *   apps: Array<{ branch: string, title?: string, name?: string }>,
     *   currentBranch: string,
     *   onSwitch: (branch: string) => void,
     *   onShowChat: () => void,
     *   onClose: () => void,
     * }} */
    let { apps, currentBranch, onSwitch, onShowChat, onClose } = $props()

    function pick(branch) {
        if (branch !== currentBranch) onSwitch(branch)
        else onClose()
    }

    function onKeydown(e) {
        if (e.key === 'Escape') {
            onClose()
            e.stopPropagation()
        }
    }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="sheet-backdrop" transition:fade={{ duration: 150 }} onclick={onClose}></div>

<div class="sheet" role="dialog" aria-label="Your apps" transition:fly={{ y: 300, duration: 220 }}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="grabber" onclick={onClose} title="Close"></div>
    <div class="sheet-label">Your apps</div>
    <div class="sheet-list">
        {#each apps as app (app.branch)}
            <button
                class="sheet-row"
                class:active={app.branch === currentBranch}
                onclick={() => pick(app.branch)}
            >
                <svg class="row-star" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                </svg>
                <span class="row-title">{app.name || app.title || 'Untitled app'}</span>
                {#if app.branch === currentBranch}
                    <svg class="row-check" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                {/if}
            </button>
        {/each}
        <div class="sheet-sep"></div>
        <button class="sheet-row exit-row" onclick={onShowChat}>
            <svg class="row-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
            </svg>
            <span class="row-title">Show chat</span>
        </button>
    </div>
</div>

<style>
    .sheet-backdrop {
        position: fixed;
        inset: 0;
        z-index: 110;
        background: rgba(0, 0, 0, 0.45);
    }

    .sheet {
        position: fixed;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 111;
        max-height: 70vh;
        display: flex;
        flex-direction: column;
        padding: 0.5rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
        background: var(--surface);
        border-top-left-radius: 16px;
        border-top-right-radius: 16px;
        border-top: 1px solid var(--border);
        box-shadow: 0 -6px 24px rgba(0, 0, 0, 0.4);
    }

    /* Grabber handle — the conventional "this is a sheet, swipe/tap to
       dismiss" cue. Tap closes (a lightweight stand-in for drag-to-
       dismiss; the gesture can come later). */
    .grabber {
        align-self: center;
        width: 36px;
        height: 4px;
        border-radius: 2px;
        background: var(--border);
        margin: 0.25rem 0 0.6rem;
        flex-shrink: 0;
        cursor: pointer;
    }

    .sheet-label {
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        padding: 0 0.5rem 0.4rem;
    }

    .sheet-list {
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }

    .sheet-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        width: 100%;
        text-align: left;
        padding: 0.7rem 0.6rem;
        border: none;
        border-radius: 8px;
        background: none;
        color: var(--text);
        font-size: 0.95rem;
        cursor: pointer;
    }

    .sheet-row:active {
        background: var(--surface-hover);
    }

    .sheet-row.active {
        background: color-mix(in srgb, var(--accent) 12%, transparent);
    }

    .row-star {
        color: var(--accent);
        flex-shrink: 0;
    }

    .row-icon {
        color: var(--text-muted);
        flex-shrink: 0;
    }

    .row-title {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .row-check {
        color: var(--accent);
        flex-shrink: 0;
    }

    .sheet-sep {
        height: 1px;
        background: var(--border);
        margin: 0.35rem 0.4rem;
    }

    .exit-row {
        color: var(--text-muted);
    }

    /* Belt-and-suspenders: this is a mobile surface, opened from the
       mobile-only FAB. Hide above the breakpoint in case it's ever
       mounted on a wide viewport. */
    @media (min-width: 769px) {
        .sheet,
        .sheet-backdrop {
            display: none;
        }
    }
</style>
