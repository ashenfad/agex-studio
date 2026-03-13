<script>
    /** @type {{ collapsed?: boolean, children: any, preview: any }} */
    let { collapsed = false, children, preview } = $props()

    let splitRatio = $state(parseFloat(localStorage.getItem('agex-preview-split') || '0.5'))
    let dragging = $state(false)
    let container
    let wasCollapsed = collapsed

    // Reset to center when the preview first appears
    $effect(() => {
        if (wasCollapsed && !collapsed) {
            splitRatio = 0.5
            localStorage.setItem('agex-preview-split', '0.5')
        }
        wasCollapsed = collapsed
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
</style>
