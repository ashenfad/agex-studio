<script>
    import { settingsStore, updateSettings } from './settings.js'
    import { wakeLockSupported } from './wake-lock.js'
    import {
        notificationsSupported,
        notificationPermission,
        requestNotificationPermission,
    } from './notify.js'
    import { formatBytes } from './bytes.js'
    import { clearCache as clearSessionCache } from './session-index.js'
    import { clearAll as clearAllAppStorage } from './app-storage.js'
    import { CURRENT_BRANCH_KEY } from './sessions.js'

    // Drawer footer: device-level toggles (keep-awake, notify) plus the
    // storage readout and the destructive "purge all" button. Mounted
    // inside the drawer's `{#if open}`, so its on-mount seeding (storage
    // estimate, fresh notify permission) runs each time the drawer opens.

    // Notification permission, tracked reactively so the toggle reflects
    // a grant/denial immediately.
    let notifyPermission = $state(notificationPermission())
    // "denied" is a hard block the page can't undo (the user must change
    // it in browser settings) — surface that distinctly from "off".
    let notifyBlocked = $derived(notifyPermission === 'denied')

    let storageUsage = $state(null)
    let purgeConfirm = $state(false)
    let purging = $state(false)

    $effect(() => {
        // Runs once on mount (no reactive deps): seed the storage readout
        // and re-check notify permission in case it changed since boot.
        refreshStorageUsage()
        notifyPermission = notificationPermission()
    })

    async function refreshStorageUsage() {
        try {
            const est = await navigator.storage?.estimate?.()
            storageUsage = est?.usage ?? null
        } catch {
            // estimate() can fail under cross-origin / opaque contexts;
            // leave the previous reading rather than blanking it.
        }
    }

    async function toggleNotify() {
        if (!notificationsSupported() || notifyBlocked) return
        if ($settingsStore.notifyOnFinish) {
            updateSettings({ notifyOnFinish: false })
            return
        }
        // Turning on: ensure permission first so the flag never sits
        // "on but silently blocked."
        const perm =
            notificationPermission() === 'granted'
                ? 'granted'
                : await requestNotificationPermission()
        notifyPermission = perm
        if (perm === 'granted') {
            updateSettings({ notifyOnFinish: true })
        }
    }

    async function handlePurge() {
        if (!purgeConfirm) {
            purgeConfirm = true
            return
        }
        purging = true
        try {
            // Wipe session-related localStorage first — settings, API
            // keys, and UI prefs (split ratio, debug toggles) stay. The
            // "agex-current-branch" pointer is the active-session marker
            // that initSessions reads on the next load; wiping it forces
            // a clean restart.
            clearSessionCache()
            clearAllAppStorage()
            try { localStorage.removeItem(CURRENT_BRANCH_KEY) } catch {}

            // Delete all IndexedDB databases (kvgit-py session data for
            // now; @agex-ts/kvgit when Phase 5 lands).
            const dbs = await indexedDB.databases()
            await Promise.all(dbs.map(db =>
                new Promise((resolve) => {
                    const req = indexedDB.deleteDatabase(db.name)
                    req.onsuccess = resolve
                    req.onerror = resolve
                    req.onblocked = resolve  // worker holds connection
                })
            ))
            // Reload to re-initialize with clean state.
            window.location.reload()
        } catch {
            purging = false
            purgeConfirm = false
        }
    }
</script>

<div class="drawer-footer">
    <label
        class="keep-awake-row"
        class:disabled={!wakeLockSupported()}
        title={wakeLockSupported()
            ? 'Hold a screen wake lock while a session is working so the display does not dim. Released automatically when the tab is hidden.'
            : 'Your browser does not support the Wake Lock API.'}
    >
        <input
            type="checkbox"
            checked={$settingsStore.keepAwake}
            disabled={!wakeLockSupported()}
            onchange={() => updateSettings({ keepAwake: !$settingsStore.keepAwake })}
        />
        <span>Keep screen awake while working</span>
    </label>
    <label
        class="keep-awake-row"
        class:disabled={!notificationsSupported() || notifyBlocked}
        title={!notificationsSupported()
            ? 'Your browser does not support notifications.'
            : notifyBlocked
              ? 'Notifications are blocked for this site — re-enable them in your browser settings.'
              : 'Get a desktop notification when a session finishes while you are on another tab, window, app, or session.'}
    >
        <input
            type="checkbox"
            checked={$settingsStore.notifyOnFinish && !notifyBlocked}
            disabled={!notificationsSupported() || notifyBlocked}
            onchange={toggleNotify}
        />
        <span>Notify when a session finishes off-screen</span>
    </label>
    {#if storageUsage !== null}
        <span class="storage-usage" title="Includes cached packages">{formatBytes(storageUsage)} used (incl. cache)</span>
    {/if}
    <button
        class="purge-btn"
        class:confirm={purgeConfirm}
        onclick={handlePurge}
        disabled={purging}
    >
        {#if purging}
            Purging...
        {:else if purgeConfirm}
            Confirm purge?
        {:else}
            Purge all data
        {/if}
    </button>
</div>

<style>
    .drawer-footer {
        border-top: 1px solid var(--border);
        padding-top: 0.75rem;
        margin-top: 0.5rem;
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
    }

    /* Keep-screen-awake toggle — its own full-width row above the
       storage/purge line (footer wraps). */
    .keep-awake-row {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        font-size: 0.75rem;
        color: var(--text-muted);
        cursor: pointer;
    }

    .keep-awake-row input {
        cursor: pointer;
    }

    .keep-awake-row.disabled {
        opacity: 0.5;
        cursor: default;
    }

    .keep-awake-row.disabled input {
        cursor: default;
    }

    .storage-usage {
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .purge-btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        font-size: 0.7rem;
        padding: 0.3rem 0.6rem;
        border-radius: 4px;
        cursor: pointer;
        margin-left: auto;
    }

    .purge-btn:hover {
        color: var(--error);
        border-color: var(--error);
    }

    .purge-btn.confirm {
        color: var(--error);
        border-color: var(--error);
        font-weight: 600;
    }

    .purge-btn:disabled {
        opacity: 0.5;
        cursor: default;
    }
</style>
