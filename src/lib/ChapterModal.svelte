<script>
    import { renderMarkdown } from './markdown.js'
    import { groupEventsForChat, deriveTitle, segmentParts, truncateText, hasOutputEvents } from './event-utils.js'
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
        current?.kind === 'activity' ? hasOutputEvents(current.events) : false
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
                                {:else if seg.kind === 'image'}
                                    <div class="rich-block image-block">
                                        <img src={seg.data.data} alt={seg.data.alt || ''} />
                                    </div>
                                {/if}
                            {/each}
                        {:else if group.kind === 'report'}
                            <!-- Agent narration/report — same markdown
                                 bubble as a text result, mirroring the
                                 main feed's `isReport` bubbles. -->
                            <div class="message agent">
                                <div class="bubble agent-bubble">
                                    <div class="content markdown">{@html renderMarkdown(group.content)}</div>
                                </div>
                            </div>
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

    /* Tighten the shared `.markdown` defaults — chapter summaries
       want a compact rhythm so the modal header stays short. */
    .chapter-summary :global(p) { margin: 0.3em 0; }
    .chapter-summary :global(ul),
    .chapter-summary :global(ol) { margin: 0.3em 0; }
    .chapter-summary :global(li) { margin: 0.1em 0; }

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
    /* `.content.markdown` body styling lives in app.css's shared
       `.markdown` rule set. White-space has to be overridden here
       though — Svelte's scoped `.content` rule beats the unscoped
       `.markdown` rule on specificity, so without this the markdown
       renderer's literal newlines between elements would render as
       blank lines under `pre-wrap`. See the matching note in
       MessageList.svelte. */
    .content.markdown { white-space: normal; }

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

    .rich-block.image-block {
        background: transparent;
    }

    .rich-block.image-block img {
        display: block;
        max-width: min(700px, 100%);
        height: auto;
        border-radius: 8px;
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

    /* Even tighter than chapter-summary — card previews are small. */
    .chapter-card-summary :global(p) { margin: 0.2em 0; }
    .chapter-card-summary :global(ul),
    .chapter-card-summary :global(ol) { margin: 0.2em 0; }
    .chapter-card-summary :global(li) { margin: 0.1em 0; }

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
