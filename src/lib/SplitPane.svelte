<script>
    /** @type {{
     *   collapsed?: boolean,
     *   mobileView?: 'chat' | 'app',
     *   viewMode?: 'split' | 'app-only',
     *   initialRatio?: number,
     *   onToggleMobileView?: () => void,
     *   onExitAppOnly?: () => void,
     *   children: any,
     *   preview: any,
     * }} */
    let {
        collapsed = false,
        mobileView = 'chat',
        viewMode = 'split',
        initialRatio = 0.5,
        onToggleMobileView,
        onExitAppOnly,
        children,
        preview,
    } = $props()

    let splitRatio = $state(parseFloat(localStorage.getItem('agex-preview-split') || String(initialRatio)))
    let dragging = $state(false)
    let container
    let prevCollapsed = $state(true)

    // Chat pane "collapsed-by-user" state. Distinct from the
    // top-level `collapsed` prop (which means "no app yet, so no
    // split"). Tripped by dragging the divider hard past the floor;
    // exited by clicking the expand strip on the left edge of the
    // app pane. `splitRatio` is preserved across collapse, but
    // `expandChat` (the strip click) deliberately snaps it to
    // RESTORE_RATIO rather than restoring — at the moment of
    // collapse splitRatio is at the floor, so a literal restore
    // would produce a barely-visible sliver.
    let chatCollapsed = $state(localStorage.getItem('agex-chat-collapsed') === '1')

    // First-appearance reset. Snaps the divider to `initialRatio` when
    // the preview pane first transitions from collapsed → visible, so
    // showcase entries (external-entry + app) start at the
    // app-favored 0.3 chat ratio rather than the studio-default 0.5.
    // Returning users who dragged to a custom ratio aren't affected
    // outside this transition; the localStorage-held value still
    // wins during normal session use.
    //
    // Also clears `chatCollapsed` on first appearance — a session
    // that just gained app files shouldn't open with chat hidden.
    $effect(() => {
        if (prevCollapsed && !collapsed) {
            splitRatio = initialRatio
            localStorage.setItem('agex-preview-split', String(initialRatio))
            if (chatCollapsed) {
                chatCollapsed = false
                localStorage.setItem('agex-chat-collapsed', '0')
            }
        }
        prevCollapsed = collapsed
    })

    let overlay

    // Floor the chat pane at this many pixels of width. Below this,
    // the divider's 44px hit zone is unreachable: the left half
    // falls off-screen (pane is too narrow to hold it) and the right
    // half lives inside the iframe, which intercepts pointer events
    // outside an active drag. True zero-chat users have app-only
    // mode (brand pill) — split-mode needs the divider operable.
    const MIN_LEFT_PX = 30

    /** Clamp a candidate ratio to keep the chat pane >= MIN_LEFT_PX
     *  wide given the container's current width. */
    function clampRatio(candidate, containerWidth) {
        const minRatio = containerWidth > 0 ? MIN_LEFT_PX / containerWidth : 0.001
        return Math.max(minRatio, Math.min(0.999, candidate))
    }

    // Heal stored ratios from before the floor existed: if the
    // user had dragged the divider into the un-grabbable zone in
    // a previous session, normalize it back up the first time we
    // can measure the container.
    $effect(() => {
        if (!container || collapsed) return
        const w = container.getBoundingClientRect().width
        if (w <= 0) return
        const clamped = clampRatio(splitRatio, w)
        if (clamped !== splitRatio) {
            splitRatio = clamped
            localStorage.setItem('agex-preview-split', String(clamped))
        }
    })

    function setChatCollapsed(next) {
        if (chatCollapsed === next) return
        chatCollapsed = next
        localStorage.setItem('agex-chat-collapsed', next ? '1' : '0')
    }

    // Where the expand-strip click restores the divider to. The
    // user collapsed because they wanted more app, so don't go
    // back to (possibly chat-heavy) splitRatio — bring chat back
    // as a sane peek that respects their app-focus intent.
    // Also: at the moment of collapse, splitRatio is sitting at
    // the MIN_LEFT_PX floor (drag clamped it before overshoot
    // triggered collapse), so restoring to it would land at a
    // barely-visible sliver anyway.
    const RESTORE_RATIO = 0.35

    function expandChat() {
        splitRatio = RESTORE_RATIO
        localStorage.setItem('agex-preview-split', String(RESTORE_RATIO))
        setChatCollapsed(false)
    }

    function onPointerDown(e) {
        if (collapsed) return
        e.preventDefault()
        dragging = true
        // Show overlay to capture pointer events without disabling them on panes
        if (overlay) overlay.style.display = 'block'
        const onMove = (/** @type {PointerEvent} */ me) => {
            const rect = container.getBoundingClientRect()
            const rawX = me.clientX - rect.left
            // Drag past the container's left edge → snap to chat-
            // collapsed. The divider can't go below the MIN_LEFT_PX
            // floor, so we use "mouse past the very left of the
            // viewport" as the gesture for "I want this gone."
            if (rawX <= 0) {
                setChatCollapsed(true)
                return
            }
            // Pulled back past the floor → un-collapse. Hysteresis:
            // collapse triggers at rawX <= 0 but un-collapse needs
            // rawX > MIN_LEFT_PX, so a single drag past the edge
            // doesn't ping-pong.
            if (rawX > MIN_LEFT_PX) {
                setChatCollapsed(false)
            }
            splitRatio = clampRatio(rawX / rect.width, rect.width)
            // splitRatio persists in `onUp` rather than here — no
            // need to thrash localStorage 60×/sec during a drag.
        }
        const onUp = () => {
            dragging = false
            if (overlay) overlay.style.display = 'none'
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            // Persist the final ratio once at release. Skipped when
            // the drag ended in the collapsed state (chatCollapsed
            // is its own persisted flag via setChatCollapsed).
            localStorage.setItem('agex-preview-split', String(splitRatio))
            // Trigger resize so Plotly charts in the chat pane relayout
            window.dispatchEvent(new Event('resize'))
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
    }
</script>

<div
    class="split-pane"
    class:dragging
    class:mobile-app={!collapsed && mobileView === 'app'}
    class:mobile-chat={!collapsed && mobileView === 'chat'}
    class:view-app-only={!collapsed && viewMode === 'app-only'}
    class:chat-collapsed={!collapsed && chatCollapsed && viewMode !== 'app-only'}
    bind:this={container}
>
    <!-- Transparent overlay during drag — prevents iframe from eating pointer events
         without setting pointer-events:none on panes (which breaks trackpad scroll) -->
    <div class="drag-overlay" bind:this={overlay}></div>
    <div class="pane left" style:flex-basis="{collapsed ? '100%' : (splitRatio * 100) + '%'}">
        {@render children()}
    </div>
    {#if !collapsed}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="divider" onpointerdown={onPointerDown}></div>
        <div class="pane right">
            {@render preview()}
        </div>
        {#if chatCollapsed && viewMode !== 'app-only'}
            <!-- Re-entry handle for the drag-collapsed chat pane. A
                 6px clickable strip on the left edge of the app
                 pane; click restores the previous splitRatio. Sits
                 above the iframe (z-index: 10) so the iframe's
                 pointer-capture doesn't shadow it. -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
                class="expand-strip"
                onclick={expandChat}
                onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && expandChat()}
                role="button"
                tabindex="0"
                title="Show chat"
                aria-label="Show chat"
            ></div>
        {/if}
        {#if viewMode === 'app-only'}
            <!-- Branded pill: the only chrome in play mode. Combines
                 attribution ("this was built with agex.studio") with
                 the escape hatch ("view how"). Same bottom-right
                 anchor as the mobile FAB so the spatial pattern is
                 consistent across modes. -->
            <button
                class="brand-pill"
                onclick={onExitAppOnly}
                title="See how this app was built"
            >
                <span class="brand">agex.studio</span>
                <span class="sep">·</span>
                <span class="action">View build</span>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <polyline points="9 18 15 12 9 6"></polyline>
                </svg>
            </button>
        {:else}
            <button class="mobile-fab" onclick={onToggleMobileView} title={mobileView === 'chat' ? 'Show App' : 'Show Chat'}>
                {#if mobileView === 'chat'}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                        <line x1="8" y1="21" x2="16" y2="21"></line>
                        <line x1="12" y1="17" x2="12" y2="21"></line>
                    </svg>
                {:else}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                {/if}
            </button>
        {/if}
    {/if}
</div>

<style>
    .split-pane {
        display: flex;
        height: 100%;
        overflow: hidden;
        position: relative;
    }

    .split-pane.dragging {
        cursor: col-resize;
        user-select: none;
    }

    .drag-overlay {
        display: none;
        position: absolute;
        inset: 0;
        z-index: 10;
        cursor: col-resize;
    }

    .pane {
        overflow: hidden;
        min-width: 0;
    }

    .pane.left {
        flex-shrink: 0;
    }

    .pane.right {
        flex: 1;
        display: flex;
        flex-direction: column;
    }

    .divider {
        width: 1px;
        flex-shrink: 0;
        background: var(--border);
        cursor: col-resize;
        transition: background 0.15s;
        position: relative;
        touch-action: none;
    }

    /* Wide invisible hit area (44px for touch-friendly target) */
    .divider::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: -22px;
        right: -22px;
    }

    .divider:hover,
    .split-pane.dragging .divider {
        background: var(--accent);
    }

    .mobile-fab {
        display: none;
    }

    /* App-only view (play mode): hide chat pane and divider on
       ALL viewport sizes, not just mobile. The app pane gets full
       width / full height with no studio chrome other than the
       brand pill anchored bottom-right. */
    .split-pane.view-app-only .pane.left {
        display: none;
    }
    .split-pane.view-app-only .pane.right {
        flex-basis: 100%;
    }
    .split-pane.view-app-only .divider {
        display: none;
    }

    /* Chat-collapsed view (drag-past-edge): same visual outcome as
       app-only — chat hidden, app full-width — but distinct origin
       and exit. Reached by deliberately dragging the divider off
       the left edge; exit via the .expand-strip on the left edge. */
    .split-pane.chat-collapsed .pane.left {
        display: none;
    }
    .split-pane.chat-collapsed .pane.right {
        flex-basis: 100%;
    }
    .split-pane.chat-collapsed .divider {
        display: none;
    }

    .expand-strip {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 6px;
        background: transparent;
        cursor: pointer;
        z-index: 10;
        border-right: 1px solid transparent;
        transition: background 0.15s, border-color 0.15s;
    }
    .expand-strip:hover,
    .expand-strip:focus-visible {
        background: color-mix(in srgb, var(--accent) 35%, transparent);
        border-right-color: var(--accent);
        outline: none;
    }

    /* Branded pill — the sole chrome in app-only mode. Same
       bottom-right anchor as the mobile FAB so users who learn one
       pattern transfer to the other. Wider than the FAB to make
       room for the brand + action label; chevron echoes the
       "step into something" affordance. */
    .brand-pill {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        position: fixed;
        bottom: 1rem;
        right: 1rem;
        z-index: 100;
        padding: 0.45rem 0.75rem 0.45rem 0.9rem;
        border-radius: 999px;
        border: 1px solid var(--border);
        background: var(--surface);
        color: var(--text-muted);
        font-size: 0.78rem;
        cursor: pointer;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.35);
        transition: color 0.15s, background 0.15s, transform 0.15s;
    }

    .brand-pill:hover {
        color: var(--text);
        background: var(--surface-hover);
        transform: translateY(-1px);
    }

    .brand-pill .brand {
        font-weight: 600;
        color: var(--text);
    }

    .brand-pill .sep {
        opacity: 0.4;
    }

    .brand-pill .action {
        color: inherit;
    }

    /* Mobile: show one pane at a time */
    @media (max-width: 768px) {
        .split-pane .divider {
            display: none;
        }

        .split-pane.mobile-chat .pane.left {
            flex-basis: 100% !important;
        }
        .split-pane.mobile-chat .pane.right {
            display: none;
        }

        .split-pane.mobile-app .pane.left {
            display: none;
        }
        .split-pane.mobile-app .pane.right {
            flex-basis: 100%;
        }

        .mobile-fab {
            display: flex;
            align-items: center;
            justify-content: center;
            position: fixed;
            bottom: 4.5rem;
            right: 1rem;
            z-index: 100;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            border: 1px solid var(--border);
            background: var(--surface);
            color: var(--text-muted);
            cursor: pointer;
            box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        }

        .split-pane.mobile-app .mobile-fab {
            bottom: 1rem;
        }

        .mobile-fab:hover {
            color: var(--text);
            background: var(--surface-hover);
        }
    }
</style>
