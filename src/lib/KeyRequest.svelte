<script>
    /**
     * The session's agent asks for a key (`request_secret`): its name,
     * where it goes and why, and a choice of the vault's entries that
     * cover those origins or a new key, which goes into the vault. Give it
     * grants the choice to this session's agent; Not now answers the agent
     * so its turn goes on. The key is typed here, never into a message.
     */
    import { untrack } from 'svelte'
    import { errorText } from './errors.js'
    import KeyChoice from './KeyChoice.svelte'
    import { keyRequests } from './key-requests.svelte.js'
    import { VaultError, checkNewKey, freshLabel, vault } from './vault.svelte.js'

    /** @type {{ session: string, question: import('./key-requests.svelte.js').KeyQuestion }} */
    let { session, question } = $props()

    const uid = $props.id()

    /** The new key's fields, prefilled. */
    let draft = $state(
        untrack(() => ({
            label: freshLabel(question.origins, new Set(vault.entries.map((e) => e.label.toLowerCase()))),
            value: '',
            origins: question.origins.join('\n'),
        })),
    )
    /** An entry's id or `new`; unpicked, the first entry that covers the
     *  request, else a new key. @type {string | null} */
    let picked = $state(null)
    const pick = $derived(picked ?? vault.entriesCovering(question.origins)[0]?.id ?? 'new')
    /** @type {string[]} */
    let fieldErrors = $state([])
    /** @type {string[]} */
    let errors = $state([])

    const hosts = $derived(question.origins.map((o) => new URL(o).host).join(', '))

    function give() {
        fieldErrors = []
        errors = []
        let id = pick
        if (id === 'new') {
            const fields = checkNewKey(draft, question.origins, { taken: vault.entries.map((e) => e.label), sentBy: 'your agent' })
            if (fields.errors.length > 0) {
                fieldErrors = fields.errors
                return
            }
            try {
                id = vault.add({ label: fields.label, value: fields.value, origins: fields.origins })
                // added: a second try uses it rather than adding it again
                picked = id
            } catch (e) {
                errors = e instanceof VaultError ? e.errors : [errorText(e)]
                return
            }
        }
        try {
            keyRequests.answer(session, id)
        } catch (e) {
            errors = e instanceof VaultError ? e.errors : [errorText(e)]
        }
    }
</script>

<section class="request" aria-labelledby="{uid}-title">
    <h2 id="{uid}-title">Your agent asks for a key for {hosts} <code>{question.name}</code></h2>
    <p class="why">{question.why}</p>
    <KeyChoice need={question} group="{uid}-key" bind:pick={() => pick, (v) => (picked = v)} bind:draft errors={fieldErrors} />
    <p class="warn">
        Your agent can use it with {#each question.origins as origin, i (origin)}{i > 0 ? ', ' : ''}<code>{origin}</code>{/each} only, in this session and its delegates,
        and never sees it. A service there that echoes keys back could expose it.
    </p>
    {#if errors.length > 0}
        <ul class="errors" role="alert">
            {#each errors as e, i (i)}<li>{e}</li>{/each}
        </ul>
    {/if}
    <div class="actions">
        <button onclick={give}>Give it</button>
        <button class="secondary" onclick={() => keyRequests.answer(session, null)}>Not now</button>
    </div>
</section>

<style>
    .request {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.6rem 0.7rem;
        margin: 0.5rem 0;
        background: var(--surface);
    }
    h2 {
        margin: 0;
        font-size: 0.9rem;
        font-weight: 600;
    }
    p {
        margin: 0;
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
    .errors {
        list-style: none;
        margin: 0;
        padding: 0;
        color: var(--error);
        font-size: 0.8rem;
    }
    .actions {
        display: flex;
        gap: 0.5rem;
    }
</style>
