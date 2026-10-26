<script>
    /**
     * "This app needs…": what an app asks of the person viewing it, its
     * model and a key for each service it declares, answered once and
     * kept in the vault.
     *
     * The model is met (✓) for the person's own app or one allowed
     * before; otherwise allowing it lets the app's calls run on their
     * model and key. A key already granted shows the entry it uses, and
     * can be changed; one not granted offers the vault's entries whose
     * origins cover the app's, a new key (added to the vault, its
     * origins covering the app's), or none, which leaves the app's calls
     * needing it refused. Allow keeps what is chosen; Don't allow
     * refuses the calls waiting.
     */
    import { tick, untrack } from 'svelte'
    import { needsAsk } from './app-needs-ask.svelte.js'
    import { errorText } from './errors.js'
    import { VaultError, checkFields, vault } from './vault.svelte.js'

    /** @type {{ session: string, question: import('./app-needs-ask.svelte.js').NeedsQuestion }} */
    let { session, question } = $props()

    const uid = $props.id()

    /** @typedef {import('./app-needs.js').SecretNeed} SecretNeed */

    /** The hosts of a need's origins, for its title. @param {SecretNeed} need */
    const hostsOf = (need) => need.origins.map((o) => new URL(o).host).join(', ')

    /** A label for a new key that neither an entry nor another draft
     *  has: its service's host, then numbered.
     *  @param {SecretNeed} need @param {Set<string>} taken lower-cased, and added to */
    function freshLabel(need, taken) {
        const host = new URL(need.origins[0]).host
        let label = host
        for (let n = 2; taken.has(label.toLowerCase()); n++) label = `${host} ${n}`
        taken.add(label.toLowerCase())
        return label
    }

    /** Each new key's fields, by the app's name for it, prefilled. */
    let drafts = $state(
        untrack(() => {
            const taken = new Set(vault.entries.map((e) => e.label.toLowerCase()))
            return Object.fromEntries(question.needs.secrets.map((need) => [need.name, { label: freshLabel(need, taken), value: '', origins: need.origins.join('\n') }]))
        }),
    )
    /** The choice made for each key not granted: an entry's id, `new`,
     *  or `none`. @type {Record<string, string>} */
    let picks = $state({})
    /** The keys granted that the person is changing. @type {Record<string, true>} */
    let changing = $state({})
    /** What Allow was refused for, a line each: each new key's under
     *  it, by the app's name for it, and the vault's. @type {Record<string, string[]>} */
    let fieldErrors = $state({})
    /** @type {string[]} */
    let errors = $state([])

    /** @type {HTMLElement | undefined} */
    let panel = $state()

    const showModel = $derived(question.model || question.needs.model)
    const modelMet = $derived(question.own || vault.modelAllowed(question.appKey))

    /** The entry granted for `need` that still serves it, or null.
     *  @param {SecretNeed} need */
    function grantedFor(need) {
        const id = vault.grants[question.appKey]?.[need.name]
        return vault.entriesCovering(need.origins).find((e) => e.id === id) ?? null
    }

    /** What is chosen for `need`: as picked, else the first entry that
     *  covers it, else a new key. @param {SecretNeed} need */
    function pickOf(need) {
        return picks[need.name] ?? grantedFor(need)?.id ?? vault.entriesCovering(need.origins)[0]?.id ?? 'new'
    }

    function allow() {
        /** @type {Record<string, string[]>} */
        const wrong = {}
        /** @type {Record<string, string | null>} */
        const grants = {}
        /** @type {{ need: SecretNeed, fields: { label: string, value: string, origins: string[] } }[]} */
        const adds = []
        const taken = vault.entries.map((e) => e.label)
        for (const need of question.needs.secrets) {
            if (grantedFor(need) !== null && !changing[need.name]) continue
            const pick = pickOf(need)
            // no key: the grant it had, if any, goes
            if (pick === 'none') {
                grants[need.name] = null
                continue
            }
            if (pick !== 'new') {
                grants[need.name] = pick
                continue
            }
            const d = drafts[need.name]
            const fields = checkFields({ label: d.label, value: d.value, origins: d.origins.split('\n') }, { taken })
            const missing = need.origins.filter((o) => !fields.origins.includes(o))
            if (fields.origins.length > 0 && missing.length > 0) fields.errors.push(`origins: include ${missing.join(', ')}, where this app sends it`)
            if (fields.errors.length > 0) wrong[need.name] = fields.errors
            taken.push(fields.label)
            adds.push({ need, fields })
        }
        fieldErrors = wrong
        errors = []
        if (Object.keys(wrong).length > 0) {
            // the first refusal, scrolled to once it shows
            void tick().then(() => panel?.querySelector('[role=alert]')?.scrollIntoView({ block: 'nearest' }))
            return
        }
        try {
            for (const { need, fields } of adds) {
                const id = vault.add({ label: fields.label, value: fields.value, origins: fields.origins })
                // added: a second try uses it rather than adding it again
                picks[need.name] = id
                grants[need.name] = id
            }
            needsAsk.answer(session, grants)
        } catch (e) {
            errors = e instanceof VaultError ? e.errors : [errorText(e)]
        }
    }
