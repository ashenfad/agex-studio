<script>
    /**
     * The studio: one session for now (the session list comes in S1),
     * opened on the world's store, and the settings for the model.
     */
    import { onMount } from 'svelte'
    import Chat from './lib/Chat.svelte'
    import { installDevHook } from './lib/dev-hook.js'
    import SettingsDialog from './lib/SettingsDialog.svelte'
    import { isConfigured, settingsStore } from './lib/settings.js'
    import { ChatSession } from './lib/studio.svelte.js'

    /** @type {ChatSession | null} */
    let session = $state(null)
    /** @type {string | null} */
    let failed = $state(null)
    let showSettings = $state(false)

    if (import.meta.env.DEV) installDevHook(() => session)

    onMount(async () => {
        const opening = new ChatSession('main')
        try {
            await opening.open()
            session = opening
        } catch (e) {
            failed = e instanceof Error ? e.message : String(e)
        }
    })
</script>

<div class="shell">
    <header>
        <span class="brand">agex studio</span>
        <button class="gear" onclick={() => (showSettings = true)} aria-label="Settings">⚙</button>
    </header>
    <main>
        {#if failed}
            <p class="note">The workspace couldn't open: {failed}</p>
        {:else if session === null}
            <p class="note">Opening…</p>
        {:else if !isConfigured($settingsStore)}
            <p class="note">
                Choose a model to start: <button class="link" onclick={() => (showSettings = true)}>settings</button>.
            </p>
        {:else}
            <Chat {session} />
        {/if}
    </main>
</div>

{#if showSettings}
    <SettingsDialog onClose={() => (showSettings = false)} />
{/if}

<style>
    .shell {
        display: flex;
        flex-direction: column;
        height: 100%;
    }
    header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 0.5rem 1rem;
        border-bottom: 1px solid var(--border);
    }
    .brand {
        font-family: var(--font-display);
        font-size: 1.2rem;
    }
    .gear {
        background: none;
        border: none;
        color: var(--text);
        font-size: 1.2rem;
        cursor: pointer;
    }
    main {
        flex: 1;
        min-height: 0;
    }
    .note {
        padding: 1rem;
        color: var(--text-muted);
    }
    .link {
        background: none;
        border: none;
        color: var(--accent);
        cursor: pointer;
        font: inherit;
        text-decoration: underline;
    }
</style>
