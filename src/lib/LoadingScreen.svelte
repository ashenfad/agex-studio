<script>
    /** @type {{ state: import('./pyodide.js').LoadingState, onRetry: () => void }} */
    let { state, onRetry } = $props()
</script>

<div class="loading-screen">
    <div class="loading-content">
        <h1>agex</h1>

        {#if state.status === 'error'}
            <p class="error">{state.message}</p>
            <button onclick={onRetry}>Retry</button>
        {:else}
            <div class="progress-bar">
                <div class="progress-fill" style="width: {state.progress * 100}%"></div>
            </div>
            <p class="status">{state.message}</p>
        {/if}
    </div>
</div>

<style>
    .loading-screen {
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .loading-content {
        text-align: center;
        max-width: 400px;
        width: 100%;
        padding: 2rem;
    }

    h1 {
        font-size: 2rem;
        font-weight: 700;
        margin-bottom: 2rem;
        color: var(--text);
    }

    .progress-bar {
        height: 4px;
        background: var(--surface);
        border-radius: 2px;
        overflow: hidden;
        margin-bottom: 1rem;
    }

    .progress-fill {
        height: 100%;
        background: var(--accent);
        border-radius: 2px;
        transition: width 0.3s ease;
    }

    .status {
        font-size: 0.85rem;
        color: var(--text-muted);
    }

    .error {
        color: var(--error);
        margin-bottom: 1rem;
        font-size: 0.9rem;
    }

    button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.5rem 1.5rem;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.9rem;
    }

    button:hover {
        background: var(--accent-hover);
    }
</style>
