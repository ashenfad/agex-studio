<script>
    /** @type {{ tokens: number[] | null, current: number | null, trigger: number, chaptering: boolean, onChapter: () => void, onClose: () => void }} */
    let { tokens, current, trigger, chaptering, onChapter, onClose } = $props()

    function handleKeydown(e) {
        if (e.key === 'Escape' && !chaptering) onClose()
    }

    function formatTokens(n) {
        if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
        if (n >= 1000) return (n / 1000).toFixed(1) + 'k'
        return String(n)
    }

    // Chart geometry
    const PAD_LEFT = 48
    const PAD_RIGHT = 16
    const PAD_TOP = 16
    const PAD_BOTTOM = 28
    const W = 560
    const H = 200

    let chartPath = $derived.by(() => {
        if (!tokens || tokens.length === 0) return null

        const allValues = [...tokens, trigger]
        const maxY = Math.max(...allValues) * 1.1
        const n = tokens.length

        const xScale = (i) => PAD_LEFT + (i / Math.max(n - 1, 1)) * (W - PAD_LEFT - PAD_RIGHT)
        const yScale = (v) => PAD_TOP + (1 - v / maxY) * (H - PAD_TOP - PAD_BOTTOM)

        const line = tokens.map((v, i) => `${xScale(i)},${yScale(v)}`).join(' ')

        const triggerY = yScale(trigger)

        // Y-axis ticks (4-5 ticks)
        const yTicks = []
        const step = maxY / 4
        for (let i = 0; i <= 4; i++) {
            const val = step * i
            yTicks.push({ y: yScale(val), label: formatTokens(Math.round(val)) })
        }

        return { line, triggerY, yTicks, n }
    })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="modal-overlay" onclick={() => !chaptering && onClose()} onkeydown={handleKeydown}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="modal" onclick={(e) => e.stopPropagation()}>
        <div class="modal-header">
            <span class="modal-title">Context Usage</span>
            {#if !chaptering}
                <button class="close-btn" onclick={onClose}>&times;</button>
            {/if}
        </div>
        <div class="modal-body">
            <div class="stats">
                {#if current != null}
                    <span class="stat">
                        <span class="stat-label">Current</span>
                        <span class="stat-value">{formatTokens(current)}</span>
                    </span>
                {/if}
                <span class="stat">
                    <span class="stat-label">Trigger</span>
                    <span class="stat-value">{formatTokens(trigger)}</span>
                </span>
                {#if current != null}
                    <span class="stat">
                        <span class="stat-label">Usage</span>
                        <span class="stat-value" class:over={current > trigger}>{Math.round(current / trigger * 100)}%</span>
                    </span>
                {/if}
            </div>

            {#if chartPath}
                <svg viewBox="0 0 {W} {H}" class="chart">
                    <!-- Y-axis ticks -->
                    {#each chartPath.yTicks as tick}
                        <line x1={PAD_LEFT} y1={tick.y} x2={W - PAD_RIGHT} y2={tick.y} class="grid-line" />
                        <text x={PAD_LEFT - 6} y={tick.y + 3} class="tick-label" text-anchor="end">{tick.label}</text>
                    {/each}

                    <!-- Trigger threshold -->
                    <line x1={PAD_LEFT} y1={chartPath.triggerY} x2={W - PAD_RIGHT} y2={chartPath.triggerY} class="trigger-line" />

                    <!-- Token line -->
                    <polyline points={chartPath.line} fill="none" class="token-line" />

                    <!-- X-axis label -->
                    <text x={(PAD_LEFT + W - PAD_RIGHT) / 2} y={H - 2} class="axis-label" text-anchor="middle">actions</text>
                </svg>
            {:else}
                <div class="empty-chart">No action data yet</div>
            {/if}

            <button class="chapter-btn" onclick={onChapter} disabled={chaptering}>
                {#if chaptering}
                    <span class="spinner"></span>
                    Compressing...
                {:else}
                    Compress Context
                {/if}
            </button>
        </div>
    </div>
</div>

<style>
    .modal {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        width: 440px;
        max-width: 90vw;
        display: flex;
        flex-direction: column;
    }

    .modal-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.6rem 1rem;
        border-bottom: 1px solid var(--border);
    }

    .modal-title {
        font-size: 0.85rem;
        font-weight: 600;
    }

    .close-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 1.2rem;
        cursor: pointer;
        padding: 0 0.2rem;
        line-height: 1;
    }

    .close-btn:hover {
        color: var(--text);
    }

    .modal-body {
        padding: 1rem 1.25rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .stats {
        display: flex;
        gap: 1.5rem;
    }

    .stat {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
    }

    .stat-label {
        font-size: 0.65rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .stat-value {
        font-size: 1rem;
        font-weight: 600;
    }

    .stat-value.over {
        color: var(--accent);
    }

    .chart {
        width: 100%;
        height: auto;
    }

    .grid-line {
        stroke: var(--border);
        stroke-width: 0.5;
    }

    .trigger-line {
        stroke: var(--accent);
        stroke-width: 1;
        stroke-dasharray: 4 3;
        opacity: 0.7;
    }

    .token-line {
        stroke: var(--text);
        stroke-width: 1.5;
        stroke-linejoin: round;
    }

    .tick-label {
        fill: var(--text-muted);
        font-size: 9px;
    }

    .axis-label {
        fill: var(--text-muted);
        font-size: 9px;
    }

    .empty-chart {
        height: 120px;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        font-size: 0.8rem;
    }

    .chapter-btn {
        align-self: flex-start;
        padding: 0.45rem 1rem;
        border: none;
        border-radius: 6px;
        background: var(--accent);
        color: white;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
    }

    .chapter-btn:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    .chapter-btn:disabled {
        opacity: 0.8;
        cursor: not-allowed;
    }

    .spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid rgba(255, 255, 255, 0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
        vertical-align: middle;
    }

</style>
