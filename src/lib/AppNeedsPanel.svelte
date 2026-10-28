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
    import KeyChoice from './KeyChoice.svelte'
    import { VaultError, checkNewKey, freshLabel, vault } from './vault.svelte.js'

    /** @type {{ session: string, question: import('./app-needs-ask.svelte.js').NeedsQuestion }} */
    let { session, question } = $props()

    const uid = $props.id()

    /** @typedef {import('./app-needs.js').SecretNeed} SecretNeed */

    /** The hosts of a need's origins, for its title. @param {SecretNeed} need */
    const hostsOf = (need) => need.origins.map((o) => new URL(o).host).join(', ')

    /** Each new key's fields, by the app's name for it, prefilled. */
    let drafts = $state(
        untrack(() => {
            const taken = new Set(vault.entries.map((e) => e.label.toLowerCase()))
            return Object.fromEntries(question.needs.secrets.map((need) => [need.name, { label: freshLabel(need.origins, taken), value: '', origins: need.origins.join('\n') }]))
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
            const fields = checkNewKey(drafts[need.name], need.origins, { taken, sentBy: 'this app' })
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
            <li>
                <p><strong>A key for {hostsOf(need)}</strong> <code>{need.name}</code></p>
                <p class="why">{need.why}</p>
                {#if granted !== null && !changing[need.name]}
                    <p>
                        <span class="met" aria-hidden="true">✓</span> using {granted.label}
                        <button class="secondary small" onclick={() => (changing[need.name] = true)} aria-label="Change the key for {need.name}">Change</button>
                    </p>
                {:else}
                    <KeyChoice
                        {need}
                        group="{uid}-{need.name}"
                        bind:pick={() => pickOf(need), (v) => (picks[need.name] = v)}
                        bind:draft={drafts[need.name]}
                        errors={fieldErrors[need.name] ?? []}
                        noneLabel="No key for now"
                    />
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
    .why {
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
