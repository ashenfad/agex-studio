<script>
    /** The model the studio talks to: OpenRouter or an endpoint of the
     *  person's own (a direct provider, a local Meridian, a proxy), the
     *  essentials up front and the rest under Advanced, summed up in a
     *  line. It edits the settings it's given and saves nothing: its
     *  host keeps them until its own Save (`updateSettings`). Its fields
     *  stand in a column of their own, so it needs no frame around it. */
    import { errorText } from './errors.js'
    import ModelPicker from './ModelPicker.svelte'
    import RouterKeyCheck from './RouterKeyCheck.svelte'
    import { WINDOW_SHARE, foldBudgetOf } from './model.js'
    import { catalogStore, contextLabel, modelInfo, priceLabel } from './openrouter-models.js'
    import { endpointLabel, loadEndpoints, routeOf, withRoute } from './openrouter-routing.js'

    /** `settings`: the settings being edited, a draft the host saves;
     *  its fields change in place.
     *  @type {{ settings: import('./settings.js').Settings }} */
    let { settings: s = $bindable() } = $props()

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
</script>

<div class="model">
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
</div>

<style>
    /* the fields in a column, spaced as a dialog's body spaces them */
    .model {
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
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
    .hint a {
        color: var(--accent);
    }
    .warn {
        color: var(--error);
    }
    .warn-text {
        color: var(--caution, #d9a441);
    }
</style>
