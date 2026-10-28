<script>
    /**
     * Choosing a key from the vault for one need (an app's declared
     * secret, or one a session's agent asks for): the entries whose
     * origins cover the need's, a new key (its label, the key, and its
     * origins, prefilled), or, with `noneLabel`, none. The choice and the
     * new key's fields are the caller's, which checks and keeps them.
     */
    import { vault } from './vault.svelte.js'

    /**
     * @type {{
     *   need: { name: string, origins: string[] },
     *   group: string,
     *   pick: string,
     *   draft: { label: string, value: string, origins: string },
     *   errors?: string[],
     *   noneLabel?: string | null,
     * }}
     */
    let { need, group, pick = $bindable(), draft = $bindable(), errors = [], noneLabel = null } = $props()

    const covering = $derived(vault.entriesCovering(need.origins))
</script>

<fieldset class="choices">
    <legend class="hidden">Key for {need.name}</legend>
    {#each covering as entry (entry.id)}
        <label><input type="radio" name={group} checked={pick === entry.id} onchange={() => (pick = entry.id)} /> Use {entry.label}</label>
    {/each}
    <label><input type="radio" name={group} checked={pick === 'new'} onchange={() => (pick = 'new')} /> Add a new key</label>
    {#if noneLabel !== null}
        <label><input type="radio" name={group} checked={pick === 'none'} onchange={() => (pick = 'none')} /> {noneLabel}</label>
    {/if}
</fieldset>
{#if pick === 'new'}
    <div class="fields">
        <label>
            <span>Label</span>
            <input class="input" bind:value={draft.label} autocomplete="off" />
        </label>
        <label>
            <span>Key</span>
            <input class="input" type="password" bind:value={draft.value} autocomplete="off" />
        </label>
        <label class="wide">
            <span>Origins</span>
            <textarea class="input" rows={Math.max(1, need.origins.length)} bind:value={draft.origins} spellcheck="false"></textarea>
        </label>
        <p class="hint wide">Kept on this device only.</p>
        {#if errors.length > 0}
            <ul class="errors wide" role="alert">
                {#each errors as e, i (i)}<li>{e}</li>{/each}
            </ul>
        {/if}
    </div>
{/if}

<style>
    .choices {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem 1rem;
        margin: 0;
        padding: 0;
        border: none;
    }
    .choices label {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        cursor: pointer;
    }
    .hidden {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip-path: inset(50%);
        white-space: nowrap;
    }
    .fields {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(11rem, 1fr));
        gap: 0.35rem 0.6rem;
        max-width: 36rem;
    }
    .fields .wide {
        grid-column: 1 / -1;
    }
    .fields label {
        display: flex;
        flex-direction: column;
        gap: 0.15rem;
        font-size: 0.8rem;
        color: var(--text-muted);
    }
    .fields textarea {
        resize: vertical;
        font-family: var(--font-mono);
        font-size: 0.8rem;
    }
    .hint {
        margin: 0;
        color: var(--text-muted);
    }
    .errors {
        list-style: none;
        margin: 0;
        padding: 0;
        color: var(--error);
        font-size: 0.8rem;
    }
</style>
