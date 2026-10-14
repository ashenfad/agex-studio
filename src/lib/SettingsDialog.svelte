<script>
    /** The model the studio talks to: OpenRouter, or an endpoint of the
     *  person's own (a direct provider, a local Meridian, a proxy). */
    import { getSettings, updateSettings } from './settings.js'

    /** @type {{ onClose: () => void }} */
    let { onClose } = $props()

    let s = $state({ ...getSettings() })

    function save() {
        updateSettings({ ...s })
        onClose()
    }
</script>

<div class="backdrop" role="presentation" onclick={onClose}>
    <div class="dialog" role="dialog" aria-label="Settings" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && onClose()}>
        <h2>Model</h2>
        <label>
            Service
            <select bind:value={s.accessMode}>
                <option value="openrouter">OpenRouter</option>
                <option value="custom">An endpoint of my own</option>
                {#if import.meta.env.DEV}<option value="scripted">Scripted (dev)</option>{/if}
            </select>
        </label>
        {#if s.accessMode === 'custom'}
            <label>
                Shape
                <select bind:value={s.wire}>
                    <option value="anthropic">Anthropic (Messages API, Meridian)</option>
                    <option value="openai">OpenAI-compatible</option>
                </select>
            </label>
            <label>
                URL
                <input bind:value={s.baseUrl} placeholder="http://localhost:3456" />
            </label>
        {/if}
        {#if s.accessMode !== 'scripted'}
            <label>
                Key
                <input type="password" bind:value={s.apiKey} placeholder={s.accessMode === 'custom' ? 'if the endpoint needs one' : 'sk-or-…'} autocomplete="off" />
            </label>
            <label>
                Model
                <input bind:value={s.model} placeholder="google/gemini-3.8-flash" />
            </label>
            <label>
                Thinking
                <select bind:value={s.thinking}>
                    <option value="off">off</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                </select>
            </label>
            <label>
                Fold the conversation past (tokens; 0 never folds)
                <input type="number" min="0" step="1000" bind:value={s.foldBudget} />
            </label>
        {/if}
        <div class="actions">
            <button class="secondary" onclick={onClose}>Cancel</button>
            <button onclick={save}>Save</button>
        </div>
    </div>
</div>

<style>
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 50%);
        display: grid;
        place-items: center;
        z-index: 10;
    }
    .dialog {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 1.2rem;
        width: min(28rem, 92vw);
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }
    h2 {
        font-family: var(--font-display);
        font-size: 1.2rem;
    }
    label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    input,
    select {
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.4rem;
        font: inherit;
    }
    .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
    }
    button {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.4rem 1rem;
        cursor: pointer;
    }
    .secondary {
        background: transparent;
        border: 1px solid var(--border);
    }
</style>
