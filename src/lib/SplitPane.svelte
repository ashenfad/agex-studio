<script>
    /**
     * The chat and the workbench side by side, split where the person
     * drags the divider (kept between visits). Dragging it past the left
     * edge folds the chat away, the app taking the width; a strip on the
     * left edge brings it back. `appOnly` shows the workbench alone (full
     * screen), and `single` the chat alone (the workbench hidden).
     *
     * On a narrow screen one pane shows at a time, and a round button
     * switches between them.
     */
    import { onMount } from 'svelte'

    /** @type {{
     *   single?: boolean,
     *   appOnly?: boolean,
     *   mobileView?: 'chat' | 'app',
     *   onToggleMobile?: () => void,
     *   children: import('svelte').Snippet,
     *   side: import('svelte').Snippet,
     * }} */
    let { single = false, appOnly = false, mobileView = 'chat', onToggleMobile, children, side } = $props()

    const RATIO_KEY = 'agex-split'
    const FOLDED_KEY = 'agex-chat-folded'
    /** The chat's share of the width at first. */
    const DEFAULT_RATIO = 0.42
    /** Where the strip brings a folded chat back to: a fold was for more
     *  app, so a modest share, not the sliver it was dragged down to. */
    const RESTORE_RATIO = 0.35
    /** The chat's narrowest: past this the divider can't be grabbed (its
     *  right half lies over the iframe, which takes the pointer). */
    const MIN_CHAT_PX = 30
    /** The workbench's narrowest. */
    const MIN_SIDE_PX = 120

    /** @param {string} key */
    function stored(key) {
        try {
            return localStorage.getItem(key)
        } catch {
            return null
        }
    }
    /** @param {string} key @param {string} value */
    function store(key, value) {
        try {
            localStorage.setItem(key, value)
        } catch {
            // kept for this visit only
        }
    }

    let ratio = $state(Number(stored(RATIO_KEY)) || DEFAULT_RATIO)
    let folded = $state(stored(FOLDED_KEY) === '1')
    let dragging = $state(false)
    /** @type {HTMLElement | undefined} */
    let container = $state()

    /** @param {number} candidate @param {number} width */
    function clamp(candidate, width) {
        if (width <= 0) return candidate
        return Math.max(MIN_CHAT_PX / width, Math.min(1 - MIN_SIDE_PX / width, candidate))
    }

    /** @param {boolean} next */
    function setFolded(next) {
        folded = next
        store(FOLDED_KEY, next ? '1' : '0')
    }

    function unfold() {
        ratio = RESTORE_RATIO
        store(RATIO_KEY, String(ratio))
        setFolded(false)
    }

    onMount(() => {
        // a ratio kept from a wider window, brought back within reach
        if (container) ratio = clamp(ratio, container.getBoundingClientRect().width)
    })

    /** @param {PointerEvent} e */
    function onPointerDown(e) {
        if (container === undefined) return
        e.preventDefault()
        dragging = true
        const rect = container.getBoundingClientRect()
        /** @param {PointerEvent} m */
        const onMove = (m) => {
            const x = m.clientX - rect.left
            // past the left edge folds the chat; back past its floor
            // unfolds it (apart, so one drag doesn't flicker between them)
            if (x <= 0) {
                if (!folded) setFolded(true)
                return
            }
            if (x > MIN_CHAT_PX && folded) setFolded(false)
            ratio = clamp(x / rect.width, rect.width)
        }
        const onUp = () => {
            dragging = false
            window.removeEventListener('pointermove', onMove)
            window.removeEventListener('pointerup', onUp)
            store(RATIO_KEY, String(ratio))
            // charts in the chat lay themselves out again
            window.dispatchEvent(new Event('resize'))
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
    }

    /** @param {KeyboardEvent} e */
    function onKey(e) {
        const step = e.shiftKey ? 0.1 : 0.03
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        const width = container?.getBoundingClientRect().width ?? 0
        ratio = clamp(ratio + (e.key === 'ArrowLeft' ? -step : step), width)
        store(RATIO_KEY, String(ratio))
    }

    const chatHidden = $derived(!single && (appOnly || folded))
</script>

<div
    class="split"
    class:dragging
    class:single
    class:chat-hidden={chatHidden}
    class:mobile-app={!single && mobileView === 'app'}
    bind:this={container}
>
    {#if dragging}
        <!-- over the iframe while dragging, so it doesn't take the pointer -->
        <div class="drag-cover"></div>
    {/if}
    <div class="pane chat" style:flex-basis={single ? '100%' : `${ratio * 100}%`}>
        {@render children()}
    </div>
    {#if !single}
        {#if !chatHidden}
            <!-- a focusable separator is ARIA's window splitter: the arrow keys move it -->
            <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
            <div
                class="divider"
                onpointerdown={onPointerDown}
                onkeydown={onKey}
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize the chat and the app"
                aria-valuenow={Math.round(ratio * 100)}
                aria-valuemin={0}
                aria-valuemax={100}
                tabindex="0"
                title="Drag to resize; drag past the edge to hide the chat"
            >
                <span class="grip" aria-hidden="true"></span>
            </div>
        {/if}
        <div class="pane side">
            {@render side()}
        </div>
        {#if folded && !appOnly}
            <button class="unfold" onclick={unfold} title="Show the chat" aria-label="Show the chat"></button>
        {/if}
        {#if !appOnly}
            <button
                class="fab"
                onclick={onToggleMobile}
                title={mobileView === 'chat' ? 'Show the app' : 'Show the chat'}
                aria-label={mobileView === 'chat' ? 'Show the app' : 'Show the chat'}
            >
                {#if mobileView === 'chat'}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <rect x="2" y="3" width="20" height="14" rx="2"></rect>
                        <line x1="8" y1="21" x2="16" y2="21"></line>
                        <line x1="12" y1="17" x2="12" y2="21"></line>
                    </svg>
                {:else}
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
                    </svg>
                {/if}
            </button>
        {/if}
    {/if}
</div>

<style>
    .split {
        display: flex;
        height: 100%;
        min-height: 0;
        overflow: hidden;
        position: relative;
    }
    .split.dragging {
        cursor: col-resize;
        user-select: none;
    }
    .drag-cover {
        position: absolute;
        inset: 0;
        z-index: 10;
        cursor: col-resize;
    }
    .pane {
        min-width: 0;
        min-height: 0;
        overflow: hidden;
    }
    .chat {
        flex-shrink: 0;
    }
    .side {
        flex: 1;
        display: flex;
        flex-direction: column;
    }
    .chat-hidden .chat {
        display: none;
    }
    .divider {
        width: 1px;
        flex-shrink: 0;
        background: var(--border);
        cursor: col-resize;
        position: relative;
        touch-action: none;
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2;
    }
    /* a wide hit area, for a finger as much as a pointer */
    .divider::before {
        content: '';
        position: absolute;
        inset: 0 -8px;
    }
    .divider:hover,
    .divider:focus-visible,
    .dragging .divider {
        background: var(--accent);
        outline: none;
    }
    .grip {
        position: absolute;
        width: 8px;
        height: 40px;
        border-radius: 4px;
        background: var(--surface);
        border: 1px solid var(--border);
        pointer-events: none;
    }
    .grip::after {
        content: '';
        position: absolute;
        inset: 9px 2px;
        background-image: radial-gradient(circle, var(--text-muted) 1px, transparent 1.3px);
        background-size: 3px 7px;
        background-repeat: repeat-y;
        background-position: center;
    }
    .divider:hover .grip,
    .dragging .grip {
        border-color: var(--accent);
    }
    .unfold {
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 6px;
        padding: 0;
        border: none;
        background: transparent;
        cursor: pointer;
        z-index: 10;
    }
    .unfold:hover,
    .unfold:focus-visible {
        background: color-mix(in srgb, var(--accent) 40%, transparent);
        outline: none;
    }
    .fab {
        display: none;
    }
    @media (max-width: 768px) {
        .divider,
        .unfold {
            display: none;
        }
        .split:not(.single) .chat {
            flex-basis: 100% !important;
            display: block;
        }
        .split:not(.single) .side {
            display: none;
        }
        .split.mobile-app .chat {
            display: none;
        }
        .split.mobile-app .side {
            display: flex;
        }
        .fab {
            display: flex;
            align-items: center;
            justify-content: center;
            position: fixed;
            right: 1rem;
            bottom: 5rem;
            z-index: 20;
            width: 44px;
            height: 44px;
            border-radius: 50%;
            border: 1px solid var(--border);
            background: var(--surface);
            color: var(--text);
            cursor: pointer;
            box-shadow: 0 2px 8px rgb(0 0 0 / 30%);
        }
        .mobile-app .fab {
            bottom: 1rem;
        }
    }
</style>