</script>

<section class="panel" aria-labelledby="{uid}-title" bind:this={panel}>
    <h2 id="{uid}-title">This app needs…</h2>
    <ul class="needs">
        {#if showModel}
            <li>
                {#if modelMet}
                    <p><span class="met" aria-hidden="true">✓</span> Your model</p>
                {:else}
                    <p><strong>Your model.</strong> Its calls run on your model and key, and show on the agent meter above the app.</p>
                {/if}
            </li>
        {/if}
        {#each question.needs.secrets as need (need.name)}
            {@const granted = grantedFor(need)}
            {@const covering = vault.entriesCovering(need.origins)}
            {@const pick = pickOf(need)}
            <li>
                <p><strong>A key for {hostsOf(need)}</strong> <code>{need.name}</code></p>
                <p class="why">{need.why}</p>
                {#if granted !== null && !changing[need.name]}
                    <p>
                        <span class="met" aria-hidden="true">✓</span> using {granted.label}
                        <button class="secondary small" onclick={() => (changing[need.name] = true)} aria-label="Change the key for {need.name}">Change</button>
                    </p>
                {:else}
                    <fieldset class="choices">
                        <legend class="hidden">Key for {need.name}</legend>
                        {#each covering as entry (entry.id)}
                            <label><input type="radio" name="{uid}-{need.name}" checked={pick === entry.id} onchange={() => (picks[need.name] = entry.id)} /> Use {entry.label}</label>
                        {/each}
                        <label><input type="radio" name="{uid}-{need.name}" checked={pick === 'new'} onchange={() => (picks[need.name] = 'new')} /> Add a new key</label>
                        <label><input type="radio" name="{uid}-{need.name}" checked={pick === 'none'} onchange={() => (picks[need.name] = 'none')} /> No key for now</label>
                    </fieldset>
                    {#if pick === 'new'}
                        <div class="fields">
                            <label>
                                <span>Label</span>
                                <input class="input" bind:value={drafts[need.name].label} autocomplete="off" />
                            </label>
                            <label>
                                <span>Key</span>
                                <input class="input" type="password" bind:value={drafts[need.name].value} autocomplete="off" />
                            </label>
                            <label class="wide">
                                <span>Origins</span>
                                <textarea class="input" rows={Math.max(1, need.origins.length)} bind:value={drafts[need.name].origins} spellcheck="false"></textarea>
                            </label>
                            <p class="hint wide">Kept on this device only.</p>
                            {#if fieldErrors[need.name]}
                                <ul class="errors wide" role="alert">
                                    {#each fieldErrors[need.name] as e, i (i)}<li>{e}</li>{/each}
                                </ul>
                            {/if}
                        </div>
                    {/if}
                {/if}
                <p class="warn">
                    This app can use the key with {#each need.origins as origin, i (origin)}{i > 0 ? ', ' : ''}<code>{origin}</code>{/each} only, in its
                    <code>{need.header}</code> header. A service there that echoes keys back could expose it.
                </p>
            </li>
        {/each}
    </ul>
    <div class="foot">
        {#if errors.length > 0}
            <ul class="errors" role="alert">
                {#each errors as e, i (i)}<li>{e}</li>{/each}
            </ul>
        {/if}
        <div class="actions">
            <button onclick={allow}>Allow</button>
            <button class="secondary" onclick={() => needsAsk.answer(session, null)}>Don't allow</button>
        </div>
    </div>
</section>

<style>
    .panel {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    h2 {
        margin: 0;
        font-size: 0.9rem;
        font-weight: 600;
    }
    .needs,
    .errors {
        list-style: none;
        margin: 0;
        padding: 0;
    }
    .needs {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }
    .needs > li {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.45rem 0.6rem;
    }
    p {
        margin: 0;
    }
    .met {
        color: var(--success);
    }
    .why,
    .hint {
        color: var(--text-muted);
    }
    .warn {
        color: var(--caution, #d9a441);
        font-size: 0.8rem;
    }
    code {
        font-family: var(--font-mono);
        font-size: 0.8rem;
        overflow-wrap: anywhere;
    }
    .choices {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem 1rem;
        margin: 0;
        padding: 0;
        border: none;
    }
    .choices label {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        cursor: pointer;
    }
    .hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
    .fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
        gap: 0.35rem 0.6rem;
        max-width: 36rem;
    }
    .fields .wide {
        grid-column: 1 / -1;
    }
    .fields label {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        font-size: 0.8rem;
        color: var(--text-muted);
    }
    .fields textarea {
        resize: vertical;
        font-family: var(--font-mono);
        font-size: 0.8rem;
    }
    .small {
        margin-left: 0.4rem;
    }
    .errors {
        color: var(--error);
        font-size: 0.8rem;
    }
    /* the buttons stay in view while the needs above them scroll */
    .foot {
        position: sticky;
        bottom: 0;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        padding: 0.4rem 0 0.6rem;
        background: var(--surface);
    }
    .actions {
        display: flex;
        gap: 0.5rem;
    }
</style>
