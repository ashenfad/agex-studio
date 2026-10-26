<script>
    /**
     * The app's agent meter: what its agent calls (`agex.task`, and its
     * own agent's model calls through `agex.model`, listed in bursts)
     * have used on the person's model since the meter was last reset
     * (calls, model calls, tokens), its last few calls, and the limiter,
     * which pauses an app making more than `RATE.calls` task calls or
     * `RATE.modelCalls` model calls a minute. Reset counts from zero
     * again.
     */
    import { RATE } from './app-meter.js'
    import { appAgent } from './app-tasks.svelte.js'
    import Dialog from './Dialog.svelte'
    import { formatDate } from './format-time.js'

    /** @type {{ name: string, onClose: () => void }} */
    let { name, onClose } = $props()

    const meter = $derived(appAgent.meterOf(name))
    const limiter = $derived(meter?.limiter ?? true)
    const paused = $derived(appAgent.paused[name])
    const stopped = $derived(appAgent.stopped[name] === true)

    /** @param {number} n */
    const count = (n) => (n < 10_000 ? n.toLocaleString() : n < 1_000_000 ? `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(2)}M`)
    /** @param {number} ms */
    const seconds = (ms) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`)
    /** @param {number} t */
    const when = (t) => formatDate(new Date(t).toISOString())
</script>

<Dialog label="App agent" title="App agent" {onClose}>
    <p class="lead">
        What this app's agent calls have used on your model{meter ? ` since ${new Date(meter.since).toLocaleString()}` : ''},
        counted on this device.
    </p>
    {#if paused}
        <div class="status warn">
            <span>Paused: {paused.calls} {paused.model ? 'model calls' : 'calls'} in the last minute.</span>
            <button class="btn" onclick={() => appAgent.goOn(name)}>Keep going</button>
            <button class="btn secondary" onclick={() => paused.answer(false)}>Stop its calls</button>
        </div>
    {:else if stopped}
        <div class="status warn">
            <span>Its calls are stopped, until you let them go on.</span>
            <button class="btn" onclick={() => appAgent.goOn(name)}>Let them go on</button>
        </div>
    {/if}
    <dl class="totals">
        <div>
            <dt>Calls</dt>
            <dd>{count(meter?.calls ?? 0)}{#if meter?.failed}<span class="sub">{meter.failed} failed</span>{/if}</dd>
        </div>
        <div>
            <dt>Model calls</dt>
            <dd>{count(meter?.steps ?? 0)}</dd>
        </div>
        <div>
            <dt>Input tokens</dt>
            <dd>
                {count(meter?.inputTokens ?? 0)}{#if meter?.cacheReadTokens}<span class="sub">{count(meter.cacheReadTokens)} cached</span>{/if}
            </dd>
        </div>
        <div>
            <dt>Output tokens</dt>
            <dd>{count(meter?.outputTokens ?? 0)}</dd>
        </div>
    </dl>
    {#if meter?.recent.length}
        <h3>Recent calls</h3>
        <ul class="recent">
            {#each meter.recent as call}
                <li title={call.error ?? ''}>
                    <span class="task">{call.task}</span>
                    <span class="muted">{when(call.at)} · {seconds(call.ms)} · {call.steps} model {call.steps === 1 ? 'call' : 'calls'} · {count(call.inputTokens)} in / {count(call.outputTokens)} out</span>
                    {#if !call.ok}<span class="failed">failed</span>{/if}
                </li>
            {/each}
        </ul>
    {:else}
        <p class="muted">No calls yet.</p>
    {/if}
    <label class="check">
        <input type="checkbox" checked={limiter} onchange={(e) => appAgent.setLimiter(name, e.currentTarget.checked)} />
        Pause the app when it makes more than {RATE.calls} task calls, or {RATE.modelCalls} model calls, in a minute
    </label>
    <p class="hint">
        {limiter
            ? 'A loop (a call from a render, an effect or a timer) stops there, and you choose whether it goes on.'
            : 'Off: nothing stops a loop but you.'}
    </p>
    {#snippet actions()}
        <button class="btn secondary" onclick={() => appAgent.reset(name)} disabled={!meter}>Reset</button>
        <button class="btn" onclick={onClose}>Done</button>
    {/snippet}
</Dialog>

<style>
    .lead {
        color: var(--text-muted);
        font-size: 0.85rem;
    }
    .status {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem;
        padding: 0.5rem 0.7rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        font-size: 0.85rem;
    }
    .status span {
        flex: 1;
        min-width: 12rem;
    }
    .status.warn {
        border-color: var(--warning);
    }
    .totals {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 0.5rem;
        margin: 0;
    }
    .totals div {
        padding: 0.5rem 0.7rem;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 6px;
    }
    dt {
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    dd {
        margin: 0.15rem 0 0;
        font-size: 1.15rem;
        font-variant-numeric: tabular-nums;
        display: flex;
        align-items: baseline;
        flex-wrap: wrap;
        gap: 0.4rem;
    }
    .sub {
        font-size: 0.75rem;
        color: var(--text-muted);
    }
    h3 {
        font-size: 0.85rem;
        margin: 0.3rem 0 0;
    }
    .recent {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
        font-size: 0.8rem;
    }
    .recent li {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.2rem 0.5rem;
    }
    .task {
        font-family: var(--font-mono);
    }
    .muted {
        color: var(--text-muted);
    }
    .failed {
        color: var(--error);
    }
    .check {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.85rem;
    }
    .hint {
        margin-top: -0.4rem;
        font-size: 0.78rem;
        color: var(--text-muted);
    }
</style>
