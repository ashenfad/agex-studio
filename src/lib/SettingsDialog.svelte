<script>
    /** The settings, in two tabs. Model: the model the studio talks to,
     *  OpenRouter or an endpoint of the person's own (a direct provider,
     *  a local Meridian, a proxy), and whether a turn that ends while
     *  they're away notifies them. Sync & sharing: syncing sessions
     *  through a GitHub repo of their own, and the token publishing
     *  writes gists with. */
    import { untrack } from 'svelte'
    import ModelPicker from './ModelPicker.svelte'
    import { WINDOW_SHARE, foldBudgetOf } from './model.js'
    import { contextLabel, loadModels, modelInfo, priceLabel } from './openrouter-models.js'
    import { getSettings, updateSettings } from './settings.js'
    import { GIST_TOKEN_URL } from './gist.js'
    import { notificationPermission, requestNotificationPermission } from './notify.js'
    import { NEW_REPO_URL, NEW_TOKEN_URL, connectSync, preferredRepo } from './sync-connect.js'

    /** @type {{ onClose: () => void, tab?: 'model' | 'sync' }} */
    let { onClose, tab: firstTab = 'model' } = $props()

    let tab = $state(untrack(() => firstTab))

    let permission = $state(notificationPermission())
    // notifications on only while the browser allows them (it may have stopped since)
    let s = $state({ ...getSettings(), ...(notificationPermission() !== 'granted' && { notifyOnFinish: false }) })

    /** Bumped once OpenRouter's catalog is at hand, so what's read off it
     *  is read again. */
    let catalogAt = $state(0)
    loadModels().then(() => (catalogAt += 1), () => {})
    /** What OpenRouter's catalog says of the model chosen there; null for
     *  another service, or a model it doesn't list. */
    const info = $derived((void catalogAt, s.accessMode === 'openrouter' ? modelInfo(s.routerModel) : null))
    /** The chosen model's facts, in a line. */
    const facts = $derived(
        info === null
            ? ''
            : [
                  info.name,
                  info.context !== null ? `${contextLabel(info.context)} context` : null,
                  info.input !== null ? `${priceLabel(info.input)} in, ${priceLabel(info.output)} out per million tokens` : null,
                  info.images ? 'takes images' : 'text only',
              ]
                  .filter((part) => part !== null)
                  .join(' · '),
    )

    function save() {
        updateSettings({ ...s })
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

<div class="backdrop" role="presentation" onclick={onClose}>
    <div class="dialog" role="dialog" aria-label="Settings" tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.key === 'Escape' && onClose()}>
        <div class="head">
            <h2>Settings</h2>
            <div class="tabs" role="tablist">
                <button role="tab" class="tab" class:on={tab === 'model'} aria-selected={tab === 'model'} onclick={() => (tab = 'model')}>Model</button>
                <button role="tab" class="tab" class:on={tab === 'sync'} aria-selected={tab === 'sync'} onclick={() => (tab = 'sync')}>Sync &amp; sharing</button>
            </div>
        </div>
        {#if tab === 'model'}
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
        {#if s.accessMode === 'custom'}
            <label>
                Key
                <input type="password" bind:value={s.endpointKey} placeholder="if the endpoint needs one" autocomplete="off" />
            </label>
        {/if}
        {#if s.accessMode !== 'scripted'}
            <label>
                {s.accessMode === 'custom' ? 'OpenRouter key (optional)' : 'Key'}
                <input type="password" bind:value={s.routerKey} placeholder="sk-or-…" autocomplete="off" />
            </label>
            {#if s.accessMode === 'openrouter'}
                <p class="hint">Make one at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>. It stays in this browser, and goes only to OpenRouter.</p>
            {:else}
                <p class="hint">For the agent's web search and its images, speech and music, which run on OpenRouter whatever the model. It goes only to OpenRouter, never to the endpoint above.</p>
            {/if}
            {#if s.accessMode === 'openrouter'}
                <div class="field">
                    <span>Model</span>
                    <ModelPicker bind:value={s.routerModel} />
                </div>
                {#if info !== null}
                    <p class="hint">
                        {facts}{#if !info.tools}<span class="warn-text">{' · '}can't call tools, so the agent can't work with it</span>{/if}
                    </p>
                {:else if s.routerModel.trim() !== ''}
                    <p class="hint">Not in OpenRouter's list as far as the studio knows: it's used as typed.</p>
                {/if}
            {:else}
                <label>
                    Model
                    <input bind:value={s.endpointModel} placeholder="the endpoint's name for it" />
                </label>
            {/if}
            <label>
                Thinking
                <select bind:value={s.thinking} disabled={info !== null && !info.reasoning}>
                    <option value="off">off</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                </select>
            </label>
            {#if info !== null && !info.reasoning}
                <p class="hint">This model doesn't reason, so thinking doesn't apply.</p>
            {/if}
            {#if info === null}
                <label class="check">
                    <input type="checkbox" bind:checked={s.vision} />
                    The model takes images (screenshots of its apps)
                </label>
            {/if}
            <label>
                Fold the conversation past (tokens; 0 never folds)
                <input type="number" min="0" step="1000" bind:value={s.foldBudget} />
            </label>
            {#if info !== null && info.context !== null && s.foldBudget > 0 && foldBudgetOf(s) < s.foldBudget}
                <p class="hint">The model's window holds {contextLabel(info.context)}, so it folds by {contextLabel(foldBudgetOf(s))} ({Math.round(WINDOW_SHARE * 100)}% of it), leaving room to reply.</p>
            {/if}
        {/if}
        <h3>Notifications</h3>
        <label class="check">
            <input type="checkbox" bind:checked={s.notifyOnFinish} onchange={notifyChanged} disabled={permission === 'unsupported' || permission === 'denied'} />
            Notify me when a turn ends while I'm away
        </label>
        {#if permission === 'denied'}
            <p class="hint warn">This browser blocks notifications from the studio. Allow them in its settings for this site, then reopen this dialog.</p>
        {:else if permission === 'unsupported'}
            <p class="hint warn">This browser doesn't show notifications.</p>
        {:else if asked && permission !== 'granted'}
            <p class="hint warn">The browser didn't allow them, so they stay off.</p>
        {/if}
        <p class="hint">Away: in another session, another tab or another app. They come only while the studio's tab is open. Apps can show notifications too, once you've allowed them here.</p>
        {:else}
        <h3>Sync</h3>
        {#if s.syncRepo}
            <p class="hint">Sessions sync through <code>{s.syncRepo}</code>: each one a few seconds after it changes, and every one when the studio opens or comes back into view.</p>
            {#if connectNote}<p class="hint warn">{connectNote}</p>{/if}
            <div class="row">
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
            <label>
                Token
                <input type="password" bind:value={token} placeholder="github_pat_…" autocomplete="off" />
            </label>
            {#if choices.length > 0}
                <label>
                    Repo
                    <select bind:value={chosen}>
                        {#each choices as c (c.repo)}<option value={c.repo}>{c.repo}{c.private ? '' : ' (public)'}</option>{/each}
                    </select>
                </label>
            {/if}
            {#if connectNote}<p class="hint warn">{connectNote}</p>{/if}
            <div class="row">
                <button class="secondary" onclick={connect} disabled={connecting || token.trim() === ''}>{connecting ? 'Connecting…' : 'Connect'}</button>
            </div>
        {/if}
        <h3>Publishing</h3>
        <p class="hint">A session is published as a secret gist, which anyone with its link can open. Publishing needs a token that can write gists: <a href={GIST_TOKEN_URL} target="_blank" rel="noreferrer">a classic one with the gist scope</a>, or a fine-grained one with Gists: read and write.{s.syncRepo ? ' Left empty, the sync token is tried.' : ''}</p>
        <label>
            Token
            <input type="password" bind:value={s.publishToken} placeholder="ghp_… or github_pat_…" autocomplete="off" />
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
        /* the modal layer: above the drawer, the switch button, the pill */
        z-index: 50;
    }
    .dialog {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        padding: 1.2rem;
        width: min(28rem, 92vw);
        max-height: 90vh;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }
    .head {
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
        border-bottom: 1px solid var(--border);
    }
    h2 {
        font-family: var(--font-display);
        font-size: 1.2rem;
    }
    h3 {
        font-family: var(--font-body);
        font-size: 0.75rem;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        color: var(--text-muted);
        margin-top: 0.3rem;
    }
    .tabs {
        display: flex;
        gap: 1rem;
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
    label {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        font-size: 0.85rem;
        color: var(--text-muted);
    }
    .warn-text {
        color: var(--caution, #d9a441);
    }
    .check {
        flex-direction: row;
        align-items: center;
        gap: 0.5rem;
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
    .secondary:disabled {
        opacity: 0.5;
        cursor: default;
    }
    .hint {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin: 0;
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
    .row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }
</style>
