<script>
    import {
        syncRosterStore,
        restoreRemoteSession,
        deleteForeverRemote,
        emptyTrashRemote,
    } from './sync-engine.js'

    /** Recoverable trash for synced sessions: archived branches the user
     *  can restore or permanently delete. Self-contained — owns its
     *  busy / confirm state and talks to the sync engine directly. */
    /** @type {{ syncConnected: boolean }} */
    let { syncConnected } = $props()

    let trashBusy = $state(false)
    let emptyTrashConfirm = $state(false)

    async function handleRestore(branch) {
        try {
            await restoreRemoteSession(branch)
        } catch (err) {
            console.error('Restore failed:', err)
        }
    }

    async function handleDeleteForever(branch) {
        if (trashBusy) return
        trashBusy = true
        try {
            await deleteForeverRemote(branch)
        } catch (err) {
            console.error('Delete forever failed:', err)
        } finally {
            trashBusy = false
        }
    }

    async function handleEmptyTrash() {
        if (trashBusy) return
        if (!emptyTrashConfirm) {
            emptyTrashConfirm = true
            setTimeout(() => { emptyTrashConfirm = false }, 4000)
            return
        }
        emptyTrashConfirm = false
        trashBusy = true
        try {
            await emptyTrashRemote()
        } catch (err) {
            console.error('Empty trash failed:', err)
        } finally {
            trashBusy = false
        }
    }
</script>

{#if syncConnected && $syncRosterStore.archived.length > 0}
    <details class="trash-section">
        <summary>Trash ({$syncRosterStore.archived.length})</summary>
        {#each $syncRosterStore.archived as a (a.branch)}
            <div class="trash-row">
                <code>{a.branch}</code>
                <span class="trash-actions">
                    <button class="action-btn" disabled={trashBusy} onclick={() => handleRestore(a.branch)}>
                        Restore
                    </button>
                    <button class="action-btn destructive" disabled={trashBusy} onclick={() => handleDeleteForever(a.branch)}>
                        Delete forever
                    </button>
                </span>
            </div>
        {/each}
        <button class="action-btn destructive trash-empty" disabled={trashBusy} onclick={handleEmptyTrash}>
            {emptyTrashConfirm ? 'Confirm: delete all forever?' : 'Empty trash'}
        </button>
        <div class="field-hint">
            Deleted synced sessions stay recoverable here until the
            trash is emptied.
        </div>
    </details>
{/if}

<style>
    .trash-section {
        margin: 0.5rem 1rem;
        font-size: 0.8rem;
        color: var(--text-muted);
    }

    .trash-section summary {
        cursor: pointer;
        padding: 0.25rem 0;
    }

    .trash-row {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 0;
    }

    .trash-actions {
        display: flex;
        gap: 0.4rem;
    }

    .trash-empty {
        margin-top: 0.4rem;
    }

    .action-btn {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.65rem;
        cursor: pointer;
        padding: 0 0.2rem;
        line-height: 1;
    }

    .action-btn:hover {
        color: var(--accent);
    }
</style>
