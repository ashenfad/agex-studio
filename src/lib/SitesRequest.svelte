<script>
    /**
     * The session's agent asks to open sites in its browser tabs
     * (`request_sites`): the domains, each ticked, and why. Allow grants
     * the ticked ones to this session's agent, each with its subdomains;
     * Not now answers the agent so its turn goes on.
     */
    import { untrack } from 'svelte'
    import AskCard from './AskCard.svelte'
    import { errorText } from './errors.js'
    import { siteRequests } from './site-requests.svelte.js'

    /** @type {{ session: string, question: import('./site-requests.svelte.js').SitesQuestion }} */
    let { session, question } = $props()

    /** The domains the person leaves ticked; all of them to begin with
     *  (the card is made again for each question). @type {Record<string, boolean>} */
    let ticked = $state(untrack(() => Object.fromEntries(question.domains.map((d) => [d, true]))))
    const allowed = $derived(question.domains.filter((d) => ticked[d]))
    /** @type {string[]} */
    let errors = $state([])

    function allow() {
        errors = []
        try {
            siteRequests.answer(session, allowed)
        } catch (e) {
            errors = [errorText(e)]
        }
    }
</script>

<AskCard why={question.why} {errors}>
    {#snippet title()}Your agent asks to open {question.domains.length === 1 ? 'a site' : `${question.domains.length} sites`} in this browser{/snippet}
    <ul class="domains">
        {#each question.domains as domain (domain)}
            <li><label><input type="checkbox" bind:checked={ticked[domain]} /> <code>{domain}</code></label></li>
        {/each}
    </ul>
    {#snippet note()}
        For this session and its delegates, in tabs of their own: pages on these domains and their subdomains, signed in wherever you are in this browser. A step there that books, pays or sends asks you first.
    {/snippet}
    {#snippet actions()}
        <button class="btn" onclick={allow} disabled={allowed.length === 0}>Allow {allowed.length === question.domains.length ? (allowed.length === 1 ? 'it' : 'them') : `${allowed.length}`}</button>
        <button class="btn secondary" onclick={() => siteRequests.answer(session, [])}>Not now</button>
    {/snippet}
</AskCard>

<style>
    .domains {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-wrap: wrap;
        gap: 0.2rem 0.9rem;
    }
    label {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
    }
</style>
