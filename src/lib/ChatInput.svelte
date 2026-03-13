<script>
    /** @type {{ onSend: (text: string) => void, onCancel?: () => void, busy?: boolean, disabled: boolean, prefill?: string }} */
    let { onSend, onCancel, busy = false, disabled, prefill = '' } = $props()

    let text = $state('')

    $effect(() => {
        if (prefill) {
            text = prefill
            tick().then(() => textarea?.focus())
        }
    })
    let textarea

    function send() {
        if (!text.trim() || disabled) return
        onSend(text.trim())
        text = ''
        // Refocus after send
        tick().then(() => textarea?.focus())
    }

    function handleKeydown(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            send()
        }
    }

    import { tick } from 'svelte'
</script>

<div class="input-bar">
    <textarea
        bind:this={textarea}
        bind:value={text}
        onkeydown={handleKeydown}
        placeholder="Ask the agent..."
        rows="1"
        {disabled}
    ></textarea>
    {#if busy}
        <button class="stop" onclick={onCancel}>
            Stop
        </button>
    {:else}
        <button onclick={send} disabled={disabled || !text.trim()}>
            Send
        </button>
    {/if}
</div>

<style>
    .input-bar {
        display: flex;
        gap: 0.5rem;
        padding: 0.75rem 1rem;
        border-top: 1px solid var(--border);
        flex-shrink: 0;
    }

    textarea {
        flex: 1;
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        font-family: inherit;
        font-size: 0.9rem;
        resize: none;
        outline: none;
    }

    textarea:focus {
        border-color: var(--accent);
    }

    textarea::placeholder {
        color: var(--text-muted);
    }

    button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.5rem 1.25rem;
        cursor: pointer;
        font-weight: 600;
        font-size: 0.9rem;
        flex-shrink: 0;
    }

    button:hover:not(:disabled) {
        background: var(--accent-hover);
    }

    button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    button.stop {
        background: #e74c3c;
    }

    button.stop:hover {
        background: #c0392b;
    }
</style>
