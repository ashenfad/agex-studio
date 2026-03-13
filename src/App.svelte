<script>
    import { pyodideStore, startWorker } from './lib/pyodide.js'
    import LoadingScreen from './lib/LoadingScreen.svelte'
    import ChatShell from './lib/ChatShell.svelte'

    // Start the worker immediately
    startWorker()
</script>

{#if $pyodideStore.status === 'ready'}
    <ChatShell />
{:else}
    <LoadingScreen state={$pyodideStore} onRetry={startWorker} />
{/if}
