<script>
    import { settingsStore, updateSettings, resolveProvider } from './settings.js'

    // Preset catalogs.  OpenRouter's IDs are namespaced
    // (``openai/gpt-5.4``); direct-shape providers use bare IDs
    // (``gpt-5.4``, ``claude-opus-4-7``) since each provider's own
    // API rejects the namespaced form.  Custom mode picks one of the
    // bare lists based on the API-format choice — so a user pointing
    // at e.g. Anthropic direct can still pick "Claude Opus 4.7" from
    // a dropdown instead of typing it.
    const OPENROUTER_MODELS = [
        { id: "openai/gpt-5.4", label: "GPT-5.4" },
        { id: "openai/gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "openai/gpt-5.4-nano", label: "GPT-5.4 Nano" },
        { id: "anthropic/claude-opus-4.7", label: "Claude Opus 4.7" },
        { id: "anthropic/claude-sonnet-4.6", label: "Claude Sonnet 4.6" },
        { id: "anthropic/claude-haiku-4.5", label: "Claude Haiku 4.5" },
        { id: "google/gemini-3.1-pro-preview", label: "Gemini 3.1 Pro" },
        { id: "google/gemini-3-flash-preview", label: "Gemini 3 Flash" },
        { id: "google/gemini-3.1-flash-lite-preview", label: "Gemini 3.1 Flash Lite" },
        { id: "qwen/qwen3-coder-next", label: "Qwen3 Coder Next" },
    ]
    const OPENAI_MODELS = [
        { id: "gpt-5.4", label: "GPT-5.4" },
        { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
        { id: "gpt-5.4-nano", label: "GPT-5.4 Nano" },
    ]
    const ANTHROPIC_MODELS = [
        { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
        { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
    ]

    /** Return the active preset list for the given mode + provider. */
    function presetsFor(mode, prov) {
        if (mode === 'openrouter') return OPENROUTER_MODELS
        return prov === 'anthropic' ? ANTHROPIC_MODELS : OPENAI_MODELS
    }

    /** @type {{ open: boolean, onClose: () => void }} */
    let { open, onClose } = $props()

    let apiKey = $state('')
    let model = $state('')
    let customModel = $state(false)
    let accessMode = $state('openrouter')
    let provider = $state('openai')
    let baseUrl = $state('')
    let chapteringTrigger = $state(80000)
    let toolUseWireFormat = $state(true)
    let reasoningEffort = $state('medium')
    let githubPat = $state('')

    // Sync local state from store whenever drawer opens.  We deliberately
    // route the mode through a ``const mode`` instead of reading the
    // ``accessMode`` ``$state`` we just wrote — Svelte 5's ``$effect``
    // auto-tracks every reactive read, so a read of ``accessMode`` here
    // would make any later change to it (via the Provider select) re-fire
    // this effect and snap it right back to the stored value.  Locking
    // the control silently.  Use only ``s.*`` and locals on the right
    // side of the assignments so the only tracked deps are ``open`` and
    // ``$settingsStore``.
    $effect(() => {
        if (open) {
            const s = $settingsStore
            const mode = s.accessMode ?? 'openrouter'
            const prov = s.provider ?? 'openai'
            apiKey = s.apiKey
            accessMode = mode
            model = s.model
            // Drop into the free-text input when the stored model
            // isn't in this mode+provider's preset list — e.g. a
            // self-hosted vLLM model name picked under Custom +
            // openai-shape, or a stray legacy ID that doesn't match.
            customModel = !presetsFor(mode, prov).some(m => m.id === s.model)
            provider = prov
            baseUrl = s.baseUrl ?? ''
            chapteringTrigger = s.chapteringTrigger
            toolUseWireFormat = s.toolUseWireFormat ?? true
            reasoningEffort = s.reasoningEffort ?? 'medium'
            githubPat = s.githubPat ?? ''
        }
    })

    /** Switch access mode.  Snaps the model to the first preset of
     * the target mode+provider since model IDs aren't portable across
     * shapes — ``openai/gpt-5.4`` is OpenRouter-only, ``gpt-5.4`` is
     * direct-OpenAI-only, etc.  OpenRouter resets ``provider`` and
     * ``baseUrl`` to the recommended defaults; Custom keeps the
     * provider (the user's format choice) and baseUrl intact across
     * mode toggles. */
    function setAccessMode(mode) {
        accessMode = mode
        if (mode === 'openrouter') {
            provider = 'openai'
            baseUrl = ''
        }
        const presets = presetsFor(mode, provider)
        model = presets[0]?.id ?? ''
        customModel = false
    }

    /** Re-snap the model when the API-format toggle flips in Custom
     * mode — bare OpenAI IDs won't be valid against an Anthropic
     * endpoint and vice versa.  Only applies when the user is on a
     * preset (customModel=false); free-text custom strings are left
     * alone since the user typed them deliberately. */
    function setProvider(prov) {
        provider = prov
        if (!customModel) {
            const presets = presetsFor(accessMode, prov)
            model = presets[0]?.id ?? ''
        }
    }

    function handleSave() {
        updateSettings({
            apiKey: apiKey.trim(),
            model: model.trim(),
            accessMode,
            provider,
            baseUrl: baseUrl.trim(),
            chapteringTrigger: parseInt(chapteringTrigger, 10) || 150000,
            toolUseWireFormat,
            reasoningEffort,
            githubPat: githubPat.trim(),
        })
        onClose()
    }

    // Deep link to GitHub's classic-PAT creation page with the
    // ``gist`` scope prefilled.  Fine-grained PATs work too but
    // GitHub doesn't accept prefilled scopes on that page; user
    // selects "Gists: read and write" manually if they prefer FG.
    const PAT_DEEP_LINK = 'https://github.com/settings/tokens/new?description=agex-studio&scopes=gist'

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
            <!-- Scrollable body — every field lives here so the form
                 grows / scrolls cleanly when Advanced is expanded.
                 ``Save`` and ``Cancel`` are pinned below in `.actions`
                 so they stay reachable regardless of content height. -->
            <div class="form-body">
                <div class="field">
                    <span class="field-label">Provider</span>
                    <div class="segmented">
                        <button
                            type="button"
                            class:active={accessMode === 'openrouter'}
                            onclick={() => setAccessMode('openrouter')}
                        >OpenRouter</button>
                        <button
                            type="button"
                            class:active={accessMode === 'custom'}
                            onclick={() => setAccessMode('custom')}
                        >Custom</button>
                    </div>
                </div>

                <label>
                    <span>API Key</span>
                    <input
                        type="password"
                        bind:value={apiKey}
                        placeholder={
                            accessMode === 'openrouter' ? 'sk-or-v1-...'
                            : provider === 'anthropic' ? 'sk-ant-...'
                            : 'sk-...'
                        }
                        autocomplete="off"
                    />
                </label>

                {#if accessMode === 'custom'}
                    <label>
                        <span>Endpoint URL</span>
                        <input
                            type="text"
                            bind:value={baseUrl}
                            placeholder={
                                provider === 'anthropic'
                                    ? 'https://api.anthropic.com/v1'
                                    : 'https://api.openai.com/v1'
                            }
                            autocomplete="off"
                            spellcheck="false"
                        />
                    </label>

                    <div class="field">
                        <span class="field-label">API format</span>
                        <div class="segmented">
                            <button
                                type="button"
                                class:active={provider === 'openai'}
                                onclick={() => setProvider('openai')}
                            >OpenAI-compatible</button>
                            <button
                                type="button"
                                class:active={provider === 'anthropic'}
                                onclick={() => setProvider('anthropic')}
                            >Anthropic</button>
                        </div>
                    </div>
                {/if}

                <label>
                    <span>Model</span>
                    {#if customModel}
                        <input
                            type="text"
                            bind:value={model}
                            placeholder={accessMode === 'openrouter' ? 'provider/model-name' : 'model-name'}
                        />
                        <button type="button" class="toggle-link" onclick={() => { customModel = false; model = presetsFor(accessMode, provider)[0]?.id ?? '' }}>
                            Choose from list
                        </button>
                    {:else}
                        <select bind:value={model}>
                            {#each presetsFor(accessMode, provider) as m}
                                <option value={m.id}>{m.label}</option>
                            {/each}
                        </select>
                        <button type="button" class="toggle-link" onclick={() => { customModel = true; model = '' }}>
                            Enter custom model
                        </button>
                    {/if}
                </label>

                <label class="checkbox-row">
                    <input
                        type="checkbox"
                        bind:checked={toolUseWireFormat}
                    />
                    <span class="checkbox-label">
                        Enable native model reasoning
                    </span>
                </label>

                <label>
                    <span>Reasoning effort</span>
                    <select bind:value={reasoningEffort} disabled={!toolUseWireFormat}>
                        <option value="low">Low</option>
                        <option value="medium">Medium</option>
                        <option value="high">High</option>
                    </select>
                </label>

                {#if accessMode === 'openrouter'}
                    {@const wireFormat = resolveProvider({ accessMode, provider, model })}
                    <div class="field">
                        <span class="field-label">Wire format</span>
                        <div class="field-readonly">
                            {wireFormat === 'anthropic' ? 'Anthropic (auto)' : 'OpenAI (auto)'}
                        </div>
                        <div class="field-hint">
                            {#if wireFormat === 'anthropic'}
                                Anthropic models route via OpenRouter's <code>/v1/messages</code>
                                endpoint so prompt-cache markers flow through.
                            {:else}
                                Non-Anthropic models use OpenRouter's
                                <code>/v1/chat/completions</code> endpoint.
                                Gemini's implicit caching still applies.
                            {/if}
                        </div>
                    </div>
                {/if}

                <div class="divider"></div>

                <label>
                    <span>Chaptering trigger (tokens)</span>
                    <input
                        type="number"
                        bind:value={chapteringTrigger}
                        min="1000"
                        step="1000"
                    />
                </label>

                <div class="divider"></div>

                <label>
                    <span>GitHub Personal Access Token</span>
                    <input
                        type="password"
                        bind:value={githubPat}
                        placeholder="ghp_… or github_pat_…"
                        autocomplete="off"
                        spellcheck="false"
                    />
                    <span class="hint">
                        For publishing work as gists
                        (<a href={PAT_DEEP_LINK} target="_blank" rel="noopener">create</a>)
                    </span>
                </label>

            </div>

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
        z-index: 101;
        display: flex;
        flex-direction: column;
        /* Drawer is a 3-row flex column: header (h2) + form (which
           contains its own scrollable body + sticky actions footer).
           No padding here so the form-body's scrollbar runs the full
           height; padding lives on h2 and form-body instead. */
    }

    h2 {
        font-size: 1.1rem;
        font-weight: 600;
        padding: 1.5rem 1.5rem 0.75rem;
        margin: 0;
        flex-shrink: 0;
    }

    form {
        display: flex;
        flex-direction: column;
        flex: 1;
        min-height: 0;  /* required for the inner overflow:auto to work */
    }

    .form-body {
        flex: 1;
        overflow-y: auto;
        padding: 0.5rem 1.5rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.25rem;
    }

    label {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    label span,
    .field-label {
        font-size: 0.8rem;
        color: var(--text-muted);
        font-weight: 500;
    }

    .field {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
    }

    .field-readonly {
        font-size: 0.85rem;
        padding: 0.4rem 0.6rem;
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 6px;
        color: var(--text);
    }

    .field-hint {
        font-size: 0.75rem;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .field-hint code {
        font-size: 0.75rem;
        background: var(--input-bg);
        padding: 0.05rem 0.3rem;
        border-radius: 3px;
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

    .checkbox-row {
        display: flex;
        flex-direction: row;
        align-items: flex-start;
        gap: 0.55rem;
    }

    .checkbox-row input[type="checkbox"] {
        margin-top: 0.15rem;
        width: 1rem;
        height: 1rem;
        padding: 0;
        flex: 0 0 auto;
    }

    .checkbox-label {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        color: var(--text);
        font-size: 0.85rem;
        font-weight: 500;
        line-height: 1.25;
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
        padding: 0.75rem 1.5rem 0.5rem;
        border-top: 1px solid var(--border);
        background: var(--surface);
        flex-shrink: 0;
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

    .footer-links {
        text-align: center;
        font-size: 0.75rem;
        padding: 0.25rem 1.5rem 1rem;
        background: var(--surface);
        flex-shrink: 0;
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
