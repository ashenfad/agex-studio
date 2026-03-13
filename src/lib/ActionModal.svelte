<script>
    import { tick } from 'svelte'
    import { deriveTitle } from './event-utils.js'
    import EventDetail from './EventDetail.svelte'

    /** @type {{ events: Array | null, streaming?: boolean, onClose: () => void }} */
    let { events, streaming = false, onClose } = $props()

    let body = $state(null)
    let showOutput = $state(false)

    let title = $derived(events ? deriveTitle(events) : '')

    let hasOutput = $derived(
        events ? events.some(e => e.type === 'output') : false
    )

    function handleKeydown(e) {
        if (e.key === 'Escape') onClose()
    }

    // Auto-scroll to bottom during streaming
    let userScrolledUp = false
    $effect(() => {
        if (streaming && events && body) {
            void events.length
            tick().then(() => {
                if (body && !userScrolledUp) {
                    body.scrollTop = body.scrollHeight
                }
            })
        }
    })

    function handleBodyScroll() {
        if (!body) return
        const distFromBottom = body.scrollHeight - body.scrollTop - body.clientHeight
        userScrolledUp = distFromBottom > 100
    }
</script>

{#if events}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={onClose} onkeydown={handleKeydown}>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div class="modal" onclick={(e) => e.stopPropagation()}>
            <div class="modal-header">
                <span class="modal-title">
                    {title}
                    {#if streaming}
                        <span class="streaming-dot"></span>
                    {/if}
                </span>
                <div class="modal-actions">
                    {#if hasOutput}
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

            <div class="modal-body" bind:this={body} onscroll={handleBodyScroll}>
                <EventDetail events={events} {showOutput} />
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

    .modal-title {
        font-size: 0.85rem;
        font-weight: 600;
        color: var(--text);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 0.5rem;
    }

    .streaming-dot {
        width: 6px;
        height: 6px;
        border-radius: 50%;
        background: var(--accent);
        animation: pulse 1.2s ease-in-out infinite;
        flex-shrink: 0;
    }

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
</style>
