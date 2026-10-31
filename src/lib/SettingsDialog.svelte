<script>
    /** The settings, in three tabs. Model: the model the studio talks
     *  to, OpenRouter or an endpoint of the person's own (a direct
     *  provider, a local Meridian, a proxy), the essentials up front and
     *  the rest under Advanced, summed up in a line. Notifications:
     *  whether a turn that ends while they're away notifies them. Sync &
     *  sharing: syncing sessions through a GitHub repo of their own, and
     *  the token publishing writes gists with. Keys: the vault of keys
     *  the person gives apps and their agents, each with whether every
     *  agent has it, and the apps and sessions' agents granted it; and
     *  the sites each session's agent may open in this browser's tabs.
     *  The header and the buttons stay put; the tab's content scrolls. */
    import { tick, untrack } from 'svelte'
    import { errorText } from './errors.js'
    import Dialog from './Dialog.svelte'
    import ModelPicker from './ModelPicker.svelte'
    import RouterKeyCheck from './RouterKeyCheck.svelte'
    import { WINDOW_SHARE, foldBudgetOf } from './model.js'
    import { catalogStore, contextLabel, modelInfo, priceLabel } from './openrouter-models.js'
    import { endpointLabel, loadEndpoints, routeOf, withRoute } from './openrouter-routing.js'
    import { getSettings, updateSettings } from './settings.js'
    import { GIST_TOKEN_URL } from './gist.js'
    import { notificationPermission, requestNotificationPermission } from './notify.js'
    import { NEW_REPO_URL, NEW_TOKEN_URL, connectSync, preferredRepo } from './sync-connect.js'
    import { studio } from './studio.svelte.js'
    import { VaultError, sessionsOf, vault } from './vault.svelte.js'
    import { browserExtension } from './browser-extension.svelte.js'

    /** @type {{ onClose: () => void, tab?: 'model' | 'notify' | 'sync' | 'keys' }} */
    let { onClose, tab: firstTab = 'model' } = $props()

    let tab = $state(untrack(() => firstTab))
    /** The tabs the person shared with sessions, asked of the extension
     *  when the dialog opens and after each stop. */
    let sharedTabs = $state(studio.shares.sharedNow())

    /** @param {string} session @param {number} id */
    async function stopSharing(session, id) {
        await studio.shares.stop(session, id).catch(() => {})
        sharedTabs = studio.shares.sharedNow()
    }

    /** @param {string} session @param {number} id @param {boolean} acts */
    async function setMode(session, id, acts) {
        await studio.shares.setMode(session, id, acts).catch(() => {})
        sharedTabs = studio.shares.sharedNow()
    }

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
            (e) => live && (endpointsFailed = errorText(e)),
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
                // at once, beside the rest: connecting doesn't wait for Save;
                // the token was checked against GitHub's own API, so a
                // stand-in's (syncApi, set only in testing) goes
                s.syncRepo = out.repo
                s.syncToken = token.trim()
                s.syncApi = ''
                updateSettings({ syncRepo: out.repo, syncToken: token.trim(), syncApi: '' })
                token = ''
                choices = []
                connectNote = out.private ? '' : `${out.repo} is public: anyone can read the sessions synced there.`
            }
        } finally {
            connecting = false
        }
    }

    /** What a change to the vault was refused for, a line each.
     *  @param {unknown} e */
    const refusal = (e) => (e instanceof VaultError ? e.errors : [errorText(e)])
    /** Origins as typed, one per line. @param {string} text */
    const lines = (text) => text.split('\n')
    /** A refusal's lines, scrolled to once they render.
     *  @param {() => HTMLElement | undefined} el */
    const reveal = (el) => void tick().then(() => el()?.scrollIntoView({ block: 'nearest' }))

    /** A key being added. */
    let draft = $state({ label: '', value: '', origins: '' })
    /** @type {string[]} */
    let addErrors = $state([])
    /** @type {HTMLElement | undefined} */
    let addErrorsEl = $state()
    function addKey() {
        try {
            vault.add({ label: draft.label, value: draft.value, origins: lines(draft.origins) })
            draft = { label: '', value: '', origins: '' }
            addErrors = []
        } catch (e) {
            addErrors = refusal(e)
            reveal(() => addErrorsEl)
        }
    }

    /** The key being edited, if one is. @type {string | null} */
    let editing = $state(null)
    /** Its fields: `value` a new key, or empty to keep it. */
    let edited = $state({ label: '', origins: '', value: '' })
    /** @type {string[]} */
    let editErrors = $state([])
    /** @type {HTMLElement | undefined} */
    let editErrorsEl = $state()
    /** The key whose delete waits on a yes. @type {string | null} */
    let confirming = $state(null)
    /** @param {import('./vault.svelte.js').VaultEntry} entry */
    function edit(entry) {
        editing = entry.id
        edited = { label: entry.label, origins: entry.origins.join('\n'), value: '' }
        editErrors = []
        confirming = null
    }
    function saveEdit() {
        if (editing === null) return
        try {
            vault.update(editing, { label: edited.label, origins: lines(edited.origins), ...(edited.value.trim() !== '' && { value: edited.value }) })
            closeEdit()
        } catch (e) {
            editErrors = refusal(e)
            reveal(() => editErrorsEl)
        }
    }
    /** Leave the key being edited, its fields (a new key typed) dropped. */
    function closeEdit() {
        editing = null
        edited = { label: '', origins: '', value: '' }
        editErrors = []
    }
    /** @param {string} id */
    function removeKey(id) {
        vault.remove(id)
        confirming = null
    }

    /** Entry `id`'s name for agents, being typed (`agentNaming` the
     *  entry), and what it was refused for. */
    let agentNaming = $state(/** @type {string | null} */ (null))
    let agentName = $state('')
    /** @type {string[]} */
    let agentErrors = $state([])
    /** A name for agents from a label: "Stripe (personal)" is
     *  STRIPE_PERSONAL. @param {string} label */
    const suggestName = (label) =>
        label
            .toUpperCase()
            .replace(/[^A-Z0-9]+/g, '_')
            .replace(/^[^A-Z]+|_+$/g, '')
    /** @param {import('./vault.svelte.js').VaultEntry} entry @param {boolean} on */
    function toggleAgents(entry, on) {
        agentErrors = []
        if (on) {
            agentNaming = entry.id
            agentName = entry.agentName ?? suggestName(entry.label)
            return
        }
        agentNaming = null
        if (entry.agentName !== undefined) vault.setAgentName(entry.id, null)
    }
    function saveAgentName() {
        if (agentNaming === null) return
        try {
            vault.setAgentName(agentNaming, agentName.trim())
            agentNaming = null
            agentErrors = []
        } catch (e) {
            agentErrors = refusal(e)
        }
    }
    /** A session's title, for its agent's grants; null when it's gone.
     *  @param {string} name */
    function sessionTitle(name) {
        const found = studio.sessions.find((x) => x.name === name)
        return found === undefined ? null : found.title || 'Untitled'
    }

    /** An app's name, from the sessions it is open in; null when none is
     *  left. @param {string} appKey */
    function appName(appKey) {
        const titles = [...new Set(sessionsOf(appKey, studio.sessions).map((x) => x.title || 'Untitled'))]
        return titles.length === 0 ? null : titles.join(', ')
    }
    /** The apps and sessions' agents using entry `id`, named, for a
     *  delete's question. @param {string} id */
    function usersOf(id) {
        const apps = vault.usedBy(id).map((u) => appName(u.appKey) ?? 'a removed app')
        const agents = vault.agentsUsing(id).map((u) => `${sessionTitle(u.session) ?? 'a removed session'}'s agent`)
        return [...new Set([...apps, ...agents])]
    }

    function disconnect() {
        s.syncRepo = ''
        s.syncToken = ''
        s.syncApi = ''
        updateSettings({ syncRepo: '', syncToken: '', syncApi: '' })
        connectNote = ''
    }
