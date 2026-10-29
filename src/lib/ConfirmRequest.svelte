<script>
    /**
     * The session's agent asks before a step that reads as committing (a
     * booking, a payment, a message sent): what the step is, and on which
     * page. Yes takes it; No answers the agent that it may not.
     */
    import AskCard from './AskCard.svelte'
    import { browserAsks } from './browser-asks.svelte.js'

    /** @type {{ session: string, question: import('./browser-asks.svelte.js').ConfirmQuestion }} */
    let { session, question } = $props()
</script>

<AskCard why={question.step}>
    {#snippet title()}Your agent wants to take a step that may commit you{/snippet}
    <p class="page">On <strong>{question.title || 'a tab'}</strong> · <code>{question.url}</code></p>
    {#snippet note()}
        It acts in your browser, signed in as you: a booking, a payment or a message it sends is yours. Look at the tab first if you're not sure.
    {/snippet}
    {#snippet actions()}
        <button class="btn" onclick={() => browserAsks.answer(session, true)}>Yes, do it</button>
        <button class="btn secondary" onclick={() => browserAsks.answer(session, false)}>No</button>
    {/snippet}
</AskCard>

<style>
    .page {
        margin: 0;
        overflow-wrap: anywhere;
    }
</style>
