<script>
    /**
     * A Plotly figure (`{data, layout}`), drawn in the studio's dark
     * look: its layout's own settings win over the transparent ground,
     * muted text and faint grid given here. Plotly loads from the CDN
     * once, on the first chart, for every chart that asks; a chart says
     * so quietly when it can't load.
     */
    import { tick } from 'svelte'
    import { loadScript, PLOTLY_URL } from './cdn.js'

    /** @type {{ figure: any }} */
    let { figure } = $props()

    const GRID = 'rgba(255, 255, 255, 0.1)'

    /** @type {HTMLDivElement | null} */
    let container = $state(null)
    let loaded = $state(false)
    /** Plotly didn't load, so there's no chart to draw. */
    let failed = $state(false)

    $effect(() => {
        if (!container || !figure) return
        const el = container
        let cancelled = false
        failed = false

        loadScript(PLOTLY_URL, 'Plotly').then(
            async (Plotly) => {
                if (cancelled) return
                await tick()
                const figLayout = figure.layout || {}
                const layout = {
                    ...figLayout,
                    paper_bgcolor: 'transparent',
                    plot_bgcolor: 'transparent',
                    font: { color: '#b0b0b0', size: 12, ...figLayout.font },
                    xaxis: { automargin: true, gridcolor: GRID, zerolinecolor: GRID, ...figLayout.xaxis },
                    yaxis: { automargin: true, gridcolor: GRID, zerolinecolor: GRID, ...figLayout.yaxis },
                    autosize: true,
                }
                Plotly.newPlot(el, figure.data || [], layout, {
                    responsive: true,
                    displayModeBar: false,
                })
                loaded = true
            },
            (e) => {
                if (cancelled) return
                console.warn("Plotly didn't load:", e)
                failed = true
            },
        )

        // `responsive` follows the window; the chart's own width changes
        // too (the split dragged, the chat unfolded, the workbench hidden)
        let width = 0
        const observer = new ResizeObserver(([entry]) => {
            const now = Math.round(entry?.contentRect.width ?? 0)
            if (now === width) return
            width = now
            const Plotly = /** @type {any} */ (window).Plotly
            if (now > 0 && loaded && Plotly) Plotly.Plots.resize(el)
        })
        observer.observe(el)

        return () => {
            observer.disconnect()
            cancelled = true
            const Plotly = /** @type {any} */ (window).Plotly
            if (Plotly) Plotly.purge(el)
        }
    })
</script>

<div class="plotly-wrapper">
    {#if failed}
        <div class="loading">This chart couldn't be drawn: Plotly didn't load.</div>
    {:else if !loaded}
        <div class="loading">Loading chart…</div>
    {/if}
    <div bind:this={container} class="plotly-container"></div>
</div>

<style>
    .plotly-wrapper {
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
        min-height: 300px;
    }

    .plotly-container {
        width: 100%;
    }

    .loading {
        padding: 2rem;
        text-align: center;
        color: var(--text-muted);
        font-size: 0.8rem;
    }
</style>
