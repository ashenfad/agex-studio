<script>
    /**
     * Something the person wrote: its words, the files attached to it as
     * chips (each opening the file), and a label when it wasn't an
     * ordinary message (sent mid-turn, or waiting to be).
     */
    import FileModal from './FileModal.svelte'
    import { attachmentsOf } from './notes.js'

    /** @type {{ session: import('./session.svelte.js').ChatSession, text: string, label?: string, faded?: boolean, onWithdraw?: () => void }} */
    let { session, text, label = '', faded = false, onWithdraw } = $props()

    const parts = $derived(attachmentsOf(text))
    /** @type {string | null} */
    let opened = $state(null)

    /** @param {string} path */
    const inWorkspace = (path) => path.replace(/^\/workspace\//, '')
</script>

<div class="bubble" class:faded>
    {#if label || onWithdraw}
        <div class="label">
            {label}
            {#if onWithdraw}<button class="withdraw" onclick={onWithdraw} title="Take it back" aria-label="Take it back">✕</button>{/if}
        </div>
    {/if}
    {#if parts.paths.length}
        <div class="chips">
            {#each parts.paths as p (p)}
                <button class="chip" title={p} onclick={() => (opened = inWorkspace(p))}>{p.split('/').at(-1)}</button>
            {/each}
        </div>
    {/if}
    {#if parts.text.trim() !== ''}<div class="text">{parts.text}</div>{/if}
</div>

{#if opened !== null}
    <FileModal {session} path={opened} onClose={() => (opened = null)} />
{/if}

<style>
    .bubble {
        max-width: 80%;
        background: var(--user-bubble);
        padding: 0.5rem 0.8rem;
        border-radius: 10px;
    }
    .faded {
        opacity: 0.7;
        border: 1px dashed var(--border);
        background: transparent;
    }
    .text {
        white-space: pre-wrap;
        overflow-wrap: anywhere;
    }
    .label {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.68rem;
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-muted);
        margin-bottom: 0.2rem;
    }
    .withdraw {
        margin-left: auto;
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        padding: 0;
    }
    .withdraw:hover {
        color: var(--text);
    }
    .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
        margin-bottom: 0.3rem;
    }
    .chip {
        background: rgb(255 255 255 / 8%);
        border: 1px solid var(--border);
        border-radius: 999px;
        color: var(--text);
        font-size: 0.72rem;
        padding: 0.1rem 0.55rem;
        max-width: 14rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
    }
    .chip::before {
        content: '📎 ';
    }
</style>
