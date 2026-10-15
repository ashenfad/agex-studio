<script>
    /** A line under the OpenRouter key field: whether OpenRouter accepts
     *  the key, and what it has spent. A key already there is checked at
     *  once; one being typed, once the typing pauses. Nothing shows for
     *  an empty field. */
    import { checkRouterKey, keyUsageLine } from './openrouter-api.js'

    /** How long typing pauses before the key is checked. */
    const PAUSE_MS = 600

    /** `status`, for the host: what's known of the key now.
     *  @type {{ key: string, status?: 'empty' | 'checking' | 'accepted' | 'rejected' | 'unknown' }} */
    let { key, status = $bindable('empty') } = $props()

    const trimmed = $derived(key.trim())

    $effect(() => {
        if (check === null) status = 'empty'
        else if (check === 'checking') status = 'checking'
        else if (check.ok === true) status = 'accepted'
        else status = check.reason === 'rejected' ? 'rejected' : 'unknown'
    })

    /** @type {import('./openrouter-api.js').KeyCheck | 'checking' | null} */
    let check = $state(null)
    /** The key the dialog opened with is checked without waiting. */
    let opening = true

    $effect(() => {
        const k = trimmed
        const wait = opening ? 0 : PAUSE_MS
        opening = false
        if (k === '') {
            check = null
            return
        }
        check = 'checking'
        // an answer for a key since replaced is dropped
        let current = true
        const timer = setTimeout(() => {
            checkRouterKey(k).then((out) => {
                if (current) check = out
            })
        }, wait)
        return () => {
            current = false
            clearTimeout(timer)
        }
    })
</script>

{#if check === 'checking'}
    <p class="key-check">Checking…</p>
{:else if check !== null}
    {#if check.ok === true}
        {@const usage = keyUsageLine(check)}
        <p class="key-check"><span class="ok">✓ Key accepted</span>{usage ? ` · ${usage}` : ''}</p>
    {:else if check.reason === 'rejected'}
        <p class="key-check rejected">OpenRouter doesn't accept this key</p>
    {:else}
        <p class="key-check" title={check.detail}>Couldn't check the key just now</p>
    {/if}
{/if}

<style>
    .key-check {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin: 0;
    }
    .ok {
        color: var(--success);
    }
    .rejected {
        color: var(--caution, #d9a441);
    }
</style>
