<script>
    /**
     * A tab the person shared from the browser extension's toolbar, waiting
     * for a session (`shared-tabs.svelte.js`): which one gets it, the open
     * session first, whether its agent may act there or only read it, and
     * what that means. Share gives it to the chosen session, which opens;
     * Not now leaves the tab as it was.
     */
    import AskCard from './AskCard.svelte'
    import { errorText } from './errors.js'
    import { studio } from './studio.svelte.js'
    import { vault } from './vault.svelte.js'

    /** @type {{ share: import('./browser.js').WaitingShare, current: string }} */
    let { share, current } = $props()

    /** The person's sessions, the open one first. */
    const sessions = $derived([...studio.sessions].sort((a, b) => Number(b.name === current) - Number(a.name === current)))
    /** @type {string} */
    let chosen = $state('')
    const to = $derived(chosen || current)
    /** The other sites the chosen session's agent may open: what it reads here can reach them. */
    const sites = $derived(vault.agentSites[`agent:${to}`] ?? [])
    /** Whether the agent may click and type there too, not only read it. */
    let acts = $state(true)
    /** @type {string[]} */
    let errors = $state([])
    let busy = $state(false)

    /** @param {() => Promise<void>} fn */
    async function run(fn) {
        errors = []
        busy = true
        try {
            await fn()
        } catch (e) {
            errors = [errorText(e)]
        } finally {
            busy = false
        }
    }
</script>

<AskCard why={share.title || share.url} {errors}>
    {#snippet title()}You shared a tab on <code>{share.domain}</code>{/snippet}
    <label class="to">
        With
        <select class="input" bind:value={chosen}>
            {#each sessions as s (s.name)}
                <option value={s.name === current ? '' : s.name}>{s.title || 'Untitled session'}{s.name === current ? ' (open)' : ''}</option>
            {/each}
        </select>
    </label>
    <label class="acts"><input type="checkbox" bind:checked={acts} /> Let the agent click and type</label>
    {#snippet note()}
        {#if acts}The agent can use this page, signed in as you, while it stays on {share.domain}. Booking, paying, sending or deleting asks you first.{:else}The agent can read this page while it stays on {share.domain}.{/if}
        What it reads goes to your model provider and into the session's history.{#if sites.length > 0}
            {' '}This session can also open {sites.length === 1 ? 'another site' : `${sites.length} other sites`}, so what it reads here could reach {sites.length === 1 ? 'it' : 'them'}.{/if}
    {/snippet}
    {#snippet actions()}
        <button class="btn" disabled={busy} onclick={() => run(() => studio.shares.give(to, share, acts))}>Share</button>
        <button class="btn secondary" disabled={busy} onclick={() => run(() => studio.shares.turnDown(share))}>Not now</button>
    {/snippet}
</AskCard>

<style>
    .to {
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }
    .to select {
        flex: 1;
        min-width: 0;
    }
    .acts {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
    }
</style>
