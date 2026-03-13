<script>
    /** @type {{ text: string | null, title?: string, onClose: () => void }} */
    let { text, title = 'Full message', onClose } = $props()

    function handleKeydown(e) {
        if (e.key === 'Escape') onClose()
    }
</script>

{#if text !== null}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay" onclick={onClose} onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="panel" onclick={(e) => e.stopPropagation()}>
            <div class="panel-header">
                <span class="panel-title">{title}</span>
                <button class="close-btn" onclick={onClose} title="Close">×</button>
            </div>
            <div class="panel-body">{text}</div>
        </div>
    </div>
{/if}

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 200;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    .panel {
        width: 80vw;
        max-height: 80vh;
        max-width: 900px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.6rem 1rem;
        border-bottom: 1px solid var(--border);
    }

    .panel-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text);
    }

    .panel-body {
        flex: 1;
        overflow: auto;
        padding: 1rem 1.25rem;
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.9rem;
        line-height: 1.5;
    }
</style>
