<script>
    /**
     * The session's agent asks for a key (`request_secret`): its name,
     * where it goes and why, and a choice of the vault's entries that
     * cover those origins or a new key, which goes into the vault. Give it
     * grants the choice to this session's agent; Not now answers the agent
     * so its turn goes on. The key is typed here, never into a message.
     */
    import { untrack } from 'svelte'
    import AskCard from './AskCard.svelte'
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

<AskCard why={question.why} errors={errors}>
    {#snippet title()}Your agent asks for a key for {hosts} <code>{question.name}</code>{/snippet}
    <KeyChoice need={question} group="{uid}-key" bind:pick={() => pick, (v) => (picked = v)} bind:draft errors={fieldErrors} />
    {#snippet note()}
        Your agent can use it with {#each question.origins as origin, i (origin)}{i > 0 ? ', ' : ''}<code>{origin}</code>{/each} only, in this session and its delegates,
        and never sees it. A service there that echoes keys back could expose it.
    {/snippet}
    {#snippet actions()}
        <button class="btn" onclick={give}>Give it</button>
        <button class="btn secondary" onclick={() => keyRequests.answer(session, null)}>Not now</button>
    {/snippet}
</AskCard>
