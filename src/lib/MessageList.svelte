<script>
    import { tick, onDestroy } from 'svelte'
    import { renderMarkdown, renderMermaidBlocks } from './markdown.js'
    import { segmentParts, truncateText } from './event-utils.js'
    import ActivityPanel from './ActivityPanel.svelte'
    import DataTable from './DataTable.svelte'
    import PlotlyChart from './PlotlyChart.svelte'
    import StatCard from './StatCard.svelte'
    import CalloutCard from './CalloutCard.svelte'
    import CardRow from './CardRow.svelte'
    import TextModal from './TextModal.svelte'
    import ChapteringBand from './ChapteringBand.svelte'

    /** @type {{ messages: Array<{role: string, content: string, timestamp: Date, events?: Array, commit_hash?: string}>, busy: boolean, onUndo?: (index: number) => void, hasMore?: boolean, onLoadMore?: () => void, onActionOpen?: (index: number) => void, onChapterOpen?: (msg: any) => void, scrollKey?: number }} */
    let { messages, busy, onUndo, hasMore = false, onLoadMore, onActionOpen, onChapterOpen, scrollKey = 0 } = $props()

    // Reactive tick to keep relative timestamps fresh
    let _now = $state(Date.now())
    const _nowInterval = setInterval(() => { _now = Date.now() }, 60000)
    onDestroy(() => clearInterval(_nowInterval))

    let container
    let prevScrollHeight = 0
    let prepending = $state(false)
    let loading = $state(false)

    let userScrolledUp = $state(false)

    // Reset scroll position when the caller signals a context flip
    // (session switch, or the chat pane becoming visible after a
    // hide → show transition via view-mode / mobile-view toggles).
    // In the hide → show case, the messages-length effect below
    // can't do the work — it only fires on length changes, and the
    // length is unchanged across the toggle. So we scroll to bottom
    // directly here. tick() defers the scroll until after the DOM
    // settles (giving the now-visible pane a real scrollHeight to
    // scroll into); the `if (container)` guard handles the initial-
    // load case where the effect runs before the element mounts.
    $effect(() => {
        scrollKey  // dependency
        userScrolledUp = false
        tick().then(() => {
            if (!container) return
            container.scrollTop = container.scrollHeight
        })
    })

    // Capture scroll height before DOM updates (for prepend preservation)
    $effect.pre(() => {
        messages.length  // dependency
        if (container) {
            prevScrollHeight = container.scrollHeight
            // Consider "near bottom" if within 150px of the bottom
            const distFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
            userScrolledUp = distFromBottom > 150
        }
    })

    // After DOM updates, either auto-scroll to bottom or preserve position on prepend
    $effect(() => {
        messages.length  // dependency
        tick().then(() => {
            if (!container) return
            if (prepending) {
                // Restore scroll position after prepend
                const added = container.scrollHeight - prevScrollHeight
                container.scrollTop += added
                prepending = false
                loading = false
            } else if (!userScrolledUp) {
                // Auto-scroll to bottom only if user hasn't scrolled up
                container.scrollTop = container.scrollHeight
            }
        })
    })

    // Render mermaid diagrams after DOM updates
    $effect(() => {
        messages.length  // dependency
        tick().then(() => renderMermaidBlocks(container))
    })

    function handleScroll() {
        if (!container || !hasMore || loading || !onLoadMore) return
        if (container.scrollTop < 100) {
            const prevLen = messages.length
            loading = true
            prepending = true
            onLoadMore()
            // If onLoadMore didn't add messages, reset immediately
            if (messages.length === prevLen) {
                loading = false
                prepending = false
            }
        }
    }

    function formatTime(date) {
        const diff = _now - date.getTime()
        if (diff < 60000) return 'just now'
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        return date.toLocaleDateString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    }

    let expandedText = $state(null)

</script>

