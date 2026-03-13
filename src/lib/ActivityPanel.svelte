<script>
    import { deriveTitle } from './event-utils.js'

    /** @type {{ events: Array<{ type: string, title?: string }>, streaming?: boolean, onOpen: () => void }} */
    let { events, streaming = false, onOpen } = $props()

    let summaryTitle = $derived(deriveTitle(events))
</script>

{#if events.length > 0}
    <div class="activity">
        <button class="toggle" onclick={onOpen}>
            {#if streaming}
                <span class="streaming-dot"></span>
            {:else}
                <span class="arrow">▸</span>
            {/if}
            <span class="label">{summaryTitle}</span>
        </button>
    </div>
{/if}

<style>
    .activity {
        margin-top: 0.4rem;
    }

    .toggle {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.75rem;
        cursor: pointer;
        padding: 0.2rem 0;
        display: flex;
        align-items: center;
        gap: 0.3rem;
    }

    .toggle:hover {
        color: var(--text);
    }

    .arrow {
        font-size: 0.65rem;
    }

    .streaming-dot {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: var(--accent);
        animation: pulse 1.2s ease-in-out infinite;
    }

</style>
