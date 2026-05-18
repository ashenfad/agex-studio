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

    // First-appearance reset. Snaps the divider to `initialRatio` when
    // the preview pane first transitions from collapsed → visible, so
    // showcase entries (external-entry + app) start at the
    // app-favored 0.3 chat ratio rather than the studio-default 0.5.
    // Returning users who dragged to a custom ratio aren't affected
    // outside this transition; the localStorage-held value still
    // wins during normal session use.
    $effect(() => {
        if (prevCollapsed && !collapsed) {
            splitRatio = initialRatio
            localStorage.setItem('agex-preview-split', String(initialRatio))
        }
        prevCollapsed = collapsed
    })

    let overlay

    function onPointerDown(e) {
        if (collapsed) return
        e.preventDefault()
        dragging = true
        // Show overlay to capture pointer events without disabling them on panes
        if (overlay) overlay.style.display = 'block'
        const onMove = (/** @type {PointerEvent} */ me) => {
            const rect = container.getBoundingClientRect()
            const ratio = Math.max(0.001, Math.min(0.999, (me.clientX - rect.left) / rect.width))
            splitRatio = ratio
            localStorage.setItem('agex-preview-split', String(ratio))
        }
        const onUp = () => {
            dragging = false
            if (overlay) overlay.style.display = 'none'
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
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
