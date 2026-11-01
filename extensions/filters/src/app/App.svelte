<script>
    /** The extension's page: the model the agent runs on (the studio's
     *  settings, kept in this extension's own storage and saved with
     *  Save), and the sites with a session. In the dev build, a turn can
     *  be tried here against a site's session. */
    import ModelSettings from '../../../../src/lib/ModelSettings.svelte'
    import { getSettings, isConfigured, updateSettings } from '../../../../src/lib/settings.js'

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
                <ul>{#each list as site (site)}<li><code>{site}</code></li>{/each}</ul>
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
    .hint {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin: 0;
    }
    .warn-text {
        color: var(--caution, #d9a441);
    }
</style>