</script>

<Dialog label="Settings" {onClose}>
    {#snippet head()}
        <div class="tabs" role="tablist">
            <button role="tab" class="tab" class:on={tab === 'model'} aria-selected={tab === 'model'} onclick={() => (tab = 'model')}>Model</button>
            <button role="tab" class="tab" class:on={tab === 'notify'} aria-selected={tab === 'notify'} onclick={() => (tab = 'notify')}>Notifications</button>
            <button role="tab" class="tab" class:on={tab === 'sync'} aria-selected={tab === 'sync'} onclick={() => (tab = 'sync')}>Sync &amp; sharing</button>
            <button role="tab" class="tab" class:on={tab === 'keys'} aria-selected={tab === 'keys'} onclick={() => (tab = 'keys')}>Keys</button>
        </div>
    {/snippet}

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
                <input class="input" type="password" bind:value={s.routerKey} placeholder="sk-or-…" autocomplete="off" />
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
                <input class="input" bind:value={s.baseUrl} placeholder="http://localhost:3456" />
            </label>
            <label class="row">
                <span class="name">Shape</span>
                <select class="input" bind:value={s.wire}>
                    <option value="anthropic">Anthropic (Messages API, Meridian)</option>
                    <option value="openai">OpenAI-compatible</option>
                </select>
            </label>
            <label class="row">
                <span class="name">Key</span>
                <input class="input" type="password" bind:value={s.endpointKey} placeholder="if the endpoint needs one" autocomplete="off" />
            </label>
            <label class="row">
                <span class="name">Model</span>
                <input class="input" bind:value={s.endpointModel} placeholder="the endpoint's name for it" />
            </label>
        {/if}

        {#if s.accessMode !== 'scripted'}
            <label class="row">
                <span class="name">Thinking</span>
                {#if info !== null && !info.reasoning}
                    <span class="hint inline">Doesn't apply: this model doesn't reason</span>
                {:else}
                    <select class="input" bind:value={s.thinking}>
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
                                    <select class="input" disabled><option>Loading its providers…</option></select>
                                {:else if endpoints !== null && endpoints.list !== null}
                                    {@const list = endpoints.list}
                                    <select class="input" value={route.provider ?? ''} onchange={(e) => setRoute({ provider: e.currentTarget.value || null })}>
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
                                    <select class="input" value={route.sort ?? ''} onchange={(e) => setRoute({ sort: /** @type {'price' | 'throughput' | 'latency' | ''} */ (e.currentTarget.value) || null })}>
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
                        <select class="input" bind:value={s.foldBudget} title="Past this size, the conversation's earlier part is folded into a summary for the model; the chat still shows all of it.">
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
                                <input class="input" type="password" bind:value={s.routerKey} placeholder="optional · sk-or-…" autocomplete="off" />
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
    {:else if tab === 'keys'}
        <h3>Your keys</h3>
        <p class="hint">Keys you give apps and your agents for other services, like Stripe. They're kept on this device only: not synced, not published, never shown to an app or an agent. One is used only once you grant it, or make it available to your agents, and only with the origins listed. Changes here are kept at once, without waiting for Save.</p>
        {#if vault.entries.length === 0}
            <p class="hint">No keys yet.</p>
        {:else}
            <ul class="keys">
                {#each vault.entries as entry (entry.id)}
                    {@const users = vault.usedBy(entry.id)}
                    {@const agents = vault.agentsUsing(entry.id)}
                    <li class="key">
                        {#if editing === entry.id}
                            <form class="fields" aria-label="Edit {entry.label}" onsubmit={(e) => (e.preventDefault(), saveEdit())}>
                                <label class="row">
                                    <span class="name">Label</span>
                                    <input class="input" bind:value={edited.label} autocomplete="off" />
                                </label>
                                <label class="row">
                                    <span class="name">Origins</span>
                                    <textarea class="input" rows="2" bind:value={edited.origins} spellcheck="false"></textarea>
                                </label>
                                <label class="row">
                                    <span class="name">Replace key</span>
                                    <input class="input" type="password" bind:value={edited.value} placeholder="empty keeps the saved key" autocomplete="off" />
                                </label>
                                {#if editErrors.length > 0}
                                    <ul class="hint warn errors" role="alert" bind:this={editErrorsEl}>{#each editErrors as err, i (i)}<li>{err}</li>{/each}</ul>
                                {/if}
                                <div class="actions-row">
                                    <button class="btn secondary" type="submit">Save key</button>
                                    <button class="btn secondary" type="button" onclick={closeEdit}>Cancel</button>
                                </div>
                            </form>
                        {:else}
                            <div class="key-head">
                                <span class="key-label">{entry.label}</span>
                                <span class="hint">key saved</span>
                            </div>
                            <p class="hint">Goes to {#each entry.origins as origin, i (origin)}{i > 0 ? ', ' : ''}<code>{origin}</code>{/each}</p>
                            <label class="check" title="Every session's agent has it, by this name, for its origins.">
                                <input type="checkbox" checked={entry.agentName !== undefined || agentNaming === entry.id} onchange={(e) => toggleAgents(entry, e.currentTarget.checked)} />
                                Available to my agents{#if entry.agentName !== undefined && agentNaming !== entry.id}&nbsp;as <code>{entry.agentName}</code>{/if}
                            </label>
                            {#if agentNaming === entry.id}
                                <form class="actions-row" aria-label="Name {entry.label} for agents" onsubmit={(e) => (e.preventDefault(), saveAgentName())}>
                                    <input class="input" bind:value={agentName} placeholder="STRIPE_KEY" autocomplete="off" spellcheck="false" aria-label="Name for agents" />
                                    <button class="btn secondary small" type="submit">Save name</button>
                                    <button class="btn secondary small" type="button" onclick={() => ((agentNaming = null), (agentErrors = []))}>Cancel</button>
                                </form>
                                {#if agentErrors.length > 0}
                                    <ul class="hint warn errors" role="alert">{#each agentErrors as err, i (i)}<li>{err}</li>{/each}</ul>
                                {:else}
                                    <p class="hint">Agents write it as <code>${agentName.trim() || 'NAME'}</code> in curl, or <code>secret('{agentName.trim() || 'NAME'}')</code> in code.</p>
                                {/if}
                            {:else if entry.agentName !== undefined}
                                <div class="actions-row">
                                    <button class="btn secondary small" onclick={() => toggleAgents(entry, true)} aria-label="Rename {entry.label} for agents">Rename</button>
                                </div>
                            {/if}
                            {#if users.length === 0 && agents.length === 0}
                                <p class="hint">Not granted to an app or a session's agent yet.</p>
                            {:else}
                                <p class="hint">Granted to</p>
                                <ul class="users">
                                    {#each users as u (`${u.appKey} ${u.name}`)}
                                        {@const name = appName(u.appKey)}
                                        <li>
                                            <span class="hint">{#if name === null}a removed app{:else}{name}{/if}, as <code>{u.name}</code></span>
                                            <button class="btn secondary small" onclick={() => vault.revoke(u.appKey, u.name)} aria-label="Revoke {name ?? 'a removed app'}'s use of {entry.label} as {u.name}">Revoke</button>
                                        </li>
                                    {/each}
                                    {#each agents as u (`${u.session} ${u.name}`)}
                                        {@const name = `${sessionTitle(u.session) ?? 'a removed session'}'s agent`}
                                        <li>
                                            <span class="hint">{name}, as <code>{u.name}</code></span>
                                            <button class="btn secondary small" onclick={() => vault.revokeAgent(u.session, u.name)} aria-label="Revoke {name}'s use of {entry.label} as {u.name}">Revoke</button>
                                        </li>
                                    {/each}
                                </ul>
                            {/if}
                            {#if confirming === entry.id}
                                {@const apps = usersOf(entry.id)}
                                <p class="hint warn">Delete “{entry.label}”?{apps.length > 0 ? ` ${apps.join(', ')} ${apps.length === 1 ? 'uses' : 'use'} it, and will lose it.` : ''}</p>
                                <div class="actions-row">
                                    <button class="btn secondary danger" onclick={() => removeKey(entry.id)}>Delete it</button>
                                    <button class="btn secondary" onclick={() => (confirming = null)}>Keep it</button>
                                </div>
                            {:else}
                                <div class="actions-row">
                                    <button class="btn secondary small" onclick={() => edit(entry)} aria-label="Edit {entry.label}">Edit</button>
                                    <button class="btn secondary small" onclick={() => (closeEdit(), (confirming = entry.id))} aria-label="Delete {entry.label}">Delete…</button>
                                </div>
                            {/if}
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
        <h3>Add a key</h3>
        <form class="fields" aria-label="Add a key" onsubmit={(e) => (e.preventDefault(), addKey())}>
            <label class="row">
                <span class="name">Label</span>
                <input class="input" bind:value={draft.label} placeholder="Stripe (personal)" autocomplete="off" />
            </label>
            <label class="row">
                <span class="name">Key</span>
                <input class="input" type="password" bind:value={draft.value} placeholder="the key itself" autocomplete="off" />
            </label>
            <label class="row">
                <span class="name">Origins</span>
                <textarea class="input" rows="2" bind:value={draft.origins} placeholder="https://api.stripe.com" spellcheck="false"></textarea>
            </label>
            <div class="under"><p class="hint">Where the key may go, one per line: https: only, the origin alone.</p></div>
            {#if addErrors.length > 0}
                <ul class="hint warn errors" role="alert" bind:this={addErrorsEl}>{#each addErrors as err, i (i)}<li>{err}</li>{/each}</ul>
            {/if}
            <div class="actions-row">
                <button class="btn secondary" type="submit">Add key</button>
            </div>
        </form>
        <h3>Apps allowed your model</h3>
        <p class="hint">Apps from elsewhere that may run calls on your model and key. Your own apps use it without asking.</p>
        {#if Object.keys(vault.models).length === 0}
            <p class="hint">None yet.</p>
        {:else}
            <ul class="users">
                {#each Object.keys(vault.models) as appKey (appKey)}
                    {@const name = appName(appKey) ?? 'a removed app'}
                    <li>
                        <span class="hint">{name}</span>
                        <button class="btn secondary small" onclick={() => vault.revokeModel(appKey)} aria-label="Revoke {name}'s use of your model">Revoke</button>
                    </li>
                {/each}
            </ul>
        {/if}
        <h3>Sites your agents may open</h3>
        <p class="hint">
            The sites each session's agent may open in this browser's tabs, through the studio's extension, each with its subdomains. Its tabs load nothing else: a page that goes on to another site is stopped.
            {#if browserExtension.status === 'found'}The extension is here{browserExtension.version ? ` (${browserExtension.version})` : ''}.{:else if browserExtension.status === 'outdated'}<span class="warn-text">The extension here is out of date: {browserExtension.problem}</span>{:else}The extension isn't installed in this browser, so they open nothing until it is.{/if}
        </p>
        {#if Object.keys(vault.agentSites).length === 0}
            <p class="hint">None yet.</p>
        {:else}
            <ul class="users">
                {#each Object.entries(vault.agentSites) as [agent, domains] (agent)}
                    {@const session = agent.slice('agent:'.length)}
                    {@const name = `${sessionTitle(session) ?? 'a removed session'}'s agent`}
                    <li class="sites">
                        <span class="hint">{name}:</span>
                        {#each domains as domain (domain)}
                            <span class="site"><code>{domain}</code><button class="btn secondary small" onclick={() => vault.revokeSites(session, domain)} aria-label="Revoke {name}'s use of {domain}">×</button></span>
                        {/each}
                        {#if domains.length > 1}<button class="btn secondary small" onclick={() => vault.revokeSites(session)} aria-label="Revoke every site {name} may open">Revoke all</button>{/if}
                    </li>
                {/each}
            </ul>
        {/if}
        {#if browserExtension.status === 'found'}
            <h3>Tabs you shared</h3>
            <p class="hint">Each is usable only while it stays on the site you shared. Share a tab from the extension's toolbar button.</p>
            {#await sharedTabs}
                <p class="hint">Asking the extension…</p>
            {:then shared}
                {#if shared.length === 0}
                    <p class="hint">None.</p>
                {:else}
                    <ul class="users">
                        {#each shared as { session, tab } (tab.id)}
                            {@const name = sessionTitle(session) ?? 'a removed session'}
                            <li>
                                <span class="hint">{tab.title || tab.url} · <code>{tab.shared}</code> · {name}{tab.acts ? '' : ' · read only'}</span>
                                <button class="btn secondary small" onclick={() => setMode(session, tab.id, !tab.acts)} aria-label="{tab.acts ? 'Only let' : 'Let'} {name} {tab.acts ? 'read' : 'act in'} {tab.title || tab.url}">{tab.acts ? 'Only read' : 'Let it act'}</button>
                                <button class="btn secondary small" onclick={() => stopSharing(session, tab.id)} aria-label="Stop sharing {tab.title || tab.url} with {name}">Stop sharing</button>
                            </li>
                        {/each}
                    </ul>
                {/if}
            {:catch e}
                <p class="hint warn">{errorText(e)}</p>
            {/await}
        {/if}
    {:else}
        <h3>Sync</h3>
        {#if s.syncRepo}
            <p class="hint">Sessions sync through <code>{s.syncRepo}</code>{#if s.syncApi} on a stand-in for GitHub at <code>{s.syncApi}</code>{/if}: each one a few seconds after it changes, and every one when the studio opens or comes back into view. Apps' saved data syncs too.</p>
            {#if connectNote}<p class="hint warn">{connectNote}</p>{/if}
            <div class="actions-row">
                <button class="btn secondary" onclick={disconnect}>Disconnect</button>
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
                <input class="input" type="password" bind:value={token} placeholder="github_pat_…" autocomplete="off" />
            </label>
            {#if choices.length > 0}
                <label class="row">
                    <span class="name">Repo</span>
                    <select class="input" bind:value={chosen}>
                        {#each choices as c (c.repo)}<option value={c.repo}>{c.repo}{c.private ? '' : ' (public)'}</option>{/each}
                    </select>
                </label>
            {/if}
            {#if connectNote}<p class="hint warn">{connectNote}</p>{/if}
            <div class="actions-row">
                <button class="btn secondary" onclick={connect} disabled={connecting || token.trim() === ''}>{connecting ? 'Connecting…' : 'Connect'}</button>
                <span class="hint">Connects at once, without waiting for Save.</span>
            </div>
        {/if}
        <h3>Publishing</h3>
        <p class="hint">A session is published as a secret gist, which anyone with its link can open. It needs a token that can write gists: <a href={GIST_TOKEN_URL} target="_blank" rel="noreferrer">a classic one with the gist scope</a>, or a fine-grained one with Gists: read and write.{s.syncRepo ? ' Left empty, the sync token is tried.' : ''}</p>
        <label class="row">
            <span class="name">Token</span>
            <input class="input" type="password" bind:value={s.publishToken} placeholder="ghp_… or github_pat_…" autocomplete="off" />
        </label>
    {/if}

    {#snippet actions()}
        <button class="btn secondary" onclick={onClose}>Cancel</button>
        <button class="btn" onclick={save}>Save</button>
    {/snippet}
</Dialog>

<style>
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
        cursor: pointer;
    }
    .tab.on {
        color: var(--text);
        border-bottom-color: var(--accent);
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
        cursor: pointer;
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
    .btn.small {
        padding: 0.2rem 0.6rem;
        font-size: 0.8rem;
        white-space: nowrap;
    }
    .btn.danger {
        border-color: var(--error);
        color: var(--error);
    }
    .fields {
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }
    textarea.input {
        resize: vertical;
        font-family: var(--font-mono);
        font-size: 0.82rem;
    }
    .keys,
    .users,
    .errors {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .keys {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
    }
    .key {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.6rem 0.7rem;
    }
    .key-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 0.6rem;
    }
    .key-label {
        font-size: 0.9rem;
        color: var(--text);
        overflow-wrap: anywhere;
    }
    .users {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        margin-top: -0.2rem;
    }
    .users li {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.6rem;
    }
    .errors {
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
    }
    code {
        overflow-wrap: anywhere;
    }
    .users li.sites {
        flex-wrap: wrap;
        justify-content: flex-start;
        gap: 0.3rem 0.5rem;
    }
    .site {
        display: inline-flex;
        align-items: center;
        gap: 0.2rem;
        font-size: 0.8rem;
    }
</style>
