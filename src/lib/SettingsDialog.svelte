<script>
    /** The model the studio talks to: OpenRouter, or an endpoint of the
     *  person's own (a direct provider, a local Meridian, a proxy); and
     *  syncing sessions through a GitHub repo of their own. */
    import { getSettings, updateSettings } from './settings.js'
    import { GIST_TOKEN_URL } from './gist.js'
    import { NEW_REPO_URL, NEW_TOKEN_URL, connectSync, preferredRepo } from './sync-connect.js'

    /** @type {{ onClose: () => void }} */
    let { onClose } = $props()

    let s = $state({ ...getSettings() })

    function save() {
        updateSettings({ ...s })
        onClose()
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
            <label class="check">
                <input type="checkbox" bind:checked={s.vision} />
                The model takes images (screenshots of its apps)
            </label>
            <label>
                Fold the conversation past (tokens; 0 never folds)
                <input type="number" min="0" step="1000" bind:value={s.foldBudget} />
            </label>
        {/if}
        <h2>Sync</h2>
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
        <h2>Publishing</h2>
        <p class="hint">A session is published as a secret gist, which anyone with its link can open. Publishing needs a token that can write gists: <a href={GIST_TOKEN_URL} target="_blank" rel="noreferrer">a classic one with the gist scope</a>, or a fine-grained one with Gists: read and write.{s.syncRepo ? ' Left empty, the sync token is tried.' : ''}</p>
        <label>
            Token
            <input type="password" bind:value={s.publishToken} placeholder="ghp_… or github_pat_…" autocomplete="off" />
        </label>
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
