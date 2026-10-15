<script>
    /** The settings, in three tabs. Model: the model the studio talks
     *  to, OpenRouter or an endpoint of the person's own (a direct
     *  provider, a local Meridian, a proxy), the essentials up front and
     *  the rest under Advanced, summed up in a line. Notifications:
     *  whether a turn that ends while they're away notifies them. Sync &
     *  sharing: syncing sessions through a GitHub repo of their own, and
     *  the token publishing writes gists with. The header and the buttons
     *  stay put; the tab's content scrolls. */
    import { onMount, untrack } from 'svelte'
    import ModelPicker from './ModelPicker.svelte'
    import RouterKeyCheck from './RouterKeyCheck.svelte'
    import { WINDOW_SHARE, foldBudgetOf } from './model.js'
    import { catalogStore, contextLabel, modelInfo, priceLabel } from './openrouter-models.js'
    import { endpointLabel, loadEndpoints, routeOf, withRoute } from './openrouter-routing.js'
    import { getSettings, updateSettings } from './settings.js'
    import { GIST_TOKEN_URL } from './gist.js'
    import { notificationPermission, requestNotificationPermission } from './notify.js'
    import { NEW_REPO_URL, NEW_TOKEN_URL, connectSync, preferredRepo } from './sync-connect.js'

    /** @type {{ onClose: () => void, tab?: 'model' | 'notify' | 'sync' }} */
    let { onClose, tab: firstTab = 'model' } = $props()

    let tab = $state(untrack(() => firstTab))

    let permission = $state(notificationPermission())
    // notifications on only while the browser allows them (it may have stopped since)
    let s = $state({ ...getSettings(), ...(notificationPermission() !== 'granted' && { notifyOnFinish: false }) })

    /** What OpenRouter's catalog says of the model chosen there; null for
     *  another service, or a model it doesn't list. Read again when a
     *  catalog arrives (the picker loads it). */
    const info = $derived((void $catalogStore, s.accessMode === 'openrouter' ? modelInfo(s.routerModel) : null))
    /** The chosen model's facts, in a short line (its name is in the
     *  field's tooltip and the picker's list). */
    const facts = $derived(
        info === null
            ? ''
            : [
                  info.context !== null ? `${contextLabel(info.context)} context` : null,
                  info.input !== null ? `${priceLabel(info.input)} / ${priceLabel(info.output)} per M tokens` : null,
                  info.images ? 'images' : 'text only',
              ]
                  .filter((part) => part !== null)
                  .join(' · '),
    )

    /** The providers serving the OpenRouter model, once loaded (`list`
     *  null: OpenRouter doesn't list them); null while loading, or for a
     *  model the catalog doesn't list.
     *  @type {{ id: string, list: import('./openrouter-routing.js').RouterEndpoint[] | null } | null} */
    let endpoints = $state(null)
    let endpointsFailed = $state('')
    const routedId = $derived(info?.id ?? null)
    $effect(() => {
        const id = routedId
        endpoints = null
        endpointsFailed = ''
        if (id === null) return
        let live = true
        loadEndpoints(id).then(
            (list) => live && (endpoints = { id, list }),
            (e) => live && (endpointsFailed = e instanceof Error ? e.message : String(e)),
        )
        return () => {
            live = false
        }
    })
    /** The route set for the OpenRouter model, else Auto. */
    const route = $derived(routeOf(s, s.routerModel))
    /** @param {Partial<import('./settings.js').RouterRoute>} patch */
    function setRoute(patch) {
        s.routerRouting = withRoute(s.routerRouting, s.routerModel, { ...route, ...patch })
    }

    /** Where the OpenRouter key stands, from its check: the link to make
     *  one shows only while there's none, or a rejected one. */
    let keyStatus = $state(/** @type {'empty' | 'checking' | 'accepted' | 'rejected' | 'unknown'} */ ('empty'))

    /** The fold sizes offered; another saved value is offered too. */
    const FOLD_PRESETS = [0, 50_000, 100_000, 150_000, 250_000, 500_000]
    /** @param {number} n */
    const foldLabel = (n) => (n === 0 ? 'Never' : `Past ${contextLabel(n)} tokens`)

    /** What Advanced holds, in a line, so it needn't be opened to know. */
    const summary = $derived.by(() => {
        /** @type {string[]} */
        const parts = []
        if (s.accessMode === 'openrouter') {
            const name = endpoints?.list?.find((ep) => ep.tag === route.provider)?.provider ?? route.provider
            const sorts = { price: 'cheapest first', throughput: 'fastest first', latency: 'quickest first' }
            parts.push(route.provider !== null ? `${name} ${route.only ? 'only' : 'first'}` : route.sort !== null ? sorts[route.sort] : 'Auto provider')
            if (s.routerDenyTraining) parts.push('no training')
            if (s.routerZdr) parts.push('zero retention')
        }
        // where the catalog doesn't say, the setting does
        if (s.accessMode !== 'scripted' && info === null) parts.push(s.vision ? 'takes images' : 'text only')
        if (s.accessMode === 'custom') parts.push(s.routerKey.trim() !== '' ? 'web & media on' : 'web & media off')
        const fold = foldBudgetOf(s)
        parts.push(fold === 0 ? 'never folds' : `folds at ${contextLabel(fold)}`)
        return parts.join(' · ')
    })

    /** @type {HTMLDivElement | undefined} */
    let dialog = $state()
    // the keyboard starts in the dialog, so Escape and Tab work at once
    onMount(() => dialog?.focus())

    /** Escape closes, from anywhere (a field's own Escape, like the
     *  model list's, is handled before it reaches here).
     *  @param {KeyboardEvent} e */
    function onWindowKey(e) {
        if (e.key === 'Escape' && !e.defaultPrevented) onClose()
    }

    function save() {
        updateSettings($state.snapshot(s))
        onClose()
    }

    /** The browser was asked, from this dialog. */
    let asked = $state(false)

    /** Notifications turned on ask the browser first, from this click:
     *  refused, they stay off. */
    async function notifyChanged() {
        if (!s.notifyOnFinish) return
        if (permission !== 'granted') {
            permission = await requestNotificationPermission()
            asked = true
        }
        s.notifyOnFinish = permission === 'granted'
    }

    let token = $state('')
    /** @type {{ repo: string, private: boolean, ready: boolean }[]} */
    let choices = $state([])
    let chosen = $state('')
    let connecting = $state(false)
    let connectNote = $state('')

    async function connect() {
        connecting = true
        connectNote = ''
        try {
            const out = await connectSync(token.trim(), choices.length > 0 ? { repo: chosen } : {})
            if ('reason' in out) {
                connectNote = out.message
                if (out.reason === 'choose') {
                    choices = out.choices
                    chosen = preferredRepo(out.choices)
                }
            } else {
                // at once, beside the rest: connecting doesn't wait for Save
                s.syncRepo = out.repo
                s.syncToken = token.trim()
                updateSettings({ syncRepo: out.repo, syncToken: token.trim() })
                token = ''
                choices = []
                connectNote = out.private ? '' : `${out.repo} is public: anyone can read the sessions synced there.`
            }
        } finally {
            connecting = false
        }
    }

    function disconnect() {
        s.syncRepo = ''
        s.syncToken = ''
        updateSettings({ syncRepo: '', syncToken: '' })
        connectNote = ''
    }
