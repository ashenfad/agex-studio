<script>
    import { tick } from 'svelte'

    /** @type {{ figure: object }} */
    let { figure } = $props()

    const GRID = 'rgba(255, 255, 255, 0.1)'

    let container = $state(null)
    let loaded = $state(false)

    // Lazy-load Plotly.js
    async function loadPlotly() {
        if (window.Plotly) return window.Plotly
        return new Promise((resolve, reject) => {
            const script = document.createElement('script')
            script.src = 'https://cdn.plot.ly/plotly-2.35.2.min.js'
            script.onload = () => resolve(window.Plotly)
            script.onerror = () => reject(new Error('Failed to load Plotly.js'))
            document.head.appendChild(script)
        })
    }

    $effect(() => {
        if (!container || !figure) return
        let cancelled = false

        loadPlotly().then(async (Plotly) => {
            if (cancelled) return
            await tick()
            const figLayout = figure.layout || {}
            const layout = {
                ...figLayout,
                template: 'plotly_dark',
                paper_bgcolor: 'transparent',
                plot_bgcolor: 'transparent',
                font: { color: '#b0b0b0', size: 12, ...figLayout.font },
                // a template named by string isn't applied here: the dark
                // look's grid is given directly
                xaxis: { automargin: true, gridcolor: GRID, zerolinecolor: GRID, ...figLayout.xaxis },
                yaxis: { automargin: true, gridcolor: GRID, zerolinecolor: GRID, ...figLayout.yaxis },
                autosize: true,
            }
            Plotly.newPlot(container, figure.data || [], layout, {
                responsive: true,
                displayModeBar: false,
            })
            loaded = true
        })

        // `responsive` follows the window; the chart's own width changes
        // too (the split dragged, the chat unfolded, the workbench hidden)
        let width = 0
        const observer = new ResizeObserver(([entry]) => {
            const now = Math.round(entry?.contentRect.width ?? 0)
            if (now === width) return
            width = now
            if (now > 0 && loaded && window.Plotly) window.Plotly.Plots.resize(container)
        })
        observer.observe(container)

        return () => {
            observer.disconnect()
            cancelled = true
            if (container && window.Plotly) {
                window.Plotly.purge(container)
            }
        }
    })
</script>

<div class="plotly-wrapper">
    {#if !loaded}
        <div class="loading">Loading chart...</div>
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
