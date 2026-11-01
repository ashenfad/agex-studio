<script>
    /**
     * Chrome's debugging bar was cancelled, which stops the agent's work
     * in every tab: the agent asks whether it may go on. Let it go on
     * lifts the stop; Keep it stopped answers the agent that it may not.
     */
    import AskCard from './AskCard.svelte'
    import { browserAsks } from './browser-asks.svelte.js'

    /** @type {{ session: string }} */
    let { session } = $props()
</script>

<AskCard why="Its Cancel stops your agent's work in every tab of this browser, not only one. If you didn't mean to stop it, let it go on.">
    {#snippet title()}Chrome's debugging bar was cancelled{/snippet}
    {#snippet note()}Chrome shows that bar while the agent works in a tab. To stop the agent's work, use Stop in the chat.{/snippet}
    {#snippet actions()}
        <button class="btn" onclick={() => browserAsks.answer(session, true)}>Let it go on</button>
        <button class="btn secondary" onclick={() => browserAsks.answer(session, false)}>Keep it stopped</button>
    {/snippet}
</AskCard>
