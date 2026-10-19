<script>
    /**
     * Content drawn only once it comes near the chat's view, a box of
     * about its height holding its place until then; drawn, it stays.
     * Outside a chat it's drawn at once. `shown` says which, for a
     * component whose own work (reading a file) waits too; until it says
     * it's `ready` (that work done), the box still holds the place.
     *
     * `key`, when given, names what's drawn: the height it came out at
     * is kept, and held exactly the next time it waits.
     */
    import { knownHeight, rememberHeight, useNearby } from './lazy.js'

    /** @type {{ height: number, key?: string, label?: string, shown?: boolean, ready?: boolean, children: import('svelte').Snippet }} */
    let { height, key = '', label = '', shown = $bindable(false), ready = true, children } = $props()

    const nearby = useNearby()
    if (nearby === null) shown = true

    /** @type {HTMLElement | undefined} */
    let el = $state()

    $effect(() => {
        const n = nearby?.()
        if (shown || el == null || n == null) return
        return n.whenNear(el, () => (shown = true))
    })

    $effect(() => {
        const n = nearby?.()
        if (el == null || n == null) return
        return n.watchSize(el)
    })

    // kept as it leaves the page, at the height it came out at
    $effect(() => {
        const node = el
        if (!shown || !ready || node == null || key === '') return
        return () => {
            const h = node.getBoundingClientRect().height
            if (h > 0) rememberHeight(key, h)
        }
    })

    const held = $derived((key !== '' ? knownHeight(key) : undefined) ?? height)
</script>

<div class="deferred" class:holding={!(shown && ready)} bind:this={el} style:min-height={shown && ready ? null : `${held}px`}>
    {#if shown}
        {@render children()}
    {:else}
        <div class="waiting">{label}</div>
    {/if}
</div>

<style>
    /* its content's margins inside it, so its height is all the room it takes */
    .deferred {
        display: flow-root;
    }
    .holding {
        border-radius: 8px;
        background: rgb(255 255 255 / 3%);
    }
    .holding > :global(*) {
        margin-inline: 0.6rem;
    }
    .waiting {
        color: var(--text-muted);
        font-size: 0.8rem;
        padding-top: 0.3rem;
    }
</style>
