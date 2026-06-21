<script>
    import { untrack } from 'svelte'
    import Modal from './Modal.svelte'
    import { setSessionMeta } from './sessions.js'
    import { isSyncEnabled, setSyncEnabled, lastSyncStamps } from './sync-engine.js'
    import { remove as removeAppStorage, size as appStorageSize } from './app-storage.js'
    import { settingsStore } from './settings.js'
    import { formatBytes } from './bytes.js'
    import { relativeTime } from './format-time.js'

    /**
     * Per-session settings modal: name/description, the sync toggle, and
     * the export / publish / reset-app-data actions. The draft fields and
     * two-tap reset confirm are modal-local; the parent owns nothing here
     * beyond opening it with a session and handling the export/publish
     * launches (which close this modal first).
     */
    /** @type {{
     *   session: any,
     *   syncConnected: boolean,
     *   actionsBusy: boolean,
     *   onClose: () => void,
     *   onExport: (session: any) => void,
     *   onPublish: (session: any) => void,
     * }} */
    let { session, syncConnected, actionsBusy, onClose, onExport, onPublish } = $props()

    // Draft fields snapshot the session once: the modal is mounted fresh
    // per session (the parent gates it behind `{#if editingSession}`), so
    // the prop is constant for this instance's lifetime. `untrack` makes
    // that "initial value only" read intentional rather than a warning.
    let editName = $state(untrack(() => session.name || ''))
    let editDescription = $state(untrack(() => session.description || ''))
    let editSyncEnabled = $state(untrack(() => isSyncEnabled(session.branch)))
    let savingMeta = $state(false)
    let settingsResetConfirm = $state(false)
    // Local copy so the reset row hides immediately after a reset without
    // waiting for the next session-list refresh.
    let appBytes = $state(untrack(() => session.app_storage_bytes))

    async function handleSave(e) {
        e?.preventDefault?.()
        if (savingMeta) return
        savingMeta = true
        try {
            await setSessionMeta(session.branch, editName.trim(), editDescription.trim())
            onClose()
        } catch (err) {
            console.error('Failed to save session meta:', err)
        } finally {
            savingMeta = false
        }
    }

    function handleToggleSync(e) {
        editSyncEnabled = e.currentTarget.checked
        setSyncEnabled(session.branch, editSyncEnabled)
    }

    function handleReset() {
        if (!settingsResetConfirm) {
            settingsResetConfirm = true
            return
        }
        settingsResetConfirm = false
        try {
            removeAppStorage(session.kernel || 'py', session.branch)
            appBytes = appStorageSize(session.kernel || 'py', session.branch)
        } catch (err) {
            console.error('Failed to reset app storage:', err)
        }
    }
</script>

<Modal title="Session Settings" onClose={onClose}>
    <form onsubmit={handleSave}>
        <div class="modal-body">
            <div class="section-label">Details</div>
            <label class="field">
                <span class="field-label">Name</span>
                <!-- svelte-ignore a11y_autofocus -->
                <input type="text" bind:value={editName} placeholder={session.title} autofocus />
                <div class="field-hint">Custom label for this session. If blank, the agent-generated title ({session.title}) is used.</div>
            </label>
            <label class="field">
                <span class="field-label">Description</span>
                <textarea bind:value={editDescription} placeholder="What is this session for?" rows="4"></textarea>
                <div class="field-hint">Shown when sharing this session as an artifact.</div>
            </label>

            <div class="section-divider"></div>
            <div class="section-label">Sync &amp; Share</div>
            {#if syncConnected && session.kernel === 'ts'}
                <label class="field sync-toggle">
                    <span>
                        <input type="checkbox" checked={editSyncEnabled} onchange={handleToggleSync} />
                        Sync across your devices
                    </span>
                    <div class="field-hint">
                        Private and automatic, via {$settingsStore.syncRepo}.
                        Off keeps this session on this device only.
                    </div>
                    {#if editSyncEnabled}
                        {@const stamps = lastSyncStamps(session.branch)}
                        {#if stamps.syncedAt}
                            <div class="field-hint sync-ledger">
                                Last synced {relativeTime(stamps.syncedAt)}{stamps.appAt
                                    ? ` · app data ${relativeTime(stamps.appAt)}`
                                    : ''}
                            </div>
                        {/if}
                    {/if}
                </label>
            {/if}
            <div class="action-row">
                <button type="button" class="btn-action" onclick={() => onExport(session)} disabled={actionsBusy}>
                    Export bundle
                </button>
                <div class="action-hint">Download this session as a shareable <code>.agex</code> file.</div>
            </div>
            <div class="action-row">
                <button type="button" class="btn-action" onclick={() => onPublish(session)} disabled={actionsBusy}>
                    Publish to gist
                </button>
                <div class="action-hint">
                    {#if !$settingsStore.githubPat}
                        Add a GitHub token in Settings first (gist scope only).
                    {:else}
                        Snapshot a shareable link for others.
                        {#if !syncConnected && session.kernel === 'ts'}
                            Just moving between your own devices? Connect
                            Sync in Settings instead — it's automatic.
                        {/if}
                    {/if}
                </div>
            </div>
            {#if appBytes > 0}
                <div class="action-row">
                    <button
                        type="button"
                        class="btn-action destructive"
                        class:confirm={settingsResetConfirm}
                        onclick={handleReset}
                    >
                        {settingsResetConfirm ? 'Confirm reset?' : 'Reset app data'}
                    </button>
                    <div class="action-hint">
                        Clear {formatBytes(appBytes)} of app save data. The agent's code is preserved.
                    </div>
                </div>
            {/if}
        </div>
        <div class="modal-actions">
            <button type="button" class="btn-cancel" onclick={onClose}>Cancel</button>
            <button type="submit" class="btn-save" disabled={savingMeta}>
                {savingMeta ? 'Saving...' : 'Save'}
            </button>
        </div>
    </form>
</Modal>

<style>
    .sync-toggle input[type='checkbox'] {
        margin-right: 0.4rem;
        accent-color: var(--accent);
    }

    .action-row {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        margin-bottom: 0.4rem;
    }

    .action-row:last-child {
        margin-bottom: 0;
    }

    .btn-action {
        align-self: flex-start;
        padding: 0.4rem 0.75rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.78rem;
        font-family: inherit;
        cursor: pointer;
    }

    .btn-action:hover:not(:disabled) {
        border-color: var(--text-muted);
    }

    .btn-action:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .btn-action.destructive {
        color: var(--error);
        border-color: color-mix(in srgb, var(--error) 40%, var(--border));
    }

    .btn-action.destructive.confirm {
        background: color-mix(in srgb, var(--error) 15%, transparent);
        border-color: var(--error);
        font-weight: 600;
    }

    .action-hint {
        font-size: 0.7rem;
        color: var(--text-muted);
        line-height: 1.35;
    }

    .action-hint code {
        background: var(--input-bg, var(--surface));
        padding: 0.02rem 0.25rem;
        border-radius: 3px;
        font-size: 0.68rem;
    }
</style>
