<script>
    import { tick } from 'svelte'

    /** @type {{ figure: object }} */
    let { figure } = $props()

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
                xaxis: { automargin: true, ...figLayout.xaxis },
                yaxis: { automargin: true, ...figLayout.yaxis },
                autosize: true,
            }
            Plotly.newPlot(container, figure.data || [], layout, {
                responsive: true,
                displayModeBar: false,
            })
            loaded = true
        })

        return () => {
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
