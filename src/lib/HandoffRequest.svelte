<script>
    /**
     * The session's agent asks for the person's hands on one of its tabs
     * (a CAPTCHA, a login, a second factor), which was brought to the
     * front. Done tells the agent to go on there; Skip that it won't be.
     */
    import AskCard from './AskCard.svelte'
    import { browser } from './browser.js'
    import { browserAsks } from './browser-asks.svelte.js'
    import { errorText } from './errors.js'

    /** @type {{ session: string, question: import('./browser-asks.svelte.js').HandoffQuestion }} */
    let { session, question } = $props()

    /** @type {string[]} */
    let errors = $state([])

    async function show() {
        errors = []
        try {
            await browser.show(session, question.tab)
        } catch (e) {
            errors = [errorText(e)]
        }
    }
</script>

<AskCard why={question.what} {errors}>
    {#snippet title()}Your agent needs your hands in a tab{/snippet}
    <p class="page">On <strong>{question.title || 'a tab'}</strong> · <code>{question.url}</code>. It's in front now; come back here when you're done.</p>
    {#snippet note()}The agent waits, and doesn't act in the tab until you say.{/snippet}
    {#snippet actions()}
        <button class="btn" onclick={() => browserAsks.answer(session, true)}>Done</button>
        <button class="btn secondary" onclick={show}>Show the tab</button>
        <button class="btn secondary" onclick={() => browserAsks.answer(session, false)}>Skip</button>
    {/snippet}
</AskCard>

<style>
    .page {
        margin: 0;
        overflow-wrap: anywhere;
    }
</style>
