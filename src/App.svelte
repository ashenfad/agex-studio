<script>
    import { startWorker, preloadPlotly } from './lib/pyodide.js'
    import { handleVfsClick } from './lib/vfs-download.js'
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

<!-- App-wide click delegation for [label](vfs:path) markdown links —
     non-matching clicks are no-ops, matching clicks trigger a VFS
     download.  Lives at the App level so it works wherever rendered
     markdown surfaces in the UI. -->
<svelte:window onclick={handleVfsClick} />

<ChatShell />
