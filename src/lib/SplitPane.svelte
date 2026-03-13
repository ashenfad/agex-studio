<script>
    /** @type {{ collapsed?: boolean, mobileView?: 'chat' | 'app', onToggleMobileView?: () => void, children: any, preview: any }} */
    let { collapsed = false, mobileView = 'chat', onToggleMobileView, children, preview } = $props()

    let splitRatio = $state(parseFloat(localStorage.getItem('agex-preview-split') || '0.5'))
    let dragging = $state(false)
    let container
    let prevCollapsed = $state(true)

    // Reset to center when the preview first appears
    $effect(() => {
        if (prevCollapsed && !collapsed) {
            splitRatio = 0.5
            localStorage.setItem('agex-preview-split', '0.5')
        }
        prevCollapsed = collapsed
    })

    function onPointerDown(e) {
        if (collapsed) return
        e.preventDefault()
        dragging = true
        const onMove = (/** @type {PointerEvent} */ me) => {
            const rect = container.getBoundingClientRect()
            const ratio = Math.max(0.001, Math.min(0.999, (me.clientX - rect.left) / rect.width))
            splitRatio = ratio
            localStorage.setItem('agex-preview-split', String(ratio))
        }
        const onUp = () => {
            dragging = false
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
    bind:this={container}
>
    <div class="pane left" style:flex-basis="{collapsed ? '100%' : (splitRatio * 100) + '%'}">
        {@render children()}
    </div>
    {#if !collapsed}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="divider" onpointerdown={onPointerDown}></div>
        <div class="pane right">
            {@render preview()}
        </div>
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
</div>

<style>
    .split-pane {
        display: flex;
        height: 100%;
        overflow: hidden;
    }

    .split-pane.dragging {
        cursor: col-resize;
        user-select: none;
    }

    .split-pane.dragging .pane {
        pointer-events: none;
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
    }

    /* Wide invisible hit area */
    .divider::before {
        content: '';
        position: absolute;
        top: 0;
        bottom: 0;
        left: -8px;
        right: -8px;
    }

    .divider:hover,
    .split-pane.dragging .divider {
        background: var(--accent);
    }

    .mobile-fab {
        display: none;
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
