<script>
    import { renderMarkdown } from './markdown.js'
    import { groupEventsForChat, deriveTitle, segmentParts, truncateText } from './event-utils.js'
    import ActivityPanel from './ActivityPanel.svelte'
    import DataTable from './DataTable.svelte'
    import PlotlyChart from './PlotlyChart.svelte'
    import EventDetail from './EventDetail.svelte'
    import ChapteringBand from './ChapteringBand.svelte'

    /** @type {{ chapter: { name: string, message: string, events: Array } | null, onClose: () => void }} */
    let { chapter, onClose } = $props()

    /**
     * Stack entries:
     *   { kind: 'chapter', name, message, events }  — mini-chat view
     *   { kind: 'activity', name, events }           — expanded event detail
     */
    let stack = $state([])
    let showOutput = $state(false)

    /** Auto-drill through single-child chapters so user lands on real content. */
    function autoDrill(ch) {
        const entries = [{ kind: 'chapter', name: ch.name, message: ch.message, events: ch.events }]
        let cur = ch
        while (true) {
            const groups = groupEventsForChat(cur.events)
            if (groups.length === 1 && groups[0].kind === 'chapter') {
                cur = groups[0]
                entries.push({ kind: 'chapter', name: cur.name, message: cur.message, events: cur.events })
            } else {
                break
            }
        }
        return entries
    }

    $effect(() => {
        if (chapter) {
            stack = autoDrill(chapter)
            showOutput = false
        } else {
            stack = []
        }
    })

    let current = $derived(stack.length > 0 ? stack[stack.length - 1] : null)

    let chatGroups = $derived(
        current?.kind === 'chapter' ? groupEventsForChat(current.events) : []
    )

    let hasOutput = $derived(
        current?.kind === 'activity' ? current.events.some(e => e.type === 'output') : false
    )

    function pushChapter(ch) {
        stack = [...stack, ...autoDrill(ch)]
        showOutput = false
    }

    function pushActivity(group) {
        stack = [...stack, { kind: 'activity', name: deriveTitle(group.events), events: group.events }]
        showOutput = false
    }

    function pushText(text) {
        stack = [...stack, { kind: 'text', name: 'Full message', text }]
    }

    function popTo(index) {
        stack = stack.slice(0, index + 1)
        showOutput = false
    }

    function handleKeydown(e) {
        if (e.key === 'Escape') onClose()
    }
</script>