<div class="message-list" bind:this={container} onscroll={handleScroll}>
    {#if loading}
        <div class="load-more">
            <div class="load-spinner"></div>
        </div>
    {/if}

    {#if messages.length === 0 && !busy}
        <div class="empty">
            <p>Ask the agent anything.</p>
        </div>
    {/if}

    {#each messages as msg, i}
        {#if msg.role === 'chaptering'}
            <ChapteringBand
                count={(msg.chapters || []).length}
                onOpen={() => {
                    const chs = msg.chapters || []
                    if (chs.length === 1) {
                        onChapterOpen?.(chs[0])
                    } else if (chs.length > 1) {
                        onChapterOpen?.({
                            name: 'Chapters',
                            message: '',
                            events: chs.map(ch => ({ type: 'chapter', name: ch.name, message: ch.message, events: ch.events || [] }))
                        })
                    }
                }}
                onUndo={msg.commit_hash && onUndo ? () => onUndo(i) : undefined}
            />
        {:else if msg.role === 'agent' && msg.events?.length}
            <div class="activity-row">
                <ActivityPanel events={msg.events} streaming={msg.streaming} onOpen={() => onActionOpen?.(i)} />
            </div>
        {/if}

        {#if msg.streaming && !msg.isReport}
            <!-- Activity panel above shows the pulsing dot for in-flight
                 turns; no extra indicator needed here. Streaming-report
                 messages (msg.isReport && msg.streaming) deliberately
                 fall through to the standard agent-bubble branch below,
                 so the live → committed transition keeps the same
                 `{#if}` slot (and the same Svelte component instance).
                 An earlier dedicated branch for streaming reports caused
                 a visible flicker on `done` — Svelte tore down the
                 streaming-branch bubble before instantiating the
                 standard-branch one for the same content. -->
        {:else if msg.cancelled}
            <div class="cancelled-band">Stopped</div>
        {:else if msg.role === 'agent' && typeof msg.content === 'object'}
            {@const segments = segmentParts(msg.content)}
            <div class="rich-response">
                {#each segments as seg}
                    {#if seg.kind === 'text'}
                        <div class="message agent">
                            <div class="bubble">
                                <div class="content markdown">{@html renderMarkdown(seg.content)}</div>
                            </div>
                        </div>
                    {:else if seg.kind === 'dataframe'}
                        <div class="rich-block table-block">
                            <DataTable columns={seg.data.columns} rows={seg.data.rows} />
                        </div>
                    {:else if seg.kind === 'plotly'}
                        <div class="rich-block chart-block">
                            <PlotlyChart figure={seg.data.figure} />
                        </div>
                    {:else if seg.kind === 'stat'}
                        <!-- Bare stat (not inside a `cards` row) — wrap
                             in a single-item row so it gets the same
                             card sizing as one inside a row. -->
                        <CardRow items={[seg.data]} />
                    {:else if seg.kind === 'callout'}
                        <CardRow items={[seg.data]} />
                    {:else if seg.kind === 'cards'}
                        <CardRow items={seg.data.items} />
                    {:else if seg.kind === 'image'}
                        <div class="rich-block image-block">
                            <img src={seg.data.data} alt={seg.data.alt || ''} />
                        </div>
                    {/if}
                {/each}
            </div>
        {:else}
            <div class="message {msg.role}">
                <div class="bubble">
                    {#if msg.role === 'agent' || msg.isMarkdown}
                        <div class="content markdown">{@html renderMarkdown(typeof msg.content === 'string' ? msg.content : (msg.content?.content || ''))}</div>
                    {:else}
                        {@const tr = truncateText(msg.content)}
                        <div class="content">{tr.display}</div>
                    {/if}
                    {#if msg.errorStack}
                        <details class="error-details">
                            <summary>Stack trace</summary>
                            <pre>{msg.errorStack}</pre>
                        </details>
                    {/if}
                    {#if msg.role === 'user'}
                        {@const isTruncated = typeof msg.content === 'string' && truncateText(msg.content).truncated}
                        <div class="timestamp">
                            {#if isTruncated}
                                <button class="see-all-btn" onclick={() => expandedText = msg.content}>see all</button>
                            {/if}
                            {#if msg.commit_hash && onUndo}
                                <button class="undo-btn" onclick={() => onUndo(i)} title="Undo from here">undo</button>
                            {/if}
                            {formatTime(msg.timestamp)}
                        </div>
                    {/if}
                </div>
            </div>
        {/if}
    {/each}

    {#if busy && !messages.some(m => m.streaming)}
        <div class="activity-row">
            <div class="thinking">
                <span class="thinking-dot"></span>
                <span class="thinking-label">Thinking...</span>
            </div>
        </div>
    {/if}
</div>

<TextModal text={expandedText} onClose={() => expandedText = null} />

<style>
    .message-list {
        flex: 1;
        overflow-y: auto;
        padding: 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .empty {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        color: var(--text-muted);
        font-size: 0.95rem;
    }

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


    .message.user .bubble {
        background: var(--user-bubble);
        border-bottom-right-radius: 4px;
    }

    .message.agent .bubble {
        background: none;
        max-width: 95%;
        padding: 0.2rem 0;
    }

    .content {
        white-space: pre-wrap;
        word-break: break-word;
    }
    /* `.content.markdown` body styling lives in app.css's shared
       `.markdown` rule set. The one override that has to live here is
       white-space: the bare `.content` rule's `pre-wrap` is for plain
       user/agent text bubbles (preserves typed newlines), but on
       markdown-rendered content `pre-wrap` makes the literal newlines
       `marked` inserts between `<p>`/`<li>` elements render as blank
       lines. Svelte's scoped `.content` selector beats the unscoped
       `.markdown` rule in app.css on specificity, so the override has
       to live here (compound `.content.markdown` selector is 3 classes
       once Svelte adds its hash, winning the cascade). */
    .content.markdown { white-space: normal; }

    .timestamp {
        font-size: 0.7rem;
        color: var(--text-muted);
        margin-top: 0.3rem;
        text-align: right;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 0.5rem;
    }

    .undo-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.65rem;
        cursor: pointer;
        padding: 0;
        opacity: 0;
        transition: opacity 0.15s;
    }

    .bubble:hover .undo-btn {
        opacity: 1;
    }

    .undo-btn:hover {
        color: var(--accent);
    }

    .rich-response {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
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

    /* Tables get the same width treatment as charts — without it,
       `width: fit-content` shrinks a 2-column table to ~300px and
       it looks orphaned next to full-width cards / charts above
       and below. Wide tables overflow the wrapper horizontally
       via DataTable's own scroll container. */
    .rich-block.table-block {
        width: min(700px, 95%);
        background: transparent;
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

    .load-more {
        display: flex;
        justify-content: center;
        padding: 0.5rem;
    }

    .load-spinner {
        width: 16px;
        height: 16px;
        border: 2px solid var(--border);
        border-top-color: var(--accent);
        border-radius: 50%;
        animation: spin 0.8s linear infinite;
    }

    .activity-row {
        display: flex;
        justify-content: flex-start;
        margin-bottom: -0.75rem;
    }

    .cancelled-band {
        font-size: 0.75rem;
        color: var(--text-muted);
        font-style: italic;
        padding: 0.1rem 0;
    }

    .thinking {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        padding: 0.2rem 0;
        font-size: 0.75rem;
        color: var(--text-muted);
    }

    .thinking-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--accent);
        animation: pulse 1.2s ease-in-out infinite;
    }

    .thinking-label {
        font-style: italic;
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

    .bubble:hover .see-all-btn {
        opacity: 1;
    }

    .see-all-btn:hover {
        color: var(--accent);
    }

    /* Collapsible stack-trace footer on error bubbles. Tight font,
       monospace pre, subtle "Stack trace" affordance — readable
       without dominating the bubble. */
    .error-details {
        margin-top: 0.4rem;
        font-size: 0.72rem;
        color: var(--text-muted);
    }

    .error-details summary {
        cursor: pointer;
        user-select: none;
        padding: 0.1rem 0;
    }

    .error-details summary:hover {
        color: var(--text);
    }

    .error-details pre {
        margin: 0.35rem 0 0;
        padding: 0.5rem 0.7rem;
        background: var(--surface-hover);
        border: 1px solid var(--border);
        border-radius: 6px;
        font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
        font-size: 0.7rem;
        line-height: 1.45;
        color: var(--text);
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 320px;
        overflow: auto;
    }

</style>
