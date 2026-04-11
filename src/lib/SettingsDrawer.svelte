<script>
    import { settingsStore, updateSettings } from './settings.js'
    import { googleAuthStore, isGoogleAvailable, connect, disconnect } from './google-auth.js'

    const MODELS = [
        { id: "openai/gpt-5.4", label: "GPT-5.4" },
        { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano" },
        { id: "anthropic/claude-opus-4.6", label: "Claude Opus 4.6" },
        { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
        { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
        { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
        { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
        { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
        { id: "qwen/qwen3-coder-next", label: "Qwen3 Coder Next" },
    ]

    /** @type {{ open: boolean, onClose: () => void }} */
    let { open, onClose } = $props()

    let apiKey = $state('')
    let model = $state('')
    let customModel = $state(false)
    let provider = $state('openai')
    let baseUrl = $state('')
    let chapteringTrigger = $state(80000)
    let googleConnecting = $state(false)

    // Sync local state from store whenever drawer opens
    $effect(() => {
        if (open) {
            const s = $settingsStore
            apiKey = s.apiKey
            model = s.model
            customModel = !MODELS.some(m => m.id === s.model)
            provider = s.provider ?? 'openai'
            baseUrl = s.baseUrl ?? ''
            chapteringTrigger = s.chapteringTrigger
        }
    })

    function handleSave() {
        updateSettings({
            apiKey: apiKey.trim(),
            model: model.trim(),
            provider,
            baseUrl: baseUrl.trim(),
            chapteringTrigger: parseInt(chapteringTrigger, 10) || 150000,
        })
        onClose()
    }

    async function handleGoogleConnect() {
        googleConnecting = true
        try {
            await connect()
        } catch (e) {
            console.error('Google auth failed:', e)
        } finally {
            googleConnecting = false
        }
    }

    function handleGoogleDisconnect() {
        disconnect()
    }

    let modalPage = $state(null) // { title, html }

    async function openPage(url, title) {
        try {
            const resp = await fetch(url)
            const text = await resp.text()
            // Extract body content from the static HTML page
            const match = text.match(/<body[^>]*>([\s\S]*)<\/body>/i)
            const html = match ? match[1] : text
            modalPage = { title, html }
        } catch {
            // Fallback: open in new tab if fetch fails
            window.open(url, '_blank')
        }
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}></div>
    <div class="drawer">
        <h2>Settings</h2>

        <form onsubmit={(e) => { e.preventDefault(); handleSave() }}>
            <label>
                <span>OpenRouter API Key</span>
                <input
                    type="password"
                    bind:value={apiKey}
                    placeholder="sk-or-..."
                    autocomplete="off"
                />
            </label>

            <label>
                <span>Model</span>
                {#if customModel}
                    <input
                        type="text"
                        bind:value={model}
                        placeholder="provider/model-name"
                    />
                    <button type="button" class="toggle-link" onclick={() => { customModel = false; model = MODELS[0].id }}>
                        Choose from list
                    </button>
                {:else}
                    <select bind:value={model}>
                        {#each MODELS as m}
                            <option value={m.id}>{m.label}</option>
                        {/each}
                    </select>
                    <button type="button" class="toggle-link" onclick={() => { customModel = true; model = '' }}>
                        Enter custom model
                    </button>
                {/if}
            </label>

            <label>
                <span>API format</span>
                <div class="segmented">
                    <button
                        type="button"
                        class:active={provider === 'openai'}
                        onclick={() => provider = 'openai'}
                    >OpenAI</button>
                    <button
                        type="button"
                        class:active={provider === 'anthropic'}
                        onclick={() => provider = 'anthropic'}
                    >Anthropic</button>
                </div>
            </label>

            <label>
                <span>Custom base URL (optional)</span>
                <input
                    type="text"
                    bind:value={baseUrl}
                    placeholder={provider === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://openrouter.ai/api/v1'}
                    autocomplete="off"
                />
            </label>

            <div class="divider"></div>

            <div class="section-label">Chaptering</div>

            <label>
                <span>Chaptering trigger (tokens)</span>
                <input
                    type="number"
                    bind:value={chapteringTrigger}
                    min="1000"
                    step="1000"
                />
            </label>

            {#if isGoogleAvailable()}
                <div class="divider"></div>

                <div class="section-label">Integrations</div>

                <div class="google-status">
                    {#if $googleAuthStore.connected}
                        <div class="connected">
                            <span class="dot"></span>
                            <span class="email">Connected</span>
                            <button type="button" class="disconnect-link" onclick={handleGoogleDisconnect}>
                                Disconnect
                            </button>
                        </div>
                    {:else}
                        <button
                            type="button"
                            class="google-connect"
                            onclick={handleGoogleConnect}
                            disabled={googleConnecting}
                        >
                            {googleConnecting ? 'Connecting...' : 'Connect Google'}
                        </button>
                    {/if}
                </div>
            {/if}

            <div class="actions">
                <button class="save" type="submit">Save</button>
                <button class="cancel" type="button" onclick={onClose}>Cancel</button>
            </div>

            <div class="footer-links">
                <button type="button" class="page-link" onclick={() => openPage('/about.html', 'About')}>About</button>
                <span class="sep">&middot;</span>
                <button type="button" class="page-link" onclick={() => openPage('/privacy.html', 'Privacy')}>Privacy</button>
                <span class="sep">&middot;</span>
                <button type="button" class="page-link" onclick={() => openPage('/terms.html', 'Terms')}>Terms</button>
                <span class="sep">&middot;</span>
                <a href="https://github.com/ashenfad/agex-studio" target="_blank" rel="noopener">GitHub</a>
            </div>
            <div class="version">v{__APP_VERSION__}</div>
        </form>
    </div>

    {#if modalPage}
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="page-overlay" onclick={() => modalPage = null} onkeydown={(e) => e.key === 'Escape' && (modalPage = null)}></div>
        <div class="page-modal">
            <div class="page-modal-header">
                <button class="page-modal-close" onclick={() => modalPage = null}>&times;</button>
            </div>
            <div class="page-modal-body">
                {@html modalPage.html}
            </div>
        </div>
    {/if}
{/if}

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 100;
    }

    .drawer {
        position: fixed;
        top: 0;
        right: 0;
        bottom: 0;
        width: 360px;
        max-width: 90vw;
        background: var(--surface);
        border-left: 1px solid var(--border);
        padding: 1.5rem;
        z-index: 101;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
    }

    h2 {
        font-size: 1.1rem;
        font-weight: 600;
        margin-bottom: 0.5rem;
    }

    form {
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
        flex: 1;
    }

    label {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    label span {
        font-size: 0.8rem;
        color: var(--text-muted);
        font-weight: 500;
    }

    input, select {
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.5rem 0.75rem;
        font-family: inherit;
        font-size: 0.85rem;
        outline: none;
    }

    select {
        cursor: pointer;
    }

    input:focus, select:focus {
        border-color: var(--accent);
    }

    input::placeholder {
        color: var(--text-muted);
    }

    .segmented {
        display: flex;
        gap: 0;
        border: 1px solid var(--border);
        border-radius: 6px;
        overflow: hidden;
    }

    .segmented button {
        flex: 1;
        background: var(--input-bg);
        color: var(--text-muted);
        border: none;
        padding: 0.5rem 0.75rem;
        font-family: inherit;
        font-size: 0.85rem;
        cursor: pointer;
    }

    .segmented button + button {
        border-left: 1px solid var(--border);
    }

    .segmented button:hover:not(.active) {
        color: var(--text);
    }

    .segmented button.active {
        background: var(--accent);
        color: white;
    }

    .toggle-link {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.75rem;
        cursor: pointer;
        padding: 0;
        text-align: left;
    }

    .toggle-link:hover {
        color: var(--text);
    }

    .actions {
        display: flex;
        gap: 0.5rem;
        margin-top: auto;
    }

    .actions button {
        flex: 1;
        padding: 0.5rem;
        border: none;
        border-radius: 6px;
        font-weight: 600;
        font-size: 0.85rem;
        cursor: pointer;
    }

    .save {
        background: var(--accent);
        color: white;
    }

    .save:hover {
        background: var(--accent-hover);
    }

    .cancel {
        background: var(--border);
        color: var(--text);
    }

    .cancel:hover {
        background: var(--surface-hover);
    }

    .divider {
        border-top: 1px solid var(--border);
        margin: 0.25rem 0;
    }

    .section-label {
        font-size: 0.75rem;
        font-weight: 600;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .google-status {
        display: flex;
        align-items: center;
    }

    .connected {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.8rem;
    }

    .dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #34a853;
        flex-shrink: 0;
    }

    .email {
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .disconnect-link {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.75rem;
        cursor: pointer;
        padding: 0;
        margin-left: auto;
        flex-shrink: 0;
    }

    .disconnect-link:hover {
        color: var(--text);
    }

    .google-connect {
        padding: 0.4rem 0.75rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.8rem;
        cursor: pointer;
    }

    .google-connect:hover:not(:disabled) {
        background: var(--surface-hover);
    }

    .google-connect:disabled {
        opacity: 0.5;
        cursor: not-allowed;
    }

    .footer-links {
        text-align: center;
        font-size: 0.75rem;
    }

    .footer-links a,
    .page-link {
        color: var(--text-muted);
        text-decoration: none;
        background: none;
        border: none;
        font: inherit;
        font-size: 0.75rem;
        cursor: pointer;
        padding: 0;
    }

    .footer-links a:hover,
    .page-link:hover {
        color: var(--text);
    }

    .footer-links .sep {
        color: var(--text-muted);
        margin: 0 0.3rem;
    }

    .version {
        text-align: center;
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .page-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        z-index: 200;
    }

    .page-modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 640px;
        max-width: 92vw;
        max-height: 85vh;
        background: #1a1a1a;
        border-radius: 10px;
        z-index: 201;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .page-modal-header {
        display: flex;
        justify-content: flex-end;
        padding: 0.5rem 0.75rem 0;
    }

    .page-modal-close {
        background: none;
        border: none;
        color: #888;
        font-size: 1.4rem;
        cursor: pointer;
        line-height: 1;
        padding: 0.2rem;
    }

    .page-modal-close:hover {
        color: #e0e0e0;
    }

    .page-modal-body {
        padding: 0 1.5rem 1.5rem;
        overflow-y: auto;
        color: #e0e0e0;
        line-height: 1.6;
        font-size: 0.9rem;
    }

    .page-modal-body :global(h1) { font-size: 1.3rem; margin-bottom: 0.5rem; }
    .page-modal-body :global(h2) { font-size: 1.05rem; margin-top: 1.5rem; }
    .page-modal-body :global(a) { color: #7cacf8; }
    .page-modal-body :global(.back) { display: none; }
    .page-modal-body :global(.updated) { font-size: 0.8rem; color: #888; }
    .page-modal-body :global(ul) {
        padding-left: 1.5rem;
        margin: 0.5rem 0;
    }
    .page-modal-body :global(li) {
        margin: 0.3rem 0;
    }
    .page-modal-body :global(code) {
        background: #2a2a2a;
        padding: 0.15em 0.35em;
        border-radius: 3px;
        font-size: 0.9em;
    }
</style>
