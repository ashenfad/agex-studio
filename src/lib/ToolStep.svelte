<script>
    /**
     * One tool call in a run of work, as one quiet line ("Ran code
     * `const rows = …`", "Edited app/main.js", "Tested the app · 6
     * steps"), opening to what it was asked and what came back: code
     * highlighted, a command as a prompt, an edit as the lines it took
     * out and put in, and the result with any images.
     */
    import { stepLine } from './activity.js'
    import { highlightCode } from './highlight.js'

    /** @type {{ tool: import('./activity.js').ToolItem, live?: boolean }} */
    let { tool, live = false } = $props()

    let open = $state(false)
    const line = $derived(stepLine(tool))
    /** A call without a result is running while the turn is, and was
     *  cut off in a turn that ended. */
    const running = $derived(live && tool.result === null)
    const cutOff = $derived(!live && tool.result === null)
    const args = $derived(tool.args)

    /** What the line carries while folded, besides its subject. */
    const pictures = $derived.by(() => {
        const n = tool.name === 'view_image' ? 0 : tool.images.length
        if (n === 0) return ''
        const noun = tool.name === 'test_app' ? 'screenshot' : 'image'
        return `· ${n} ${noun}${n === 1 ? '' : 's'}`
    })

    /** The argument that says what the call does, and how to show it. */
    const shown = $derived.by(() => {
        // `path` picks the highlighting, by its extension
        if (tool.name === 'run_ts' && typeof args.code === 'string') return { kind: 'code', code: args.code, path: 'code.ts' }
        if (tool.name === 'terminal' && typeof args.command === 'string') return { kind: 'terminal', code: args.command }
        if (tool.name === 'file_write' && typeof args.path === 'string') return { kind: 'code', code: String(args.content ?? ''), path: args.path }
        if (tool.name === 'file_edit' && typeof args.path === 'string') {
            return { kind: 'edit', old: String(args.old_string ?? ''), new: String(args.new_string ?? '') }
        }
        if (tool.name === 'view_image') return null
        return { kind: 'code', code: JSON.stringify(args, null, 2), path: 'args.json' }
    })

    /** @param {string} text */
    const lines = (text) => (text === '' ? [] : text.split('\n'))
</script>

<div class="step">
    <button class="act-line step-line" class:open class:act-live={running} onclick={() => (open = !open)}>
        <span class="act-verb">{line.verb}</span>
        {#if line.subject}<span class="act-rest" class:code={line.code}>{line.subject}</span>{/if}
        {#if pictures}<span class="act-rest">{pictures}</span>{/if}
        {#if tool.isError}<span class="act-rest failed">· failed</span>{/if}
        {#if cutOff}<span class="act-rest">· no result</span>{/if}
        <span class="act-chev">⌄</span>
    </button>
    {#if open}
        <div class="act-body">
            {#if shown?.kind === 'terminal'}
                <pre class="block terminal">{'$ ' + shown.code.split('\n').join('\n$ ')}</pre>
            {:else if shown?.kind === 'edit'}
                <pre class="block edit">{#each lines(shown.old) as l, i (i)}<span class="del">- {l}</span>
{/each}{#each lines(shown.new) as l, i (i)}<span class="add">+ {l}</span>
{/each}</pre>
            {:else if shown?.kind === 'code'}
                <pre class="block"><code>{@html highlightCode(shown.code, shown.path)}</code></pre>
            {/if}
            {#if tool.result !== null && tool.result !== ''}
                <pre class="block result" class:fail={tool.isError}>{tool.result}</pre>
            {/if}
            {#each tool.images as image, i (i)}
                <img class="shot" src={`data:${image.mediaType};base64,${image.data}`} alt={`${tool.name} image ${i + 1}`} />
            {/each}
        </div>
    {/if}
</div>

<style>
    .step-line {
        display: flex;
    }
    .block {
        font-family: var(--font-mono);
        font-size: 0.74rem;
        line-height: 1.45;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 6px;
        padding: 0.4rem 0.6rem;
        margin: 0.25rem 0 0;
        max-height: 260px;
        overflow: auto;
        /* long lines scroll: code and terminal output read wrong soft-wrapped */
        white-space: pre;
    }
    .terminal {
        background: rgba(0, 0, 0, 0.35);
        color: #9ece9e;
    }
    .del {
        color: #e88;
    }
    .add {
        color: #8c8;
    }
    .result {
        color: var(--text-muted);
    }
    .result.fail,
    .failed {
        color: var(--error);
    }
    .shot {
        display: block;
        max-width: min(100%, 360px);
        max-height: 240px;
        margin-top: 0.3rem;
        border: 1px solid var(--border);
        border-radius: 6px;
    }
</style>
