<script>
    /**
     * The OpenRouter model, picked from its catalog or typed: a text
     * field whose list, as you type, shows the models that match, with
     * their context, price and whether they take images. Models that
     * can't call tools (an agent's way of working) are left out unless
     * asked for. Any id typed stands, listed or not.
     */
    import { onMount } from 'svelte'
    import { errorText } from './errors.js'
    import { contextLabel, loadModels, priceLabel, searchModels } from './openrouter-models.js'

    /** @type {{ value: string }} */
    let { value = $bindable() } = $props()

    /** @type {import('./openrouter-models.js').RouterModel[]} */
    let models = $state([])
    /** @type {string | null} */
    let failed = $state(null)
    let loaded = $state(false)
    let open = $state(false)
    let all = $state(false)
    /** What's typed since the list opened: the list matches it, not the
     *  value it opened on. */
    let query = $state('')
    let active = $state(0)
    /** @type {HTMLInputElement | undefined} */
    let input = $state()

    onMount(() => {
        loadModels()
            .then((m) => (models = m))
            .catch((e) => (failed = errorText(e)))
            .finally(() => (loaded = true))
    })

    const shown = $derived(searchModels(models, query, { all }))

    $effect(() => {
        void shown
        active = 0
    })

    function show() {
        query = ''
        open = true
    }

    /** @param {import('./openrouter-models.js').RouterModel} m */
    function pick(m) {
        value = m.id
        open = false
        input?.focus()
    }

    /** @param {KeyboardEvent} e */
    function onkeydown(e) {
        if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            show()
            e.preventDefault()
            return
        }
        if (!open) return
        if (e.key === 'ArrowDown') active = Math.min(active + 1, shown.length - 1)
        else if (e.key === 'ArrowUp') active = Math.max(active - 1, 0)
        else if (e.key === 'Enter' && shown[active]) pick(shown[active])
        else if (e.key === 'Escape') open = false
        else return
        e.preventDefault()
        e.stopPropagation()
    }

    /** @param {Event} e */
    function oninput(e) {
        query = /** @type {HTMLInputElement} */ (e.target).value
        open = true
    }

    /** Closes when the focus leaves the picker, not when it moves into
     *  its list. @param {FocusEvent} e */
    function onfocusout(e) {
        const to = /** @type {Node | null} */ (e.relatedTarget)
        if (to === null || !(/** @type {HTMLElement} */ (e.currentTarget)).contains(to)) open = false
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="picker" {onfocusout}>
    <input
        class="input"
        bind:this={input}
        bind:value
        {oninput}
        {onkeydown}
        onfocus={show}
        onclick={show}
        placeholder="google/gemini-3.8-flash"
        aria-label="Model"
        role="combobox"
        aria-expanded={open}
        aria-controls="model-list"
        aria-autocomplete="list"
        autocomplete="off"
        spellcheck="false"
    />
    {#if open}
        <div class="list" id="model-list" role="listbox" tabindex="-1">
            {#if !loaded}
                <p class="note">Loading OpenRouter's models…</p>
            {:else if failed !== null && models.length === 0}
                <p class="note">Couldn't load OpenRouter's list ({failed}). Type a model's id.</p>
            {:else if shown.length === 0}
                <p class="note">No model matches{all ? '' : ' among those that call tools'}. Any id you type is used as it is.</p>
            {:else}
                {#each shown as m, i (m.id)}
                    <button
                        type="button"
                        class="option"
                        class:active={i === active}
                        role="option"
                        aria-selected={m.id === value}
                        tabindex="-1"
                        onmousedown={(e) => e.preventDefault()}
                        onmouseenter={() => (active = i)}
                        onclick={() => pick(m)}
                    >
                        <span class="name">{m.name}</span>
                        <span class="facts">
                            {#if m.context !== null}<span title="Context window">{contextLabel(m.context)}</span>{/if}
                            {#if m.input !== null}<span title="Per million tokens, in / out">{priceLabel(m.input)} / {priceLabel(m.output)}</span>{/if}
                            {#if m.images}<span class="tag" title="Takes images">images</span>{/if}
                            {#if !m.tools}<span class="tag warn" title="Can't call tools: the agent can't work with it">no tools</span>{/if}
                        </span>
                        <span class="id">{m.id}</span>
                    </button>
                {/each}
            {/if}
            <label class="all">
                <input type="checkbox" bind:checked={all} onmousedown={(e) => e.stopPropagation()} />
                Show models that can't call tools too
            </label>
        </div>
    {/if}
</div>

<style>
    .picker {
        position: relative;
    }
    .all input {
        accent-color: var(--accent);
    }
    .list {
        position: absolute;
        left: 0;
        right: 0;
        top: calc(100% + 0.25rem);
        z-index: 30;
        max-height: 18rem;
        overflow-y: auto;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
        padding: 0.25rem;
    }
    .option {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 0.1rem 0.6rem;
        width: 100%;
        text-align: left;
        background: none;
        border: none;
        border-radius: 6px;
        color: var(--text);
        font: inherit;
        padding: 0.35rem 0.5rem;
        cursor: pointer;
    }
    .option.active {
        background: var(--surface-hover);
    }
    .name {
        font-size: 0.85rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .facts {
        display: flex;
        gap: 0.45rem;
        font-size: 0.72rem;
        color: var(--text-muted);
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
    }
    .id {
        grid-column: 1 / -1;
        font-size: 0.72rem;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .tag {
        border: 1px solid var(--border);
        border-radius: 4px;
        padding: 0 0.3rem;
    }
    .tag.warn {
        color: var(--caution, #d9a441);
    }
    .note {
        font-size: 0.8rem;
        color: var(--text-muted);
        margin: 0.4rem 0.5rem;
    }
    .all {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.75rem;
        color: var(--text-muted);
        padding: 0.35rem 0.5rem 0.2rem;
        border-top: 1px solid var(--border);
        margin-top: 0.25rem;
    }
</style>