</script>

<svelte:window onkeydown={onWindowKey} />

<div class="backdrop" role="presentation" onclick={onClose}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <div class="dialog" role="dialog" aria-modal="true" aria-label="Settings" tabindex="-1" bind:this={dialog} onclick={(e) => e.stopPropagation()}>
        <div class="head">
            <div class="title">
                <h2>Settings</h2>
                <button class="close" onclick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
            </div>
            <div class="tabs" role="tablist">
                <button role="tab" class="tab" class:on={tab === 'model'} aria-selected={tab === 'model'} onclick={() => (tab = 'model')}>Model</button>
                <button role="tab" class="tab" class:on={tab === 'notify'} aria-selected={tab === 'notify'} onclick={() => (tab = 'notify')}>Notifications</button>
                <button role="tab" class="tab" class:on={tab === 'sync'} aria-selected={tab === 'sync'} onclick={() => (tab = 'sync')}>Sync &amp; sharing</button>
            </div>
        </div>

        <div class="body">
            {#if tab === 'model'}
                <div class="row">
                    <span class="name" id="service">Service</span>
                    <div class="segments" role="radiogroup" aria-labelledby="service">
                        <button role="radio" aria-checked={s.accessMode === 'openrouter'} class:on={s.accessMode === 'openrouter'} onclick={() => (s.accessMode = 'openrouter')}>OpenRouter</button>
                        <button role="radio" aria-checked={s.accessMode === 'custom'} class:on={s.accessMode === 'custom'} onclick={() => (s.accessMode = 'custom')}>My own endpoint</button>
                    </div>
                </div>
                {#if s.accessMode === 'scripted'}
                    <!-- the dev driver's: set by it, not here -->
                    <p class="hint under">A scripted model, set by the dev driver. Pick a service to leave it.</p>
                {/if}

                {#if s.accessMode === 'openrouter'}
                    <label class="row">
                        <span class="name">Key</span>
                        <input type="password" bind:value={s.routerKey} placeholder="sk-or-…" autocomplete="off" />
                    </label>
                    <div class="under">
                        <RouterKeyCheck key={s.routerKey} bind:status={keyStatus} />
                        {#if keyStatus === 'empty' || keyStatus === 'rejected'}
                            <p class="hint">Make one at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>. It stays in this browser, and goes only to OpenRouter.</p>
                        {/if}
                    </div>
                    <div class="row">
                        <span class="name">Model</span>
                        <div title={info?.name ?? ''}><ModelPicker bind:value={s.routerModel} /></div>
                    </div>
                    <div class="under">
                        {#if info !== null}
                            <p class="hint">{facts}{#if !info.tools}<span class="warn-text">{' · '}can't call tools, so the agent can't work with it</span>{/if}</p>
                        {:else if s.routerModel.trim() !== ''}
                            <p class="hint">Not in OpenRouter's list: used as typed.</p>
                        {/if}
                    </div>
                {:else if s.accessMode === 'custom'}
                    <label class="row">
                        <span class="name">URL</span>
                        <input bind:value={s.baseUrl} placeholder="http://localhost:3456" />
                    </label>
                    <label class="row">
                        <span class="name">Shape</span>
                        <select bind:value={s.wire}>
                            <option value="anthropic">Anthropic (Messages API, Meridian)</option>
                            <option value="openai">OpenAI-compatible</option>
                        </select>
                    </label>
                    <label class="row">
                        <span class="name">Key</span>
                        <input type="password" bind:value={s.endpointKey} placeholder="if the endpoint needs one" autocomplete="off" />
                    </label>
                    <label class="row">
                        <span class="name">Model</span>
                        <input bind:value={s.endpointModel} placeholder="the endpoint's name for it" />
                    </label>
                {/if}

                {#if s.accessMode !== 'scripted'}
                    <label class="row">
                        <span class="name">Thinking</span>
                        {#if info !== null && !info.reasoning}
                            <span class="hint inline">Doesn't apply: this model doesn't reason</span>
                        {:else}
                            <select bind:value={s.thinking}>
                                <option value="off">Off</option>
                                <option value="low">Low</option>
                                <option value="medium">Medium</option>
                                <option value="high">High</option>
                            </select>
                        {/if}
                    </label>

                    <details class="advanced">
                        <summary><span class="label">Advanced</span><span class="sum">{summary}</span></summary>
                        <div class="inner">
                            {#if s.accessMode === 'openrouter'}
                                {#if info !== null && endpoints?.list !== null}
                                    <label class="row">
                                        <span class="name">Provider</span>
                                        {#if endpoints === null && endpointsFailed === ''}
                                            <select disabled><option>Loading its providers…</option></select>
                                        {:else if endpoints !== null && endpoints.list !== null}
                                            {@const list = endpoints.list}
                                            <select value={route.provider ?? ''} onchange={(e) => setRoute({ provider: e.currentTarget.value || null })}>
                                                <option value="">Auto (OpenRouter picks)</option>
                                                {#each list as ep (ep.tag)}<option value={ep.tag}>{endpointLabel(ep, list)}</option>{/each}
                                                {#if route.provider !== null && !list.some((ep) => ep.tag === route.provider)}
                                                    <option value={route.provider}>{route.provider} (no longer listed)</option>
                                                {/if}
                                            </select>
                                        {:else}
                                            <span class="hint inline warn" title={endpointsFailed}>Couldn't load its providers{route.provider !== null ? `: still asks ${route.provider} first` : ''}</span>
                                        {/if}
                                    </label>
                                    {#if route.provider !== null}
                                        <label class="check indent" title="With it on, a request fails rather than go to another provider when this one is down.">
                                            <input type="checkbox" checked={route.only} onchange={(e) => setRoute({ only: e.currentTarget.checked })} />
                                            Only this provider
                                        </label>
                                    {:else}
                                        <label class="row">
                                            <span class="name">Prefer</span>
                                            <select value={route.sort ?? ''} onchange={(e) => setRoute({ sort: /** @type {'price' | 'throughput' | 'latency' | ''} */ (e.currentTarget.value) || null })}>
                                                <option value="">No preference</option>
                                                <option value="price">Lowest price</option>
                                                <option value="throughput">Highest throughput</option>
                                                <option value="latency">Lowest latency</option>
                                            </select>
                                        </label>
                                    {/if}
                                {/if}
                                <div class="group">
                                    <label class="check" title="Only providers whose stated policy is not to store prompts or train on them.">
                                        <input type="checkbox" bind:checked={s.routerDenyTraining} />
                                        Skip providers that may train on my prompts
                                    </label>
                                    <label class="check" title="Only endpoints that keep nothing of a request once it's answered. Fewer qualify; when none does, requests fail.">
                                        <input type="checkbox" bind:checked={s.routerZdr} />
                                        Zero data retention only
                                    </label>
                                    <p class="hint">For every request to OpenRouter: the model, web search and media.</p>
                                </div>
                            {/if}
                            {#if info === null}
                                <!-- an endpoint's model, or one OpenRouter doesn't list: only the person can say -->
                                <label class="check">
                                    <input type="checkbox" bind:checked={s.vision} />
                                    The model takes images (screenshots of its apps)
                                </label>
                            {/if}
                            <label class="row">
                                <span class="name">Fold</span>
                                <select bind:value={s.foldBudget} title="Past this size, the conversation's earlier part is folded into a summary for the model; the chat still shows all of it.">
                                    {#each FOLD_PRESETS as n (n)}<option value={n}>{foldLabel(n)}</option>{/each}
                                    {#if !FOLD_PRESETS.includes(s.foldBudget)}<option value={s.foldBudget}>{foldLabel(s.foldBudget)}</option>{/if}
                                </select>
                            </label>
                            {#if info !== null && info.context !== null && s.foldBudget > 0 && foldBudgetOf(s) < s.foldBudget}
                                <p class="hint under">Folds by {contextLabel(foldBudgetOf(s))} with this model: {Math.round(WINDOW_SHARE * 100)}% of its {contextLabel(info.context)} window.</p>
                            {/if}
                            {#if s.accessMode === 'custom'}
                                <div class="group">
                                    <span class="sub">Web search and media</span>
                                    <label class="row">
                                        <span class="name">OpenRouter key</span>
                                        <input type="password" bind:value={s.routerKey} placeholder="optional · sk-or-…" autocomplete="off" />
                                    </label>
                                    <div class="under">
                                        <RouterKeyCheck key={s.routerKey} bind:status={keyStatus} />
                                        <p class="hint">They run on OpenRouter whatever the model. The key goes only to OpenRouter.</p>
                                    </div>
                                </div>
                            {/if}
                        </div>
                    </details>
                {/if}
            {:else if tab === 'notify'}
                <label class="check" title="While the studio's tab is open: when you're in another session, another tab or another app.">
                    <input type="checkbox" bind:checked={s.notifyOnFinish} onchange={notifyChanged} disabled={permission === 'unsupported' || permission === 'denied'} />
                    Notify me when a turn ends while I'm away
                </label>
                {#if asked && permission !== 'granted'}
                    <p class="hint warn">The browser didn't allow them, so they stay off.</p>
                {:else if permission === 'denied'}
                    <p class="hint">Blocked in this browser: allow notifications for this site in its settings, then reopen this dialog.</p>
                {:else if permission === 'unsupported'}
                    <p class="hint">This browser doesn't show notifications.</p>
                {/if}
                <p class="hint">Away: in another session, another tab or another app. They come only while the studio's tab is open. Apps can notify you too, once you've allowed it here.</p>
            {:else}
                <h3>Sync</h3>
                {#if s.syncRepo}
                    <p class="hint">Sessions sync through <code>{s.syncRepo}</code>: each one a few seconds after it changes, and every one when the studio opens or comes back into view.</p>
                    {#if connectNote}<p class="hint warn">{connectNote}</p>{/if}
                    <div class="actions-row">
                        <button class="secondary" onclick={disconnect}>Disconnect</button>
                        <span class="hint">Forgets the repo on this device only: the repo and its sessions stay.</span>
                    </div>
                {:else}
                    <p class="hint">Keep your sessions in a private GitHub repo of your own, to work on them from another device.</p>
                    <ol class="hint">
                        <li><a href={NEW_REPO_URL} target="_blank" rel="noreferrer">Make a private repo</a>, and tick "Add a README".</li>
                        <li><a href={NEW_TOKEN_URL} target="_blank" rel="noreferrer">Make a fine-grained token</a>: only that repo, with Contents read and write.</li>
                        <li>Paste the token here and connect.</li>
                    </ol>
                    <label class="row">
                        <span class="name">Token</span>
                        <input type="password" bind:value={token} placeholder="github_pat_…" autocomplete="off" />
                    </label>
                    {#if choices.length > 0}
                        <label class="row">
                            <span class="name">Repo</span>
                            <select bind:value={chosen}>
                                {#each choices as c (c.repo)}<option value={c.repo}>{c.repo}{c.private ? '' : ' (public)'}</option>{/each}
                            </select>
                        </label>
                    {/if}
                    {#if connectNote}<p class="hint warn">{connectNote}</p>{/if}
                    <div class="actions-row">
                        <button class="secondary" onclick={connect} disabled={connecting || token.trim() === ''}>{connecting ? 'Connecting…' : 'Connect'}</button>
                        <span class="hint">Connects at once, without waiting for Save.</span>
                    </div>
                {/if}
                <h3>Publishing</h3>
                <p class="hint">A session is published as a secret gist, which anyone with its link can open. It needs a token that can write gists: <a href={GIST_TOKEN_URL} target="_blank" rel="noreferrer">a classic one with the gist scope</a>, or a fine-grained one with Gists: read and write.{s.syncRepo ? ' Left empty, the sync token is tried.' : ''}</p>
                <label class="row">
                    <span class="name">Token</span>
                    <input type="password" bind:value={s.publishToken} placeholder="ghp_… or github_pat_…" autocomplete="off" />
                </label>
            {/if}
        </div>

        <div class="actions">
            <button class="secondary" onclick={onClose}>Cancel</button>
            <button onclick={save}>Save</button>
        </div>
    </div>
</div>

<style>
    /* anchored near the top, so the dialog grows and shrinks downward
       (a tab, Advanced) rather than moving */
    .backdrop {
        position: fixed;
        inset: 0;
        background: rgb(0 0 0 / 50%);
        display: grid;
        justify-items: center;
        align-items: start;
        padding-top: min(10vh, 6rem);
        /* the modal layer: above the drawer, the switch button, the pill */
        z-index: 50;
    }
    /* header and buttons fixed, the tab's content scrolling between */
    .dialog {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        width: min(31rem, 94vw);
        max-height: calc(100dvh - 2 * min(10vh, 6rem));
        display: flex;
        flex-direction: column;
        outline: none;
    }
    .head {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 1.1rem 1.2rem 0;
        border-bottom: 1px solid var(--border);
    }
    .title {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    h2 {
        font-family: var(--font-display);
        font-size: 1.2rem;
    }
    .close {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 1rem;
        padding: 0.2rem 0.4rem;
        border-radius: 6px;
    }
    .close:hover {
        color: var(--text);
        background: var(--surface-hover);
    }
    .tabs {
        display: flex;
        gap: 1.1rem;
    }
    .tab {
        background: none;
        border: none;
        border-bottom: 2px solid transparent;
        border-radius: 0;
        color: var(--text-muted);
        padding: 0.2rem 0 0.45rem;
        font: inherit;
        font-size: 0.9rem;
    }
    .tab.on {
        color: var(--text);
        border-bottom-color: var(--accent);
    }
    .body {
        overflow-y: auto;
        padding: 1rem 1.2rem;
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }
    .actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.8rem 1.2rem;
        border-top: 1px solid var(--border);
    }
    h3 {
        font-family: var(--font-body);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-top: 0.2rem;
    }
    /* a field: its name beside it, and above it on a narrow screen */
    .row {
        display: grid;
        grid-template-columns: 6.5rem 1fr;
        align-items: center;
        gap: 0.6rem;
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .row > :global(*:last-child) {
        min-width: 0;
    }
    /* what a field says of itself: under the field, not under its name */
    .under {
        margin-left: 7.1rem;
        margin-top: -0.35rem;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }
    .under:empty {
        display: none;
    }
    @media (max-width: 30rem) {
        .row {
            grid-template-columns: 1fr;
            gap: 0.25rem;
        }
        .under {
            margin-left: 0;
        }
    }
    .check {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .check.indent {
        margin-left: 7.1rem;
        margin-top: -0.3rem;
    }
    @media (max-width: 30rem) {
        .check.indent {
            margin-left: 0;
        }
    }
    input,
    select {
        background: var(--input-bg);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.4rem;
        font: inherit;
        width: 100%;
        box-sizing: border-box;
    }
    .check input {
        width: auto;
    }
    .segments {
        display: inline-flex;
        border: 1px solid var(--border);
        border-radius: 7px;
        overflow: hidden;
        justify-self: start;
    }
    .segments button {
        background: none;
        border: none;
        border-radius: 0;
        color: var(--text-muted);
        padding: 0.35rem 0.8rem;
        font: inherit;
        font-size: 0.85rem;
    }
    .segments button + button {
        border-left: 1px solid var(--border);
    }
    .segments button.on {
        background: var(--input-bg);
        color: var(--text);
    }
    .advanced {
        border: 1px solid var(--border);
        border-radius: 8px;
    }
    .advanced summary {
        display: flex;
        align-items: baseline;
        gap: 0.6rem;
        padding: 0.55rem 0.7rem;
        cursor: pointer;
        font-size: 0.85rem;
        color: var(--text);
        list-style: none;
    }
    .advanced summary::-webkit-details-marker {
        display: none;
    }
    .advanced summary::before {
        content: '▸';
        color: var(--text-muted);
        font-size: 0.75rem;
    }
    .advanced[open] summary::before {
        content: '▾';
    }
    .sum {
        color: var(--text-muted);
        font-size: 0.78rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
    }
    .inner {
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
        padding: 0.3rem 0.7rem 0.8rem;
    }
    .group {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        padding-top: 0.6rem;
        border-top: 1px solid var(--border);
    }
    .sub {
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
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
    .secondary:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .hint {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin: 0;
    }
    .hint.inline {
        font-size: 0.82rem;
    }
    ol.hint {
        padding-left: 1.2rem;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }
    .hint a {
        color: var(--accent);
    }
    .warn {
        color: var(--error);
    }
    .warn-text {
        color: var(--caution, #d9a441);
    }
    .actions-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }
</style>
