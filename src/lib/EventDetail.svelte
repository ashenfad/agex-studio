<script>
    import { highlightPython, highlightCode } from './highlight.js'
    import { renderMarkdown } from './markdown.js'
    import { trim, computeDiff } from './event-utils.js'

    /** @type {{ events: Array, showOutput?: boolean }} */
    let { events, showOutput = false } = $props()

    let visibleEvents = $derived(
        showOutput ? events : events.filter(e => e.type !== 'output')
    )

    function highlightTrimmed(code) {
        return highlightPython(trim(code))
    }

    function renderThinking(text) {
        return renderMarkdown(text.replace(/^\s+/gm, ''))
    }
</script>

{#each visibleEvents as evt}
    {#if evt.type === 'action'}
        <div class="event-card">
            {#if evt.title}
                <div class="event-title">{evt.title}</div>
            {/if}
            {#if evt.thinking}
                <div class="section">
                    <div class="section-label">Thinking</div>
                    <blockquote class="thinking">
                        <div class="thinking-content">{@html renderThinking(evt.thinking)}</div>
                    </blockquote>
                </div>
            {/if}
            {#if evt.file_actions?.length}
                {#each evt.file_actions as fa}
                    {#if fa.kind === 'file'}
                        <div class="section file-action">
                            <div class="section-label">{fa.mode === 'append' ? 'Append' : 'Write'} <span class="filename">- {fa.path}</span></div>
                            <pre class="section-content"><code>{@html highlightCode(trim(fa.content), fa.path)}</code></pre>
                        </div>
                    {:else if fa.kind === 'edit'}
                        <div class="section edit-action">
                            <div class="section-label">Edit <span class="filename">- {fa.path}</span></div>
                            <pre class="section-content diff"><code>{#each computeDiff(fa.search, fa.content, fa.operation) as line}<span class="diff-{line.type}">{line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '} {line.text}</span>{/each}</code></pre>
                        </div>
                    {/if}
                {/each}
            {/if}
            {#if evt.code}
                <div class="section code">
                    <div class="section-label">Code</div>
                    <pre class="section-content"><code>{@html highlightTrimmed(evt.code)}</code></pre>
                </div>
            {/if}
            {#if evt.terminal}
                <div class="section terminal">
                    <div class="section-label">Terminal</div>
                    <pre class="section-content"><code>{trim(evt.terminal)}</code></pre>
                </div>
            {/if}
        </div>
    {:else if evt.type === 'error'}
        <div class="event-card error-card">
            <div class="section error">
                <div class="section-label">Error</div>
                <pre class="section-content"><code>{evt.message}</code></pre>
            </div>
        </div>
    {:else if evt.type === 'output'}
        <div class="event-card output-card">
            <div class="section output">
                <div class="section-label">Output</div>
                {#if evt.parts?.length}
                    {#each evt.parts as part}
                        {#if part.type === 'image'}
                            <div class="output-image">
                                <img src={part.data.startsWith('data:') ? part.data : `data:image/png;base64,${part.data}`} alt="Output" />
                            </div>
                        {:else}
                            <pre class="section-content"><code>{part.content}</code></pre>
                        {/if}
                    {/each}
                {:else}
                    <pre class="section-content"><code>{evt.message}</code></pre>
                {/if}
            </div>
        </div>
    {/if}
{/each}

<style>
    .event-card {
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.75rem;
        font-size: 0.85rem;
    }

    .error-card {
        border-color: var(--error);
    }

    .output-card {
        border-color: var(--text-muted);
        opacity: 0.85;
    }

    .event-title {
        font-weight: 600;
        margin-bottom: 0.5rem;
        font-size: 0.85rem;
    }

    .section {
        margin-top: 0.5rem;
    }

    .section:first-child {
        margin-top: 0;
    }

    .section-label {
        font-size: 0.65rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
        margin-bottom: 0.25rem;
    }

    .section-content {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.5;
    }

    .thinking {
        margin: 0;
        padding: 0.5rem 0.75rem;
        border-left: 2px solid var(--text-muted);
        color: var(--text-muted);
        font-style: italic;
        font-size: 0.82rem;
    }

    .thinking-content :global(p) { margin: 0.3em 0; }
    .thinking-content :global(p:first-child) { margin-top: 0; }
    .thinking-content :global(p:last-child) { margin-bottom: 0; }
    .thinking-content :global(code) {
        font-style: normal;
        background: var(--surface);
        padding: 0.1em 0.3em;
        border-radius: 3px;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 0.9em;
    }
    .thinking-content :global(ul),
    .thinking-content :global(ol) {
        margin: 0.3em 0;
        padding-left: 1.4em;
    }
    .thinking-content :global(strong) {
        font-weight: 600;
        color: var(--text);
    }

    pre.section-content {
        background: var(--surface);
        border-radius: 4px;
        padding: 0.5rem 0.75rem;
        overflow-x: auto;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 0.78rem;
    }

    .code pre.section-content { border-left: 2px solid var(--accent); }
    .terminal pre.section-content { border-left: 2px solid var(--success); }
    .error .section-label { color: var(--error); }
    .error pre.section-content { border-left: 2px solid var(--error); color: var(--error); }
    .output pre.section-content { border-left: 2px solid var(--text-muted); }

    .filename { text-transform: none; }

    .file-action pre.section-content,
    .edit-action pre.section-content { border-left: 2px solid var(--purple); }

    .diff { line-height: 1.5; }
    .diff :global(.diff-removed) { display: block; background: rgba(233, 69, 96, 0.15); color: #f87171; }
    .diff :global(.diff-added) { display: block; background: rgba(76, 175, 80, 0.15); color: #86efac; }
    .diff :global(.diff-context) { display: block; color: var(--text-muted); }

    .output-image { margin-top: 0.25rem; border-radius: 4px; overflow: hidden; }
    .output-image img { max-width: 100%; display: block; border-radius: 4px; }
</style>
