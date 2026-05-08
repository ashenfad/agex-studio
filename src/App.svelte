<script>
    import { preloadPlotly } from './lib/pyodide.js'
    import { handleVfsClick } from './lib/vfs-download.js'
    import ChatShell from './lib/ChatShell.svelte'

    // Pyodide boot is now driven lazily by `kernelRegistry.ensure('py', ...)`
    // in ChatShell — fired only after settings are configured. The shell
    // renders immediately; the warming-up state shows once init begins.
    // No eager `startWorker()` here, so users on a TS-only path (when
    // the Phase 5 Ts adapter lands) don't pay the Pyodide download cost.

    // Pre-fetch Plotly.js on the parent origin. Sandboxed iframes use
    // opaque origins and don't share the HTTP cache across loads, so
    // without this each session-switch re-downloads ~3MB of Plotly
    // (a 16+ second wait on slower connections). Once prefetched,
    // buildAppHtml inlines the bytes directly.  This is shell-side
    // prefetch unrelated to kernel boot — keep eager.
    preloadPlotly()
</script>

<!-- App-wide click delegation for [label](vfs:path) markdown links —
     non-matching clicks are no-ops, matching clicks trigger a VFS
     download.  Lives at the App level so it works wherever rendered
     markdown surfaces in the UI. -->
<svelte:window onclick={handleVfsClick} />

<ChatShell />
