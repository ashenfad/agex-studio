<script>
    import { settingsStore, updateSettings } from './settings.js'
    import { presetsFor, supportsServiceTier } from './models.js'
    import {
        SYNC_PAT_CREATE_LINK,
        SYNC_REPO_CREATE_LINK,
        connectSyncRepo,
    } from './sync-settings.js'

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
    let serviceTier = $state('standard')
    let githubPat = $state('')

    // The tier picker is only meaningful for OpenAI / Google models;
    // hide it elsewhere so the form doesn't sprout an inert knob.
    // Derived from the live local state so flipping `accessMode` or
    // `model` in the drawer shows/hides the row immediately.
    let tierSupported = $derived(supportsServiceTier(accessMode, provider, model))

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
            apiKey = s.apiKey ?? ''
            accessMode = mode
            model = s.model ?? ''
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
            serviceTier = s.serviceTier ?? 'standard'
            githubPat = s.githubPat ?? ''
        }
    })

    /** Switch access mode.  Snaps the model to the first preset of
     * the target mode+provider since model IDs aren't portable across
     * shapes — ``openai/gpt-5.4`` is OpenRouter-only, ``gpt-5.4`` is
     * direct-OpenAI-only, etc.  OpenRouter resets ``provider`` to the
     * recommended default but keeps the typed ``baseUrl`` in local
     * state so toggling back to Custom restores it — ``handleSave``
     * is what zeroes the persisted baseUrl when on OpenRouter. */
    function setAccessMode(mode) {
        accessMode = mode
        if (mode === 'openrouter') {
            provider = 'openai'
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
            baseUrl: accessMode === 'custom' ? baseUrl.trim() : '',
            chapteringTrigger: parseInt(chapteringTrigger, 10) || 150000,
            toolUseWireFormat,
            reasoningEffort,
            // Persist tier always, even when the current model doesn't
            // support it — preserves user intent across model switches
            // (Anthropic → Claude → OpenAI restores the previous
            // selection without making them re-pick).
            serviceTier,
            githubPat: githubPat.trim(),
        })
        onClose()
    }

    // Deep link to GitHub's classic-PAT creation page with the
    // ``gist`` scope prefilled.  Fine-grained PATs work too but
    // GitHub doesn't accept prefilled scopes on that page; user
    // selects "Gists: read and write" manually if they prefer FG.
    const PAT_DEEP_LINK = 'https://github.com/settings/tokens/new?description=agex-studio&scopes=gist'

    // --- Session sync (connect wizard; engine wiring is a later slice) ---
    //
    // Connect runs immediately (network flow with its own success /
    // error states) rather than riding the form's Save — Save/Cancel
    // never touch syncRepo/syncPat.
    let syncPatInput = $state('')
    let syncBusy = $state(false)
    let syncError = $state('')
    let syncNotice = $state('')
    /** @type {Array<{ fullName: string, private: boolean }>} */
    let syncChoices = $state([])
    let syncRepoChoice = $state('')
    let syncConnectedRepo = $derived($settingsStore.syncRepo ?? '')

    async function handleSyncConnect() {
        syncBusy = true
        syncError = ''
        syncNotice = ''
        try {
            const pat = syncPatInput.trim()
            const result = await connectSyncRepo(
                pat,
                syncRepoChoice ? { repo: syncRepoChoice } : {},
            )
            if (result.ok) {
                updateSettings({ syncRepo: result.repo, syncPat: pat })
                syncPatInput = ''
                syncChoices = []
                syncRepoChoice = ''
                if (result.isPrivate === false) {
                    syncNotice = `Heads up: ${result.repo} is public — synced sessions will be world-readable.`
                }
            } else if (result.reason === 'choose') {
                syncChoices = result.choices
                syncRepoChoice = result.choices[0]?.fullName ?? ''
                syncError = 'The token can reach several repos — pick the sync repo and connect again.'
            } else {
                syncError = result.message
            }
        } catch (err) {
            syncError = err?.message ?? String(err)
        } finally {
            syncBusy = false
        }
    }

    /** Forget the connection on this device only — the repo and its
     *  sessions are untouched. */
    function handleSyncDisconnect() {
        updateSettings({ syncRepo: '', syncPat: '' })
        syncNotice = ''
        syncError = ''
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
                    {#if accessMode === 'custom'}
                        <span class="field-hint">
                            Web search uses OpenRouter (Perplexity Sonar). Search works
                            here only when this key is also valid against OpenRouter.
                        </span>
                    {/if}
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

                {#if tierSupported}
                    <!-- Service tier — OpenRouter's request-body
                         `service_tier` passthrough. `standard` omits
                         the field (provider default); `flex` opts
                         into cheaper + slower; `priority` opts into
                         faster + costlier. Only OpenAI and Google
                         models honor it per OpenRouter docs; the row
                         hides for everything else. -->
                    <div class="field">
                        <span class="field-label">Service tier</span>
                        <div class="segmented">
                            <button
                                type="button"
                                class:active={serviceTier === 'standard'}
                                onclick={() => serviceTier = 'standard'}
                                title="Provider's default tier"
                            >Standard</button>
                            <button
                                type="button"
                                class:active={serviceTier === 'flex'}
                                onclick={() => serviceTier = 'flex'}
                                title="Lower cost, higher latency"
                            >Flex</button>
                            <button
                                type="button"
                                class:active={serviceTier === 'priority'}
                                onclick={() => serviceTier = 'priority'}
                                title="Higher cost, faster"
                            >Priority</button>
                        </div>
                    </div>
                {/if}

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

                <!-- OpenRouter mode: wire format is implicit (OpenAI shape).
                     We don't surface the choice in the UI — `resolveProvider`
                     handles it and the user has nothing actionable to pick
                     here.  See settings.js for the routing details. -->

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

                <div class="divider"></div>

                <div class="sync-section">
                    <span class="sync-title">Session sync</span>
                    {#if syncConnectedRepo}
                        <div class="sync-connected">
                            Connected to <code>{syncConnectedRepo}</code>
                        </div>
                        {#if syncNotice}
                            <span class="hint sync-warn">{syncNotice}</span>
                        {/if}
                        <button type="button" class="sync-btn" onclick={handleSyncDisconnect}>
                            Disconnect
                        </button>
                        <span class="hint">
                            Disconnecting only forgets the connection on this
                            device — the repo and its sessions are untouched.
                        </span>
                    {:else}
                        <ol class="sync-steps">
                            <li>
                                <a href={SYNC_REPO_CREATE_LINK} target="_blank" rel="noopener">
                                    Create a private sync repo</a>
                                — tick “Add a README”.
                            </li>
                            <li>
                                <a href={SYNC_PAT_CREATE_LINK} target="_blank" rel="noopener">
                                    Create a fine-grained token</a>
                                — Only select repositories → your sync repo;
                                Permissions → Contents: Read and write.
                            </li>
                            <li>Paste the token and connect.</li>
                        </ol>
                        <input
                            type="password"
                            bind:value={syncPatInput}
                            placeholder="github_pat_…"
                            autocomplete="off"
                            spellcheck="false"
                        />
                        {#if syncChoices.length > 1}
                            <select bind:value={syncRepoChoice}>
                                {#each syncChoices as choice (choice.fullName)}
                                    <option value={choice.fullName}>
                                        {choice.fullName}{choice.private ? '' : ' (public)'}
                                    </option>
                                {/each}
                            </select>
                        {/if}
                        <button
                            type="button"
                            class="sync-btn"
                            onclick={handleSyncConnect}
                            disabled={syncBusy || !syncPatInput.trim()}
                        >
                            {syncBusy ? 'Connecting…' : 'Connect'}
                        </button>
                        {#if syncError}
                            <span class="hint sync-warn">{syncError}</span>
                        {/if}
                    {/if}
                </div>

            </div>

            <div class="actions">
                <button class="save" type="submit">Save</button>
                <button class="cancel" type="button" onclick={onClose}>Cancel</button>
            </div>
        </form>
    </div>
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
    .field-hint {
        display: block;
        font-size: 0.75rem;
        color: var(--text-muted);
        margin-top: 0.35rem;
        line-height: 1.35;
    }

    .field-label {
        font-size: 0.8rem;
        color: var(--text-muted);
        font-weight: 500;
    }

    .sync-section {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .sync-title {
        font-size: 0.8rem;
        color: var(--text-muted);
        font-weight: 500;
    }

    .sync-steps {
        margin: 0;
        padding-left: 1.1rem;
        font-size: 0.78rem;
        color: var(--text-muted);
        line-height: 1.45;
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }

    .sync-btn {
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.45rem 0.75rem;
        font-family: inherit;
        font-size: 0.85rem;
        cursor: pointer;
        align-self: flex-start;
    }

    .sync-btn:hover:not(:disabled) {
        border-color: var(--accent);
    }

    .sync-btn:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .sync-connected {
        font-size: 0.85rem;
    }

    .sync-connected code {
        background: var(--input-bg);
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 0.1rem 0.35rem;
        font-size: 0.8rem;
    }

    .sync-warn {
        color: #d9822b;
    }

    .field {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
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

</style>
