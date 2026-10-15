<script>
    /**
     * The delegates a session is waiting on, above its composer: those
     * running, and those whose answers it hasn't read yet. Each shows
     * what it is doing, and opens its transcript.
     */
    import { doing } from './delegation.svelte.js'
    import { studio } from './studio.svelte.js'

    /** @type {{ session: import('./session.svelte.js').ChatSession }} */
    let { session } = $props()

    const shown = $derived(session.jobs.filter((j) => j.status === 'running' || session.unread.includes(j.name)))

    let now = $state(Date.now())
    $effect(() => {
        if (!shown.some((j) => j.status === 'running')) return
        const tick = setInterval(() => (now = Date.now()), 1000)
        return () => clearInterval(tick)
    })

    /** @param {number} ms */
    function elapsed(ms) {
        const s = Math.max(0, Math.round(ms / 1000))
        return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
    }

    const LABEL = /** @type {Record<string, string>} */ ({ answered: 'answered', declined: 'declined', capped: 'ran out of turns', failed: 'failed', cancelled: 'cancelled', expired: 'gone' })

    const summary = $derived.by(() => {
        const running = shown.filter((j) => j.status === 'running').length
        const done = shown.length - running
        return [running && `${running} working`, done && `${done} answered`].filter(Boolean).join(' · ')
    })
</script>

{#if shown.length > 0 || session.lostDelegates.length > 0}
    <div class="strip">
        <div class="head">⑂ delegates: {[summary, session.lostDelegates.length && `${session.lostDelegates.length} interrupted (the page closed): the next turn is told`].filter(Boolean).join(' · ')}</div>
        <div class="cards">
            {#each session.lostDelegates as name (name)}
                <button class="card" title={`${name}: interrupted when the page closed; its work is on its branch`} onclick={() => studio.switchTo(name)}>
                    <span class="dot interrupted"></span>
                    <span class="name">{name.split('.').at(-1)}</span>
                    <span class="doing">interrupted</span>
                </button>
            {/each}
            {#each shown as job (job.name)}
                <button class="card" title={`${job.name}: ${job.task}`} onclick={() => studio.switchTo(job.name)}>
                    <span class="dot {job.status}"></span>
                    <span class="name">{job.name.split('.').at(-1)}</span>
                    {#if job.status === 'running'}<span class="time">{elapsed(now - job.started)}</span>{/if}
                    <span class="doing">{job.status === 'running' ? (doing[job.name] ?? 'working') : (LABEL[job.status] ?? job.status)}</span>
                </button>
            {/each}
        </div>
    </div>
{/if}

<style>
    .strip {
        border-top: 1px solid var(--border);
        padding: 0.4rem var(--gutter, 0.8rem);
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
    }
    .head {
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    .cards {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(min(13rem, 100%), 1fr));
        gap: 0.35rem;
    }
    .card {
        display: grid;
        grid-template-columns: auto 1fr auto;
        align-items: center;
        gap: 0.2rem 0.45rem;
        text-align: left;
        background: var(--surface);
        border: 1px solid var(--border);
        color: var(--text);
        border-radius: 6px;
        padding: 0.35rem 0.5rem;
        cursor: pointer;
        font-size: 0.8rem;
    }
    .name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .time {
        color: var(--text-muted);
        font-size: 0.7rem;
    }
    .doing {
        grid-column: 2 / 4;
        color: var(--text-muted);
        font-size: 0.72rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .dot {
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        background: var(--text-muted);
    }
    .dot.running {
        background: var(--accent);
        animation: pulse 1.2s ease-in-out infinite;
    }
    .dot.answered {
        background: #4caf50;
    }
    .dot.failed,
    .dot.cancelled {
        background: var(--error);
    }
    .dot.interrupted {
        background: var(--text-muted);
        opacity: 0.6;
    }
    .dot.capped,
    .dot.declined {
        background: #e0a030;
    }
    @keyframes pulse {
        50% {
            opacity: 0.35;
        }
    }
</style>
