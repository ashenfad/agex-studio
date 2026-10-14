<script>
    /**
     * One tool call: its name and what it was asked, and once it has
     * ended, its result, folded away until opened.
     */
    import { highlightCode } from './highlight.js'

    /** @type {{ name: string, args: Record<string, unknown>, result: string | null, isError?: boolean }} */
    let { name, args, result, isError = false } = $props()

    /** The argument that says what the call does, shown as code. */
    const shown = $derived.by(() => {
        // `path` picks the highlighting, by its extension
        if (name === 'run_ts' && typeof args.code === 'string') return { code: args.code, path: 'code.ts' }
        if (name === 'terminal' && typeof args.command === 'string') return { code: args.command, path: 'run.sh' }
        if (name === 'file_write' && typeof args.path === 'string') {
            return { code: String(args.content ?? ''), path: args.path, title: args.path }
        }
        if (name === 'file_edit' && typeof args.path === 'string') {
            return { code: `${args.old_string ?? ''}\n→\n${args.new_string ?? ''}`, path: '', title: args.path }
        }
        return { code: JSON.stringify(args, null, 2), path: 'args.json' }
    })
</script>

<div class="tool" class:error={isError}>
    <div class="head">
        <span class="name">{name}</span>
        {#if shown.title}<span class="title">{shown.title}</span>{/if}
        {#if result === null}<span class="pending">running…</span>{/if}
    </div>
    <pre class="code"><code>{@html highlightCode(shown.code, shown.path)}</code></pre>
    {#if result !== null}
        <details>
            <summary>{isError ? 'error' : 'result'}</summary>
            <pre class="result">{result}</pre>
        </details>
    {/if}
</div>

<style>
    .tool {
        border: 1px solid var(--border);
        border-radius: 6px;
        margin: 0.4rem 0;
        overflow: hidden;
    }
    .tool.error {
        border-color: var(--error);
    }
    .head {
        display: flex;
        gap: 0.6rem;
        align-items: baseline;
        padding: 0.3rem 0.6rem;
        background: var(--surface);
        font-size: 0.8rem;
    }
    .name {
        font-family: var(--font-mono);
        color: var(--purple);
    }
    .title,
    .pending {
        color: var(--text-muted);
    }
    .code,
    .result {
        margin: 0;
        padding: 0.5rem 0.6rem;
        font-family: var(--font-mono);
        font-size: 0.8rem;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 20rem;
        overflow: auto;
    }
    details summary {
        cursor: pointer;
        padding: 0.2rem 0.6rem;
        font-size: 0.75rem;
        color: var(--text-muted);
    }
</style>
