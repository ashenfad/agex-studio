<script>
    import { highlightPython, highlightTypeScript, highlightCode } from './highlight.js'
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

    function highlightTrimmedTs(code) {
        return highlightTypeScript(trim(code))
    }

    function renderThinking(text) {
        return renderMarkdown(text.replace(/^\s+/gm, ''))
    }
</script>

{#each visibleEvents as evt}
    {#if evt.type === 'action'}
        <!-- Emission-list rendering: each emission is its own section,
             in the order the model produced them.  Preserves
             interleaving of thinking / tool calls the way native
             reasoning models actually emit. -->
        <div class="event-card">
            {#if evt.title}
                <div class="event-title">{evt.title}</div>
            {/if}
            {#each evt.emissions as em (em.idx)}
                {#if em.kind === 'thinking' && em.text && !em.redacted}
                    <div class="section">
                        <div class="section-label">Thinking</div>
                        <blockquote class="thinking">
                            <div class="thinking-content">{@html renderThinking(em.text)}</div>
                        </blockquote>
                    </div>
                {:else if em.kind === 'thinking' && em.redacted}
                    <div class="section">
                        <div class="section-label">Thinking</div>
                        <blockquote class="thinking">
                            <div class="thinking-content"><em>[redacted thinking]</em></div>
                        </blockquote>
                    </div>
                {:else if em.kind === 'text' && em.text}
                    <div class="section">
                        <div class="section-label report-label">Report</div>
                        <div class="report-content markdown">{@html renderMarkdown(em.text)}</div>
                    </div>
                {:else if em.kind === 'python'}
                    {#if em.thinking}
                        <div class="section">
                            <div class="section-label">Thinking</div>
                            <blockquote class="thinking">
                                <div class="thinking-content">{@html renderThinking(em.thinking)}</div>
                            </blockquote>
                        </div>
                    {/if}
                    {#if em.code}
                        <div class="section code">
                            <div class="section-label">Code{em.title ? ' — ' + em.title : ''}</div>
                            <pre class="section-content"><code>{@html highlightTrimmed(em.code)}</code></pre>
                        </div>
                    {/if}
                {:else if em.kind === 'ts'}
                    {#if em.thinking}
                        <div class="section">
                            <div class="section-label">Thinking</div>
                            <blockquote class="thinking">
                                <div class="thinking-content">{@html renderThinking(em.thinking)}</div>
                            </blockquote>
                        </div>
                    {/if}
                    {#if em.code}
                        <div class="section code">
                            <div class="section-label">Code{em.title ? ' — ' + em.title : ''}</div>
                            <pre class="section-content"><code>{@html highlightTrimmedTs(em.code)}</code></pre>
                        </div>
                    {/if}
                {:else if em.kind === 'terminal'}
                    {#if em.thinking}
                        <div class="section">
                            <div class="section-label">Thinking</div>
                            <blockquote class="thinking">
                                <div class="thinking-content">{@html renderThinking(em.thinking)}</div>
                            </blockquote>
                        </div>
                    {/if}
                    {#if em.commands}
                        <div class="section terminal">
                            <div class="section-label">Terminal{em.title ? ' — ' + em.title : ''}</div>
                            <pre class="section-content"><code>{trim(em.commands)}</code></pre>
                        </div>
                    {/if}
                {:else if em.kind === 'file_write'}
                    <div class="section file-action">
                        <div class="section-label">{em.mode === 'append' ? 'Append' : 'Write'} <span class="filename">- {em.path}</span></div>
                        <pre class="section-content"><code>{@html highlightCode(trim(em.content || ''), em.path)}</code></pre>
                    </div>
                {:else if em.kind === 'file_edit'}
                    <div class="section edit-action">
                        <div class="section-label">Edit{em.match_all ? ' (all)' : ''} <span class="filename">- {em.path}</span></div>
                        <pre class="section-content diff"><code>{#each computeDiff(em.search || '', em.content || '', 'replace') as line}<span class="diff-{line.type}">{line.type === 'removed' ? '−' : line.type === 'added' ? '+' : ' '} {line.text}</span>{/each}</code></pre>
                    </div>
                {/if}
            {/each}
        </div>
    {:else if evt.type === 'error'}
        <div class="event-card error-card">
            <div class="section error">
                <div class="section-label">Error</div>
                {#if evt.parts?.length}
                    {#each evt.parts as part}
                        <pre class="section-content"><code>{part.content}</code></pre>
                    {/each}
                {:else}
                    <pre class="section-content"><code>{evt.message}</code></pre>
                {/if}
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
    {:else if evt.type === 'subtask'}
        <!-- Sub-task invocation chip. One-line summary of a delegated
             sub-agent call the parent made during this turn. -->
        <div
            class="subtask-chip"
            class:subtask-running={evt.status === 'running'}
            class:subtask-fail={evt.status === 'fail'}
            class:subtask-cancelled={evt.status === 'cancelled'}
        >
            <span class="subtask-arrow">→</span>
            <span class="subtask-name">{evt.name}</span><span class="subtask-args"
                >({evt.argsSummary ?? ''})</span
            >
            {#if evt.status === 'running'}
                <span class="subtask-outcome">running…</span>
            {:else}
                <span class="subtask-meta"
                    >[{evt.iterations ?? 0} iter · {((evt.durationMs ?? 0) / 1000).toFixed(1)}s]</span
                >
                {#if evt.status === 'success'}
                    <span class="subtask-result">→ {evt.resultSummary ?? ''}</span>
                {:else if evt.status === 'cancelled'}
                    <span class="subtask-outcome">cancelled</span>
                {:else}
                    <span class="subtask-outcome"
                        >failed{evt.error ? ` — ${evt.error}` : ''}</span
                    >
                {/if}
            {/if}
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

    .report-label { color: var(--success); }

    .report-content {
        padding: 0.5rem 0.75rem;
        border-left: 2px solid var(--success);
        font-size: 0.82rem;
    }

    /* Tighten vertical rhythm relative to the shared `.markdown`
       defaults so reports stay compact inside the activity modal. */
    .report-content :global(p) { margin: 0.3em 0; }
    .report-content :global(ul),
    .report-content :global(ol) { margin: 0.3em 0; }
    .report-content :global(li) { margin: 0.1em 0; }
    .report-content :global(pre) { margin: 0.3em 0; }
    .report-content :global(h1),
    .report-content :global(h2),
    .report-content :global(h3) { margin: 0.4em 0 0.25em; }

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

    /* Sub-task invocation chip — one compact line, distinct from the
       event cards so a delegation reads as a side-call, not a turn. */
    .subtask-chip {
        display: flex;
        flex-wrap: wrap;
        align-items: baseline;
        gap: 0.35em;
        padding: 0.3rem 0.6rem;
        border-left: 2px solid var(--purple);
        background: var(--surface);
        border-radius: 4px;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 0.76rem;
        line-height: 1.4;
        word-break: break-word;
    }
    .subtask-chip.subtask-fail { border-left-color: var(--error); }
    .subtask-chip.subtask-cancelled { border-left-color: var(--text-muted); opacity: 0.85; }
    .subtask-chip.subtask-running {
        border-left-color: var(--accent);
        animation: subtask-pulse 1.2s ease-in-out infinite;
    }
    .subtask-running .subtask-outcome { color: var(--accent); }
    @keyframes subtask-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.55; }
    }
    .subtask-arrow { color: var(--purple); font-weight: 600; }
    .subtask-name { font-weight: 600; color: var(--text); }
    .subtask-args { color: var(--text-muted); }
    .subtask-meta { color: var(--text-muted); font-size: 0.72rem; }
    .subtask-result { color: var(--success); }
    .subtask-fail .subtask-outcome { color: var(--error); }
    .subtask-cancelled .subtask-outcome { color: var(--text-muted); }
</style>
