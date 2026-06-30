<script>
    /**
     * Full-screen launcher — the single piece of chrome in local
     * full-screen (app-only) mode. Owns BOTH switching between kept apps
     * AND exiting full-screen, so the app fills the viewport with nothing
     * persistently overlaid.
     *
     * Visibility model (all because the full-screen app is a cross-origin
     * iframe — the parent window never receives pointer events over it):
     *  - On entry it *flickers*: flies in briefly, then hides. A one-time
     *    "I'm here" so the affordance is discoverable without permanently
     *    occluding the app.
     *  - After that it's hidden, and reveals when the cursor approaches
     *    the left edge. We can't watch the cursor over the iframe, so a
     *    thin parent-owned edge hit-zone catches the approach (it eats
     *    the leftmost ~16px of clicks in full-screen — the cost of
     *    peeking cursor position past a cross-origin frame).
     *  - Click the nub to expand the menu; pick an app to switch, or
     *    "Exit full screen" to drop back to the studio. Backdrop / Escape
     *    closes the menu.
     *
     * Dumb component: parent owns the app list, the switch, and the exit.
     */
    import { fly } from 'svelte/transition'
    import { onMount } from 'svelte'

    /** @type {{
     *   apps: Array<{ branch: string, title?: string, name?: string }>,
     *   currentBranch: string,
     *   onSwitch: (branch: string) => void,
     *   onExit: () => void,
     * }} */
    let { apps, currentBranch, onSwitch, onExit } = $props()

    let expanded = $state(false)
    let hovering = $state(false)
    // One-shot reveal on mount so the rail advertises itself, then hides.
    let flicker = $state(true)

    let visible = $derived(hovering || expanded || flicker)

    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let hideTimer
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let flickerTimer

    onMount(() => {
        // Hold the flicker long enough to register, then let it hide
        // (unless the cursor already grabbed the edge / opened the menu).
        flickerTimer = setTimeout(() => (flicker = false), 1300)
        return () => {
            clearTimeout(flickerTimer)
            clearTimeout(hideTimer)
        }
    })

    function reveal() {
        clearTimeout(hideTimer)
        hovering = true
    }

    // Small debounce so the gap between the edge hit-zone and the rail
    // (or a wandering cursor) doesn't make it flicker shut mid-reach.
    function scheduleHide() {
        clearTimeout(hideTimer)
        hideTimer = setTimeout(() => (hovering = false), 200)
    }

    function pick(branch) {
        expanded = false
        if (branch !== currentBranch) onSwitch(branch)
    }

    function exit() {
        expanded = false
        onExit()
    }

    function onKeydown(e) {
        if (e.key === 'Escape' && expanded) {
            expanded = false
            e.stopPropagation()
        }
    }
</script>

<svelte:window onkeydown={onKeydown} />

<!-- Always-present edge hit-zone: the only way to detect a cursor
     approaching the left edge when the viewport is a cross-origin app. -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="edge-trigger"
    onmouseenter={reveal}
    onmouseleave={scheduleHide}
></div>

{#if expanded}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="launcher-backdrop" onclick={() => (expanded = false)}></div>
{/if}

{#if visible}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="launcher"
        transition:fly={{ x: -30, duration: 180 }}
        onmouseenter={reveal}
        onmouseleave={scheduleHide}
    >
        <button
            class="nub"
            onclick={() => (expanded = !expanded)}
            title={expanded ? 'Close menu' : 'Apps & full screen'}
            aria-label={expanded ? 'Close menu' : 'Apps and full screen'}
            aria-expanded={expanded}
        >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7"></rect>
                <rect x="14" y="3" width="7" height="7"></rect>
                <rect x="14" y="14" width="7" height="7"></rect>
                <rect x="3" y="14" width="7" height="7"></rect>
            </svg>
        </button>

        {#if expanded}
            <div class="panel" role="menu" aria-label="Your apps">
                {#if apps.length > 0}
                    <div class="panel-label">Apps</div>
                    {#each apps as app (app.branch)}
                        <button
                            class="app-row"
                            class:active={app.branch === currentBranch}
                            role="menuitem"
                            onclick={() => pick(app.branch)}
                        >
                            <svg class="row-star" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                            </svg>
                            <span class="row-title">{app.name || app.title || 'Untitled app'}</span>
                        </button>
                    {/each}
                    <div class="panel-sep"></div>
                {/if}
                <button class="app-row exit-row" role="menuitem" onclick={exit}>
                    <svg class="row-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M4 14h6v6"></path>
                        <path d="M20 10h-6V4"></path>
                        <path d="M14 10l7-7"></path>
                        <path d="M3 21l7-7"></path>
                    </svg>
                    <span class="row-title">Exit full screen</span>
                </button>
            </div>
        {/if}
    </div>
{/if}

<style>
    .edge-trigger {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 16px;
        z-index: 100;
        /* Transparent — purely a cursor-approach sensor over the app. */
    }

    .launcher-backdrop {
        position: fixed;
        inset: 0;
        z-index: 99;
        /* Transparent click-catcher; no dimming so the app stays visible. */
    }

    .launcher {
        position: fixed;
        top: 1rem;
        left: 0;
        z-index: 101;
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
    }

    /* Pull-tab flush to the edge: flat left, rounded right. */
    .nub {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 44px;
        padding: 0;
        border: 1px solid var(--border);
        border-left: none;
        border-radius: 0 8px 8px 0;
        background: var(--surface);
        color: var(--text-muted);
        cursor: pointer;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        transition: color 0.15s, background 0.15s;
    }

    .nub:hover {
        color: var(--text);
        background: var(--surface-hover);
    }

    .panel {
        min-width: 220px;
        max-width: 300px;
        max-height: calc(100vh - 2rem);
        overflow-y: auto;
        padding: 0.35rem;
        border: 1px solid var(--border);
        border-radius: 10px;
        background: var(--surface);
        box-shadow: 0 6px 24px rgba(0, 0, 0, 0.4);
    }

    .panel-label {
        font-size: 0.62rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        padding: 0.25rem 0.5rem 0.3rem;
    }

    .panel-sep {
        height: 1px;
        background: var(--border);
        margin: 0.35rem 0.25rem;
    }

    .app-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        text-align: left;
        padding: 0.5rem;
        border: none;
        border-radius: 6px;
        background: none;
        color: var(--text);
        font-size: 0.85rem;
        cursor: pointer;
    }

    .app-row:hover {
        background: var(--surface-hover);
    }

    /* Current app: accent rail + tint, matching the session drawer's
       active-row treatment so "where am I" is consistent. */
    .app-row.active {
        background: color-mix(in srgb, var(--accent) 12%, transparent);
        box-shadow: inset 2px 0 0 var(--accent);
    }

    .row-star {
        color: var(--accent);
        flex-shrink: 0;
    }

    .row-icon {
        color: var(--text-muted);
        flex-shrink: 0;
    }

    .exit-row {
        color: var(--text-muted);
    }

    .exit-row:hover {
        color: var(--text);
    }

    .row-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Desktop affordance only; mobile switching is a later phase. */
    @media (max-width: 768px) {
        .launcher,
        .launcher-backdrop,
        .edge-trigger {
            display: none;
        }
    }
</style>