{#if chapter && current}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={onClose} onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="modal" onclick={(e) => e.stopPropagation()}>
            <div class="modal-header">
                <div class="breadcrumb">
                    {#each stack as entry, i}
                        {#if i > 0}<span class="sep">/</span>{/if}
                        {#if i < stack.length - 1}
                            <button class="crumb" onclick={() => popTo(i)}>{entry.name}</button>
                        {:else}
                            <span class="crumb current">{entry.name}</span>
                        {/if}
                    {/each}
                </div>
                <div class="modal-actions">
                    {#if current.kind === 'activity' && hasOutput}
                        <button
                            class="toggle-btn"
                            class:active={showOutput}
                            onclick={() => showOutput = !showOutput}
                            title={showOutput ? 'Hide stdout' : 'Show stdout'}
                        >stdout</button>
                    {/if}
                    <button class="close-btn" onclick={onClose} title="Close">×</button>
                </div>
            </div>

            {#if current.kind === 'chapter' && current.message && stack.length === 1}
                <div class="chapter-summary markdown">{@html renderMarkdown(current.message)}</div>
            {/if}

            <div class="modal-body">
                {#if current.kind === 'chapter'}
                    <!-- Mini-chat layout -->
                    {#each chatGroups as group}
                        {#if group.kind === 'chaptering'}
                            <ChapteringBand />
                        {:else if group.kind === 'user'}
                            {@const tr = truncateText(group.message)}
                            <div class="message user">
                                <div class="bubble user-bubble">
                                    <div class="content">{tr.display}</div>
                                    {#if tr.truncated}
                                        <div class="bubble-footer">
                                            <button class="see-all-btn" onclick={() => pushText(group.message)}>see all</button>
                                        </div>
                                    {/if}
                                </div>
                            </div>
                        {:else if group.kind === 'agent'}
                            {@const segments = segmentParts(group.content)}
                            {#each segments as seg}
                                {#if seg.kind === 'text'}
                                    <div class="message agent">
                                        <div class="bubble agent-bubble">
                                            <div class="content markdown">{@html renderMarkdown(seg.content)}</div>
                                        </div>
                                    </div>
                                {:else if seg.kind === 'dataframe'}
                                    <div class="rich-block">
                                        <DataTable columns={seg.data.columns} rows={seg.data.rows} />
                                    </div>
                                {:else if seg.kind === 'plotly'}
                                    <div class="rich-block chart-block">
                                        <PlotlyChart figure={seg.data.figure} />
                                    </div>
                                {/if}
                            {/each}
                        {:else if group.kind === 'activity'}
                            <div class="activity-row">
                                <ActivityPanel
                                    events={group.events}
                                    onOpen={() => pushActivity(group)}
                                />
                            </div>
                        {:else if group.kind === 'chapter'}
                            <button class="chapter-card" onclick={() => pushChapter(group)}>
                                <span class="chapter-card-name">{group.name}</span>
                                {#if group.message}
                                    <span class="chapter-card-summary markdown">{@html renderMarkdown(group.message)}</span>
                                {/if}
                            </button>
                        {/if}
                    {/each}
                {:else if current.kind === 'activity'}
                    <!-- Expanded event detail (same as ActionModal body) -->
                    <EventDetail events={current.events} {showOutput} />
                {:else if current.kind === 'text'}
                    <div class="full-text">{current.text}</div>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .modal {
        width: 80vw;
        height: 80vh;
        max-width: 1100px;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 10px;
        display: flex;
        flex-direction: column;
        overflow: hidden;
    }

    .modal-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.6rem 1rem;
        border-bottom: 1px solid var(--border);
        gap: 0.5rem;
    }

    .breadcrumb {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        min-width: 0;
        overflow: hidden;
    }

    .sep {
        color: var(--text-muted);
        font-size: 0.75rem;
        flex-shrink: 0;
    }

    .crumb {
        background: none;
        border: none;
        color: var(--accent);
        font-size: 0.85rem;
        cursor: pointer;
        padding: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    .crumb:hover { text-decoration: underline; }

    .crumb.current {
        color: var(--text);
        font-weight: 600;
        cursor: default;
    }

    .crumb.current:hover { text-decoration: none; }

    .modal-actions {
        display: flex;
        align-items: center;
        gap: 0.25rem;
        flex-shrink: 0;
    }

    .toggle-btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 0.7rem;
        cursor: pointer;
        padding: 0.2rem 0.5rem;
        border-radius: 4px;
    }

    .toggle-btn:hover {
        background: var(--surface-hover);
        color: var(--text);
    }

    .toggle-btn.active {
        background: var(--accent);
        border-color: var(--accent);
        color: white;
    }

    .chapter-summary {
        padding: 0.5rem 1rem;
        font-size: 0.82rem;
        color: var(--text-muted);
        border-bottom: 1px solid var(--border);
        font-style: italic;
    }

    .chapter-summary.markdown :global(p) { margin: 0.3em 0; }
    .chapter-summary.markdown :global(p:first-child) { margin-top: 0; }
    .chapter-summary.markdown :global(p:last-child) { margin-bottom: 0; }
    .chapter-summary.markdown :global(code) {
        background: rgba(255, 255, 255, 0.1);
        padding: 0.1em 0.3em;
        border-radius: 3px;
        font-size: 0.85em;
    }
    .chapter-summary.markdown :global(strong) { font-weight: 600; }
    .chapter-summary.markdown :global(ul),
    .chapter-summary.markdown :global(ol) { margin: 0.3em 0; padding-left: 1.4em; }
    .chapter-summary.markdown :global(li) { margin: 0.1em 0; }

    .modal-body {
        flex: 1;
        overflow: auto;
        padding: 1rem 1.25rem;
        min-height: 0;
    }

    .modal-body > :global(*) {
        margin-bottom: 0.75rem;
    }

    .modal-body > :global(*:last-child) {
        margin-bottom: 0;
    }

    /* Mini-chat styles (matching MessageList) */
    .message {
        display: flex;
    }

    .message.user {
        justify-content: flex-end;
    }

    .message.agent {
        justify-content: flex-start;
    }

    .bubble {
        max-width: 80%;
        padding: 0.6rem 0.9rem;
        border-radius: 12px;
        font-size: 0.9rem;
        line-height: 1.5;
    }

    .user-bubble {
        background: var(--user-bubble);
        border-bottom-right-radius: 4px;
    }

    .agent-bubble {
        background: none;
        max-width: 95%;
        padding: 0.2rem 0;
    }

    .content {
        white-space: pre-wrap;
        word-break: break-word;
    }

    .content.markdown { white-space: normal; }
    .content.markdown :global(p) { margin: 0.4em 0; }
    .content.markdown :global(p:first-child) { margin-top: 0; }
    .content.markdown :global(p:last-child) { margin-bottom: 0; }
    .content.markdown :global(ul),
    .content.markdown :global(ol) { margin: 0.4em 0; padding-left: 1.4em; }
    .content.markdown :global(li) { margin: 0.15em 0; }
    .content.markdown :global(code) {
        background: rgba(255, 255, 255, 0.1);
        padding: 0.1em 0.3em;
        border-radius: 3px;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 0.82em;
    }
    .content.markdown :global(pre) {
        background: rgba(255, 255, 255, 0.08);
        border-radius: 6px;
        padding: 0.5em 0.7em;
        overflow-x: auto;
        margin: 0.4em 0;
    }
    .content.markdown :global(pre code) { background: none; padding: 0; font-size: 0.8em; }
    .content.markdown :global(strong) { font-weight: 600; }
    .content.markdown :global(h1),
    .content.markdown :global(h2),
    .content.markdown :global(h3) { margin: 0.5em 0 0.3em; font-weight: 600; }
    .content.markdown :global(h1) { font-size: 1.1em; }
    .content.markdown :global(h2) { font-size: 1em; }
    .content.markdown :global(h3) { font-size: 0.95em; }
    .content.markdown :global(a) { color: #7cb7ff; text-decoration: underline; }
    .content.markdown :global(blockquote) {
        border-left: 3px solid rgba(255, 255, 255, 0.2);
        background: rgba(255, 255, 255, 0.06);
        margin: 0.5em 0;
        padding: 0.4em 0.8em;
        border-radius: 0 4px 4px 0;
    }

    .rich-block {
        width: fit-content;
        max-width: 95%;
        background: var(--agent-bubble);
        border-radius: 8px;
        overflow: hidden;
    }

    .rich-block.chart-block {
        width: min(700px, 95%);
    }

    .activity-row {
        display: flex;
        justify-content: flex-start;
    }

    .chapter-card {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        background: none;
        border: 1px solid var(--border);
        border-radius: 8px;
        padding: 0.6rem 0.9rem;
        cursor: pointer;
        text-align: left;
        color: var(--text);
        width: 100%;
    }

    .chapter-card:hover {
        border-color: var(--text-muted);
    }

    .chapter-card-name {
        font-size: 0.85rem;
        font-weight: 600;
    }

    .chapter-card-summary {
        font-size: 0.78rem;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .chapter-card-summary.markdown :global(p) { margin: 0.2em 0; }
    .chapter-card-summary.markdown :global(p:first-child) { margin-top: 0; }
    .chapter-card-summary.markdown :global(p:last-child) { margin-bottom: 0; }
    .chapter-card-summary.markdown :global(ul),
    .chapter-card-summary.markdown :global(ol) { margin: 0.2em 0; padding-left: 1.4em; }
    .chapter-card-summary.markdown :global(li) { margin: 0.1em 0; }
    .chapter-card-summary.markdown :global(code) {
        background: rgba(255, 255, 255, 0.1);
        padding: 0.1em 0.2em;
        border-radius: 3px;
        font-size: 0.85em;
    }
    .chapter-card-summary.markdown :global(strong) { font-weight: 600; }

    .bubble-footer {
        font-size: 0.7rem;
        color: var(--text-muted);
        margin-top: 0.3rem;
        text-align: right;
    }

    .see-all-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.65rem;
        cursor: pointer;
        padding: 0;
        opacity: 0;
        transition: opacity 0.15s;
    }

    .user-bubble:hover .see-all-btn {
        opacity: 1;
    }

    .see-all-btn:hover {
        color: var(--accent);
    }

    .full-text {
        white-space: pre-wrap;
        word-break: break-word;
        font-size: 0.9rem;
        line-height: 1.5;
    }
</style>
