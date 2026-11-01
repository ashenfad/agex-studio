<script>
    /** The extension's page: the model the agent runs on (the studio's
     *  settings, kept in this extension's own storage and saved with
     *  Save), and the sites with a session. In the dev build, a turn can
     *  be tried here against a site's session. */
    import ModelSettings from '../../../../src/lib/ModelSettings.svelte'
    import { getSettings, isConfigured, updateSettings } from '../../../../src/lib/settings.js'
    import { loadModels, modelInfo, catalogStore } from '../../../../src/lib/openrouter-models.js'

    // the catalog's prices, for what each run cost (OpenRouter's models only)
    void loadModels().catch(() => {})

    let s = $state(getSettings())
    let saved = $state(getSettings())
    const changed = $derived(JSON.stringify(s) !== JSON.stringify(saved))

    function save() {
        updateSettings($state.snapshot(s))
        saved = getSettings()
    }

    /**
     * An op of the extension's service worker.
     * @param {string} op @param {Record<string, unknown>} [args]
     */
    async function ask(op, args = {}) {
        const reply = await chrome.runtime.sendMessage({ op, ...args })
        if (reply?.error !== undefined) throw new Error(reply.error)
        return reply?.value
    }

    /** @type {Promise<string[]>} */
    let sites = $state(ask('sites'))

    /** The site whose runs are open, and its log. */
    let open = $state(/** @type {string | null} */ (null))
    /** @type {Promise<any[]> | null} */
    let log = $state(null)
    /** @param {string} site */
    function toggle(site) {
        if (open === site) {
            open = null
            log = null
            return
        }
        open = site
        log = ask('log', { site })
    }

    /** A run's cost in dollars, from the catalog's prices for its model, or null when they aren't known.
     *  @param {{ models: string[], usage: { inputTokens: number, outputTokens: number } }} run */
    function costOf(run) {
        void $catalogStore
        const info = run.models.length === 1 ? modelInfo(run.models[0]) : null
        if (info === null || info.input === null || info.output === null) return null
        return (run.usage.inputTokens * info.input + run.usage.outputTokens * info.output) / 1e6
    }

    /** @param {number | null} at */
    const when = (at) => (at === null ? '' : new Date(at).toLocaleString())

    let trySite = $state('example.com')
    let tryPrompt = $state('Run some code that prints 6 * 7.')
    let trying = $state(false)
    /** @type {unknown} */
    let tried = $state(null)
    async function tryTurn() {
        trying = true
        tried = null
        try {
            tried = await ask('turn', { site: trySite, prompt: tryPrompt })
        } catch (e) {
            tried = { error: String(/** @type {Error} */ (e)?.message ?? e) }
        } finally {
            trying = false
            sites = ask('sites')
        }
    }
</script>

<main>
    <h1>Agex Site Filters</h1>

    <section>
        <h2>Model</h2>
        <p class="hint">The model the agent runs on, and its key. They're kept in this browser, in the extension's own storage, and the key goes only to the model's service.</p>
        <ModelSettings bind:settings={s} />
        <div class="actions">
            <button class="btn" onclick={save} disabled={!changed}>Save</button>
            {#if !isConfigured(saved)}<span class="hint warn-text">No model yet: the agent can't run until one is saved.</span>{/if}
        </div>
    </section>

    <section>
        <h2>Sites</h2>
        {#await sites}
            <p class="hint">…</p>
        {:then list}
            {#if list.length === 0}
                <p class="hint">None yet.</p>
            {:else}
                <ul class="sites">
                    {#each list as site (site)}
                        <li>
                            <button class="link" onclick={() => toggle(site)} aria-expanded={open === site}><code>{site}</code> {open === site ? '▾' : '▸'}</button>
                            {#if open === site && log !== null}
                                {#await log}
                                    <p class="hint">…</p>
                                {:then runs}
                                    {#if runs.length === 0}<p class="hint">No runs yet.</p>{/if}
                                    {#each runs as run (run.runId)}
                                        {@const cost = costOf(run)}
                                        <article class="run">
                                            <p class="hint">
                                                {when(run.startedAt)} · {run.status ?? 'running'} · {run.steps.length} {run.steps.length === 1 ? 'call' : 'calls'} ·
                                                {(run.usage.inputTokens + run.usage.outputTokens).toLocaleString()} tokens{cost === null ? '' : ` · about $${cost.toFixed(3)}`}
                                            </p>
                                            <p class="asked">{run.asked}</p>
                                            {#if run.steps.length > 0}
                                                <details>
                                                    <summary class="hint">What it did</summary>
                                                    {#each run.steps as stepDone, i (i)}
                                                        <div class="step" class:failed={stepDone.isError}>
                                                            <p class="hint">{stepDone.tool}{stepDone.isError ? ' · failed' : ''}</p>
                                                            <pre>{stepDone.args}</pre>
                                                            {#if stepDone.result !== ''}<pre class="result">{stepDone.result}</pre>{/if}
                                                        </div>
                                                    {/each}
                                                </details>
                                            {/if}
                                            {#if run.said !== ''}<p class="said">{run.said}</p>{/if}
                                        </article>
                                    {/each}
                                {:catch e}
                                    <p class="hint warn-text">{String(e?.message ?? e)}</p>
                                {/await}
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        {:catch e}
            <p class="hint warn-text">{String(e?.message ?? e)}</p>
        {/await}
    </section>

    {#if __DEV__}
        <section>
            <h2>Try a turn</h2>
            <p class="hint">Dev build only: a turn of a site's session on the saved model.</p>
            <label class="row"><span>Site</span><input class="input" bind:value={trySite} /></label>
            <label class="row"><span>Prompt</span><input class="input" bind:value={tryPrompt} /></label>
            <div class="actions"><button class="btn secondary" onclick={tryTurn} disabled={trying || changed}>{trying ? 'Running…' : 'Run'}</button></div>
            {#if tried !== null}<pre>{JSON.stringify(tried, null, 2)}</pre>{/if}
        </section>
    {/if}
</main>

<style>
    main {
        max-width: 44rem;
        margin: 2rem auto;
        padding: 0 1rem;
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }
    section {
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }
    .actions {
        display: flex;
        align-items: center;
        gap: 0.8rem;
    }
    .row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
    }
    .row span {
        min-width: 4rem;
    }
    .row input {
        flex: 1;
    }
    pre {
        white-space: pre-wrap;
        font-size: 0.8rem;
    }
    .sites {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
        gap: 0.6rem;
    }
    .link {
        background: none;
        border: 0;
        padding: 0;
        color: inherit;
        font: inherit;
        cursor: pointer;
    }
    .run {
        margin: 0.5rem 0 0 1rem;
        padding: 0.5rem 0.7rem;
        border-left: 2px solid var(--border);
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }
    .asked,
    .said {
        margin: 0;
        white-space: pre-wrap;
        font-size: 0.85rem;
    }
    .said {
        color: var(--text);
    }
    .step {
        margin: 0.4rem 0;
    }
    .step.failed pre.result {
        color: var(--caution, #d9a441);
    }
    .step pre {
        margin: 0.2rem 0;
        max-height: 12rem;
        overflow: auto;
    }
    .hint {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin: 0;
    }
    .warn-text {
        color: var(--caution, #d9a441);
    }
</style>
