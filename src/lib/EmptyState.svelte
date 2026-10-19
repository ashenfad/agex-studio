<script>
    /**
     * A session with nothing in it yet. Before a model is chosen, what the
     * studio is and the one step to start (a key); after, a few things to
     * ask for, each filling the message box.
     */
    import { isConfigured, settingsStore } from './settings.js'

    /** @type {{ session: import('./session.svelte.js').ChatSession, onSettings: () => void }} */
    let { session, onSettings } = $props()

    const EXAMPLES = [
        'Build me a study app for 4th-grade multiplication.',
        'Make a habit tracker that remembers what I check off.',
        'Find three recent articles on diffusion models and summarize each.',
        'Chart this CSV for me.',
    ]

    /** @param {string} text */
    function use(text) {
        session.draft = text
        // the message box takes it from here
        const box = /** @type {HTMLTextAreaElement | null} */ (document.querySelector('.card textarea'))
        box?.focus()
    }
</script>

<div class="empty">
    {#if !isConfigured($settingsStore)}
        <h1>agex studio</h1>
        <p class="lead">An AI agent in your browser tab. Ask it for an app, a chart, a report, and it builds it here, in a workspace of its own you can see, undo and share.</p>
        <ul>
            <li><b>Your model, your key.</b> It talks to the model you choose, paid with your own key: no account here, no server of ours in between.</li>
            <li><b>Your work stays here.</b> Sessions live in this browser, and sync to a GitHub repo of yours only if you ask.</li>
            <li><b>Apps you can share.</b> What it builds runs beside the chat, and publishes as a link.</li>
        </ul>
        <div class="start">
            <button class="primary" onclick={onSettings}>Choose a model</button>
            <span class="muted">An <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">OpenRouter key</a> is the quickest start.</span>
        </div>
        <p class="muted small"><a href="/docs/" target="_blank" rel="noreferrer">How it works</a> · <a href="/docs/#privacy" target="_blank" rel="noreferrer">Privacy</a></p>
    {:else}
        <h2>What shall we make?</h2>
        <div class="examples">
            {#each EXAMPLES as text (text)}
                <button onclick={() => use(text)}>{text}</button>
            {/each}
        </div>
        <p class="muted small">Attach files with + (or drop them here). New to the studio? <a href="/docs/" target="_blank" rel="noreferrer">The docs</a>.</p>
    {/if}
</div>

<style>
    .empty {
        margin: auto 0;
        padding: 2rem 0;
        display: flex;
        flex-direction: column;
        gap: 0.9rem;
        max-width: 38rem;
        align-self: center;
        width: 100%;
    }
    h1 {
        font-family: var(--font-display);
        font-size: 2rem;
        font-weight: 500;
    }
    h2 {
        font-family: var(--font-display);
        font-size: 1.4rem;
        font-weight: 500;
        text-align: center;
    }
    .lead {
        font-size: 1.05rem;
        line-height: 1.5;
    }
    ul {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding-left: 1.1rem;
        color: var(--text-muted);
        line-height: 1.45;
    }
    ul b {
        color: var(--text);
        font-weight: 600;
    }
    .start {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.8rem;
        margin-top: 0.3rem;
    }
    .primary {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 8px;
        padding: 0.55rem 1.1rem;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
    }
    .primary:hover {
        background: var(--accent-hover);
    }
    .examples {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr));
        gap: 0.5rem;
    }
    .examples button {
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        color: var(--text);
        cursor: pointer;
        font: inherit;
        font-size: 0.88rem;
        line-height: 1.4;
        padding: 0.7rem 0.85rem;
        text-align: left;
    }
    .examples button:hover {
        border-color: var(--text-muted);
        background: var(--surface-hover);
    }
    .muted {
        color: var(--text-muted);
    }
    .small {
        font-size: 0.82rem;
        text-align: center;
    }
    a {
        color: var(--accent);
    }
</style>
