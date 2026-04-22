<script>
    import { startWorker, preloadPlotly } from './lib/pyodide.js'
    import ChatShell from './lib/ChatShell.svelte'

    // Start Pyodide loading immediately. The shell renders right away
    // and shows its own warming-up state so the user can start typing
    // (and reading any settings/about content) without waiting for
    // Pyodide to be live. Send is gated inside ChatShell.
    startWorker()

    // Pre-fetch Plotly.js on the parent origin. Sandboxed iframes use
    // opaque origins and don't share the HTTP cache across loads, so
    // without this each session-switch re-downloads ~3MB of Plotly
    // (a 16+ second wait on slower connections). Once prefetched,
    // buildAppHtml inlines the bytes directly.
    preloadPlotly()
</script>

<ChatShell />
