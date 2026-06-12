<script>
    import {
        sessionStore,
        createSession,
        switchSession,
        deleteSession,
        forkSession,
        forkSessionFreshChat,
        setSessionMeta,
        exportBundle,
        importBundle,
        inspectBundle,
        getBundleStats,
        profilePublishSizes,
        CURRENT_BRANCH_KEY,
        hasSeenPyExperimentalWarning,
        markPyExperimentalWarningSeen,
        getSessionGistInfo,
        setSessionGistInfo,
        updateImportedSession,
        dismissImportedUpdate,
        checkImportedUpdates,
        markImportedUpdatesSeen,
    } from './sessions.js'
    import {
        remove as removeAppStorage,
        size as appStorageSize,
        clearAll as clearAllAppStorage,
    } from './app-storage.js'
    import { clearCache as clearSessionCache } from './session-index.js'
    import { peekSessionRuntime } from './session-runtime.svelte.js'
    import { settingsStore, updateSettings } from './settings.js'
    import { wakeLockSupported } from './wake-lock.js'
    import {
        notificationsSupported,
        notificationPermission,
        requestNotificationPermission,
    } from './notify.js'
    import { publishGistBundle, GistPublishError } from './gist-publish.js'
    import { formatBytes } from './bytes.js'
    import ForkModal from './ForkModal.svelte'
    import {
        downloadRemoteSession,
        deleteForeverRemote,
        emptyTrashRemote,
        forkDivergedSession,
        isSyncEnabled,
        lastSyncStamps,
        refreshRoster,
        resetSessionToRemote,
        repushSession,
        restoreRemoteSession,
        setSyncEnabled,
        syncNow,
        syncRosterStore,
        syncStatusStore,
    } from './sync-engine.js'

    /** @type {{ open: boolean, onClose: () => void }} */
    let { open, onClose } = $props()

    let sessions = $derived($sessionStore.sessions)
    let syncConnected = $derived(Boolean($settingsStore.syncRepo && $settingsStore.syncPat))

    // Re-rendered each minute while the drawer is open so the
    // relative "last synced" times don't go stale.
    let nowTick = $state(Date.now())
    $effect(() => {
        if (!open) return
        nowTick = Date.now()
        const timer = setInterval(() => {
            nowTick = Date.now()
        }, 60_000)
        return () => clearInterval(timer)
    })

    // No glyph for the steady state: a synced session is the norm, so
    // a standing ✓ is noise. The glyph only appears while something is
    // happening (queued / syncing) or wrong (attention states); synced
    // freshness lives in the timestamp's hover instead.
    function syncGlyph(state) {
        if (state === 'syncing') return '↻'
        if (state === 'pending') return '↑'
        return '⚠'
    }

    function syncGlyphTitle(status, _now) {
        const { state, detail } = status
        if (state === 'syncing') return detail ? `Syncing — ${detail}` : 'Syncing…'
        if (state === 'pending') return detail ? `Sync queued — ${detail}` : 'Sync queued'
        return detail || `Session sync: ${state}`
    }

    /** Hover ledger on the row's timestamp: when the session last
     *  changed, and (when synced) when that was last verified. The
     *  times themselves carry staleness — no glyph semantics needed. */
    function dateTitle(session, status, _now) {
        const updated = `Updated ${_relativeTime(session.updated)}`
        if (status?.state !== 'synced') return updated
        const app = status.appAt ? ` · app data ${_relativeTime(status.appAt)}` : ''
        return `${updated} · synced ${_relativeTime(status.at)}${app}`
    }

    // Per-branch resolution state for the inline attention rows.
    let resolvingBranch = $state('')
    let confirmResetBranch = $state('')

    async function handleRetrySync(branch) {
        resolvingBranch = branch
        try {
            await syncNow(branch)
        } finally {
            resolvingBranch = ''
        }
    }

    async function handleRepush(branch) {
        resolvingBranch = branch
        try {
            await repushSession(branch)
        } catch (err) {
            console.error('Re-push failed:', err)
        } finally {
            resolvingBranch = ''
        }
    }

    function handleKeepLocal(branch) {
        setSyncEnabled(branch, false)
    }

    // --- Roster / lifecycle actions ---
    let downloadingStub = $state('')
    let emptyTrashConfirm = $state(false)

    // Refresh the remote roster whenever the drawer opens (cheap:
    // a couple of GETs; engine no-ops when sync isn't connected).
    $effect(() => {
        if (open) void refreshRoster()
    })

    async function handleStubDownload(branch) {
        downloadingStub = branch
        try {
            await downloadRemoteSession(branch)
        } finally {
            downloadingStub = ''
        }
    }

    async function handleRestore(branch) {
        try {
            await restoreRemoteSession(branch)
        } catch (err) {
            console.error('Restore failed:', err)
        }
    }

    let trashBusy = $state(false)

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

    async function handleForkDiverged(branch) {
        resolvingBranch = branch
        try {
            await forkDivergedSession(branch)
        } catch (err) {
            console.error('Fork diverged failed:', err)
        } finally {
            resolvingBranch = ''
        }
    }

    async function handleResetToRemote(branch) {
        if (confirmResetBranch !== branch) {
            confirmResetBranch = branch
            setTimeout(() => {
                if (confirmResetBranch === branch) confirmResetBranch = ''
            }, 4000)
            return
        }
        confirmResetBranch = ''
        resolvingBranch = branch
        try {
            await resetSessionToRemote(branch)
        } catch (err) {
            console.error('Reset to remote failed:', err)
        } finally {
            resolvingBranch = ''
        }
    }
    let currentBranch = $derived($sessionStore.currentBranch)

    // On open: mark available updates as seen (clears the Header badge),
    // then re-poll imported sessions for newer gist revisions (lazy /
    // TTL-gated, so most are no-ops).
    $effect(() => {
        if (open) {
            markImportedUpdatesSeen()
            void checkImportedUpdates($settingsStore.githubPat)
        }
    })

    /** @type {string | null} */
    let updatingBranch = $state(null)

    async function handleUpdate(branch) {
        if (updatingBranch) return
        updatingBranch = branch
        try {
            await updateImportedSession(branch)
            // The session switched to the updated/opened version — close
            // the drawer so the user lands on it.
            onClose()
        } catch (e) {
            console.error('Session update failed:', e)
        } finally {
            updatingBranch = null
        }
    }

    // Manual "check for updates" — force-bypasses the lazy TTL on the
    // boot/open checks. Shown only when there are imported sessions.
    let hasImported = $derived(sessions.some((s) => s.imported))
    /** null | 'checking' | a transient result message */
    let checkState = $state(null)
    let checkTimer = null

    async function handleCheckUpdates() {
        if (checkState === 'checking') return
        checkState = 'checking'
        if (checkTimer) clearTimeout(checkTimer)
        try {
            const { updates } = await checkImportedUpdates(
                $settingsStore.githubPat,
                { force: true },
            )
            checkState =
                updates > 0
                    ? `${updates} update${updates === 1 ? '' : 's'} available`
                    : 'Up to date'
        } catch (e) {
            console.error('Update check failed:', e)
            checkState = 'Check failed'
        } finally {
            checkTimer = setTimeout(() => {
                checkState = null
            }, 4000)
        }
    }

    // Notification permission, tracked reactively so the toggle reflects
    // a grant/denial immediately. Seeded on open.
    let notifyPermission = $state(notificationPermission())
    // "denied" is a hard block the page can't undo (the user must change
    // it in browser settings) — surface that distinctly from "off".
    let notifyBlocked = $derived(notifyPermission === 'denied')

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

    let storageUsage = $state(null)
    let purgeConfirm = $state(false)
    let purging = $state(false)
    let deleteConfirmBranch = $state(null)
    /** Branch currently being deleted. Set immediately before
     *  `await deleteSession(...)` so the row can show a spinner /
     *  disable interaction; cleared in the surrounding finally. */
    let deletingBranch = $state(null)

    async function refreshStorageUsage() {
        try {
            const est = await navigator.storage?.estimate?.()
            storageUsage = est?.usage ?? null
        } catch {
            // estimate() can fail under cross-origin / opaque contexts;
            // leave the previous reading rather than blanking it.
        }
    }
    /** Which session's "⋯" overflow menu is currently open. Only
     *  surfaces at the mobile breakpoint (≤768px); on desktop the
     *  three individual icon buttons stay visible and this stays
     *  null. */
    let actionsMenuBranch = $state(null)
    let settingsResetConfirm = $state(false)

    /** Session being edited in the meta modal, or null when closed. */
    let editingSession = $state(null)
    /** Current draft values in the meta modal. */
    let editName = $state('')
    let editDescription = $state('')
    let savingMeta = $state(false)
    /** Sync toggle draft (applies immediately via setSyncEnabled, not
     *  on Save — it's device-local state, not session meta). */
    let editSyncEnabled = $state(true)

    /** Bundle being previewed before import, or null when no file loaded. */
    let importPreview = $state(null)  // { bytes, manifest }
    let importing = $state(false)
    let importError = $state('')

    /**
     * Export modal state machine:
     *   null              — modal closed
     *   { stage: 'loading', session }      — computing stats
     *   { stage: 'preview', session, stats }
     *   { stage: 'progress', session, stats, phase, done, total }
     *   { stage: 'done',    session, stats, manifest, bytes }
     *   { stage: 'error',   session, message }
     */
    let exportState = $state(null)

    /**
     * Publish modal state machine.  Mirrors export — same shape,
     * different terminal states (a runtime URL instead of a file
     * download).  Bundling reuses ``exportBundle`` so byte-for-byte
     * the artifact is identical to what export produces; publishing
     * is just "upload that bundle to a gist."
     *
     *   null                                                — closed
     *   { stage: 'bundling', session, phase, done, total }  — building bytes
     *   { stage: 'preview',  session, manifest, bytes, ack } — show inventory
     *   { stage: 'uploading', session, manifest, bytes }    — POST in flight
     *   { stage: 'done',      session, result }             — published
     *   { stage: 'error',     session, message }
     */
    let publishState = $state(null)
    /** Options-stage "?" explainer; collapsed by default so the
     *  shape list stays scannable. */
    let publishHelpOpen = $state(false)
    /** Copy-flash state for the post-publish URL fields.  Tagged so
     *  the two URL rows (play, showcase) can independently flash
     *  "Copied!"; `null` means neither is flashing. */
    /** @type {null | 'play' | 'showcase'} */
    let copyFlash = $state(null)

    /** @type {HTMLInputElement | undefined} */
    let fileInput = $state()

    $effect(() => {
        if (open) {
            purgeConfirm = false
            deleteConfirmBranch = null
            settingsResetConfirm = false
            refreshStorageUsage()
            notifyPermission = notificationPermission()
        }
    })


    async function handlePurge() {
        if (!purgeConfirm) {
            purgeConfirm = true
            return
        }
        purging = true
        try {
            // Wipe session-related localStorage first — settings,
            // API keys, and UI prefs (split ratio, debug toggles)
            // stay. The "agex-current-branch" pointer is the active-
            // session marker that initSessions reads on the next
            // load; wiping it forces a clean restart.
            clearSessionCache()
            clearAllAppStorage()
            try { localStorage.removeItem(CURRENT_BRANCH_KEY) } catch {}

            // Delete all IndexedDB databases (kvgit-py session data
            // for now; @agex-ts/kvgit when Phase 5 lands).
            const dbs = await indexedDB.databases()
            await Promise.all(dbs.map(db =>
                new Promise((resolve) => {
                    const req = indexedDB.deleteDatabase(db.name)
                    req.onsuccess = resolve
                    req.onerror = resolve
                    req.onblocked = resolve  // worker holds connection
                })
            ))
            // Reload to re-initialize with clean state
            window.location.reload()
        } catch {
            purging = false
            purgeConfirm = false
        }
    }

    /** Pending kernel for the experimental-warning modal — set when
     *  the user clicks `+ Py` on a browser that hasn't dismissed the
     *  warning yet. `null` when the modal is closed. */
    let pendingPyConfirm = $state(false)

    /** Whether the "more create options" dropdown is open. The split-
     *  button design keeps `+ New` (TS) as the dominant action and
     *  tucks the experimental py-create behind a chevron edge. */
    let createMenuOpen = $state(false)

    async function handleNew(kernel) {
        if (kernel === 'py' && !hasSeenPyExperimentalWarning()) {
            pendingPyConfirm = true
            return
        }
        try {
            await createSession({ kernel })
            onClose()
        } catch (e) {
            console.error('Failed to create session:', e)
        }
    }

    async function confirmPyCreate() {
        markPyExperimentalWarningSeen()
        pendingPyConfirm = false
        try {
            await createSession({ kernel: 'py' })
            onClose()
        } catch (e) {
            console.error('Failed to create session:', e)
        }
    }

    // ForkModal state. We collect the source-branch title at
    // click time so the modal stays purely presentational — given
    // a title + a confirm callback, it doesn't reach into the
    // session store itself.
    let forkModalOpen = $state(false)
    let forkSourceBranch = $state(null)

    /** @type {{ title: string } | null} */
    let forkSourceInfo = $derived.by(() => {
        if (!forkSourceBranch) return null
        const s = $sessionStore.sessions.find((x) => x.branch === forkSourceBranch)
        if (!s) return null
        return { title: s.title || 'New Chat' }
    })

    async function handleFork(e, branch) {
        e.stopPropagation()
        forkSourceBranch = branch
        forkModalOpen = true
    }

    async function handleForkConfirm(mode) {
        const branch = forkSourceBranch
        if (!branch) return
        try {
            if (branch !== currentBranch) {
                await switchSession(branch)
            }
            if (mode === 'fresh') {
                await forkSessionFreshChat()
            } else {
                await forkSession()
            }
            forkModalOpen = false
            forkSourceBranch = null
        } catch (err) {
            console.error('Failed to fork session:', err)
            // Leave the modal open so the user can retry / cancel
            // rather than silently losing their click.
        }
    }

    async function handleSwitch(branch) {
        if (branch === currentBranch) return
        try {
            await switchSession(branch)
        } catch (e) {
            console.error('Failed to switch session:', e)
        }
    }

    async function handleDelete(e, branch) {
        e.stopPropagation()
        if (deleteConfirmBranch !== branch) {
            deleteConfirmBranch = branch
            return
        }
        deleteConfirmBranch = null
        // Surface a spinner on the row while the delete (which now
        // includes the kvgit orphan sweep — see ts-agent.js's
        // deleteBranch) is in flight. Without this the button just
        // sits silent for the duration of a multi-MB sweep.
        deletingBranch = branch
        try {
            await deleteSession(branch)
            // Reclaimed storage shows up in `navigator.storage.estimate()`
            // after the underlying IDB write commits. Re-fetch so the
            // "used" line below the session list updates without
            // requiring a page reload.
            await refreshStorageUsage()
        } catch (e) {
            console.error('Failed to delete session:', e)
        } finally {
            deletingBranch = null
        }
    }

    /** Toggle the mobile "⋯" overflow menu for a given session row.
     *  Tapping the same row's button again closes it; opening one
     *  row's menu while another is open closes the other. */
    function toggleActionsMenu(e, branch) {
        e.stopPropagation()
        actionsMenuBranch = actionsMenuBranch === branch ? null : branch
        // Reset any in-flight delete confirm when opening a fresh
        // menu so the destructive item shows its initial label.
        if (actionsMenuBranch !== branch) deleteConfirmBranch = null
    }

    function closeActionsMenu() {
        actionsMenuBranch = null
    }

    function handleSettingsReset() {
        if (!editingSession) return
        if (!settingsResetConfirm) {
            settingsResetConfirm = true
            return
        }
        settingsResetConfirm = false
        try {
            removeAppStorage(editingSession.kernel || 'py', editingSession.branch)
            // Update the local view of editingSession's bytes count
            // immediately so the reset row hides without waiting for
            // the next session-list refresh.
            editingSession = {
                ...editingSession,
                app_storage_bytes: appStorageSize(
                    editingSession.kernel || 'py',
                    editingSession.branch,
                ),
            }
        } catch (err) {
            console.error('Failed to reset app storage:', err)
        }
    }

    function handleSettingsExport() {
        if (!editingSession) return
        const target = editingSession
        closeEdit()
        // Fire the existing export flow (preview → progress → done).
        handleExport({ stopPropagation: () => {} }, target)
    }

    function handleSettingsPublish() {
        if (!editingSession) return
        const target = editingSession
        closeEdit()
        startPublish(target)
    }

    /** Start the publish flow. ts sessions get a shape-choice stage
     *  first (full history vs tip snapshot, image treatment) with
     *  approximate per-shape sizes; py goes straight to bundling. */
    async function startPublish(session) {
        if (publishState) return
        if (session.kernel === 'ts') {
            publishState = {
                stage: 'options',
                session,
                estimates: null,
                shape: $settingsStore.publishShape || 'full',
            }
            try {
                const sized = await profilePublishSizes(session.branch)
                if (publishState?.stage === 'options' && publishState.session === session) {
                    publishState = { ...publishState, estimates: sized?.estimates ?? null }
                }
            } catch (err) {
                // Estimates are a nicety — the options still work
                // without numbers next to them.
                console.warn('publish size profile failed:', err)
            }
            return
        }
        await bundleForPublish(session, 'full')
    }

    /** Options stage confirmed: remember the shape, then bundle. */
    async function proceedPublish() {
        if (publishState?.stage !== 'options') return
        const { session, shape } = publishState
        updateSettings({ publishShape: shape })
        await bundleForPublish(session, shape)
    }

    async function bundleForPublish(session, shape) {
        publishState = { stage: 'bundling', session, phase: 'walking', done: 0, total: 0 }
        try {
            const { bytes, manifest } = await exportBundle(session.branch, (p) => {
                if (publishState?.stage === 'bundling') {
                    publishState = { ...publishState, phase: p.phase, done: p.done, total: p.total }
                }
            }, { shape })
            // Look up any existing gist mapping for this branch. When
            // present, this publish will PATCH that gist (preserving
            // the share URL) instead of creating a new one.
            //
            // Note we do NOT special-case `session.external` here.
            // The localStorage entry is written by *this* user's prior
            // publishes (`setSessionGistInfo` only ever runs from
            // confirmPublish's success branch); it can't refer to the
            // original publisher's gist. So if the entry exists for
            // an imported-then-published session, it's a gist we
            // created and own — PATCH is correct. The "this is an
            // imported session" UI hint below still surfaces when
            // there's no prior publish, so first-time publishers
            // of imports still understand they're creating a fresh
            // gist under their account.
            const priorGist = getSessionGistInfo(session.branch)
            publishState = {
                stage: 'preview',
                session,
                manifest,
                bytes,
                ack: false,
                priorGist,
                // 'existing' (PATCH the prior gist, same URL) vs 'new'
                // (POST a fresh gist). Default to updating when this branch
                // earned the mapping, but to a new gist for an inherited
                // (fresh-fork) mapping so we don't overwrite the parent's
                // share URL by default. No prior gist → always 'new'.
                target: priorGist && !priorGist.inherited ? 'existing' : 'new',
            }
        } catch (err) {
            console.error('Failed to bundle for publish:', err)
            publishState = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    function closePublish() {
        if (publishState?.stage === 'bundling' || publishState?.stage === 'uploading') return
        publishState = null
        copyFlash = null
        publishHelpOpen = false
    }

    /** "· ~1.3 MB" suffix for a shape option; '' until estimates load
     *  (or when profiling failed — options work without numbers). */
    function publishSizeHint(shape) {
        const est = publishState?.estimates
        if (!est) return ''
        const v = {
            full: est.full,
            flat: est.flat,
            'flat-downsample': est.flatDownsampled,
            'flat-strip': est.flatStripped,
        }[shape]
        return v == null ? '' : ` · ~${formatBytes(Math.max(0, v))}`
    }

    /** Coarse "X ago" formatter for the publish destination's
     *  last-published timestamp. Days / months / years; we don't
     *  need finer than that for "this gist was published recently
     *  vs. a while back" — just enough to remind the user that
     *  the prior publish is real and connected to this session. */
    function _relativeTime(iso) {
        try {
            const then = new Date(iso).getTime()
            if (Number.isNaN(then)) return ''
            const sec = Math.max(0, Math.floor((Date.now() - then) / 1000))
            if (sec < 60) return 'just now'
            const min = Math.floor(sec / 60)
            if (min < 60) return `${min}m ago`
            const hr = Math.floor(min / 60)
            if (hr < 24) return `${hr}h ago`
            const days = Math.floor(hr / 24)
            if (days < 30) return `${days}d ago`
            const months = Math.floor(days / 30)
            if (months < 12) return `${months}mo ago`
            return `${Math.floor(months / 12)}y ago`
        } catch {
            return ''
        }
    }

    async function confirmPublish() {
        if (!publishState || publishState.stage !== 'preview' || !publishState.ack) return
        const { session, manifest, bytes, priorGist, target } = publishState
        // Only PATCH the prior gist when the user chose "update existing".
        // A "new" choice (or no prior gist) POSTs a fresh one.
        const useExisting = target === 'existing' && !!priorGist
        const pat = $settingsStore.githubPat || ''
        if (!pat) {
            publishState = {
                stage: 'error',
                session,
                message: 'No GitHub Personal Access Token in Settings. Add one with the gist scope and try again.',
            }
            return
        }
        publishState = { stage: 'uploading', session, manifest, bytes }
        try {
            const result = await publishGistBundle({
                pat,
                bytes,
                manifest,
                // Name → gist filename slug + first line of gist
                // description.  Capped to keep the gist description
                // readable on github.com's list view.
                name: (session.name || session.title || '').slice(0, 100),
                // Optional second line.  Sessions get an editable
                // description field in the per-session settings
                // modal; if set, surface it on the published gist
                // alongside the name.
                description: (session.description || '').slice(0, 300),
                // When set, PATCH the prior gist (preserving the
                // share URL). publishGistBundle falls back to POST
                // if the gist was deleted out from under us. Empty when
                // the user chose "new gist".
                existingGistId: useExisting ? priorGist.gistId : '',
                existingSlug: useExisting ? priorGist.slug : '',
            })
            // Persist the (possibly new) mapping for future updates.
            // After a 404-fallback the gistId/slug differ from
            // priorGist; setSessionGistInfo records whatever the
            // publish actually landed.
            setSessionGistInfo(session.branch, {
                gistId: result.gistId,
                slug: result.slug,
                lastPublishedAt: new Date().toISOString(),
            })
            // Detect a 404-fallback: the user chose "update existing" but
            // publishGistBundle landed on a *different* gist (the prior was
            // deleted on github.com out from under us, PATCH 404'd, POST
            // fired). Surface this on the done modal so the user
            // understands why the share URL is new. Gated on `useExisting`
            // so an intentional "new gist" publish isn't mislabeled as a
            // fallback.
            const fallbackFromGistId =
                useExisting && priorGist.gistId !== result.gistId
                    ? priorGist.gistId
                    : ''
            publishState = { stage: 'done', session, result, fallbackFromGistId }
        } catch (err) {
            console.error('Publish failed:', err)
            const message = err instanceof GistPublishError
                ? err.message
                : (err.message || String(err))
            publishState = { stage: 'error', session, message }
        }
    }

    async function copyPublishUrl(url, which) {
        if (publishState?.stage !== 'done') return
        try {
            await navigator.clipboard.writeText(url)
            copyFlash = which
            setTimeout(() => {
                // Only clear if we still own the flash; a follow-up
                // copy on the other field would have overwritten it
                // already, and clearing here would race that.
                if (copyFlash === which) copyFlash = null
            }, 2000)
        } catch (err) {
            console.error('Copy failed:', err)
        }
    }

    /** Open a prefilled GitHub issue against agex-studio with the
     *  just-published gist's URLs and session metadata, so the user
     *  can submit their app for inclusion in the curated gallery.
     *  We use `body=` to prefill rather than `template=` because
     *  GitHub's behavior when both are present is inconsistent;
     *  the markdown template at `.github/ISSUE_TEMPLATE/` covers
     *  the path where someone hits "New issue" on github.com
     *  directly. `labels=` lands the issue in the triage queue. */
    function submitToGallery() {
        if (publishState?.stage !== 'done') return
        const session = publishState.session
        // Gallery submissions use the *pinned* URL form (embeds the
        // gist's commit SHA at publish time) so a curated entry can't
        // silently change content after admission. Friend-share URLs
        // in the publish modal stay HEAD-tracking — publishers can
        // still iterate post-share — but the gallery wants byte-
        // immutability for vetting. Falls back to the unpinned URL
        // if `runtimeUrlPinned` is unavailable (defensive against an
        // older publishGistBundle return shape).
        const showcaseUrl = publishState.result.runtimeUrlPinned || publishState.result.runtimeUrl
        const playUrl = `${showcaseUrl}&play=1`
        const name = (session.name || session.title || 'Untitled').trim()
        const description = (session.description || '').trim()
        const issueTitle = `Gallery: ${name}`
        const body = [
            `**App URL (play mode):** ${playUrl}`,
            `**Studio URL (showcase):** ${showcaseUrl}`,
            '',
            `**Title:** ${name}`,
            '',
            `**Description:**`,
            description || '_(none provided — feel free to add one here)_',
            '',
            `**Tags:** _(a few short labels — e.g. \`game\`, \`dashboard\`, \`education\`, \`kids\`, \`data\`, \`creative\`, \`utility\`)_`,
            '',
            `**Screenshot:** _(drag an image into this box)_`,
            '',
        ].join('\n')
        const url = `https://github.com/ashenfad/agex-studio/issues/new`
            + `?labels=gallery-candidate`
            + `&title=${encodeURIComponent(issueTitle)}`
            + `&body=${encodeURIComponent(body)}`
        window.open(url, '_blank', 'noopener')
    }

    function handleEdit(e, session) {
        e.stopPropagation()
        editingSession = session
        editName = session.name || ''
        editDescription = session.description || ''
        editSyncEnabled = isSyncEnabled(session.branch)
    }

    function closeEdit() {
        editingSession = null
        editName = ''
        editDescription = ''
        settingsResetConfirm = false
    }

    async function handleExport(e, session) {
        e.stopPropagation()
        if (exportState) return
        exportState = { stage: 'loading', session }
        try {
            const stats = await getBundleStats(session.branch)
            exportState = { stage: 'preview', session, stats }
        } catch (err) {
            console.error('Failed to read bundle stats:', err)
            exportState = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    function closeExport() {
        if (exportState?.stage === 'progress') return  // don't allow closing mid-export
        exportState = null
    }

    async function confirmExport() {
        if (!exportState || exportState.stage !== 'preview') return
        const { session, stats } = exportState
        exportState = { stage: 'progress', session, stats, phase: 'walking', done: 0, total: 0 }
        try {
            const { bytes, manifest } = await exportBundle(session.branch, (p) => {
                if (exportState?.stage === 'progress') {
                    exportState = { ...exportState, phase: p.phase, done: p.done, total: p.total }
                }
            })
            exportState = { stage: 'done', session, stats, manifest, bytes }
            triggerDownload(session, manifest, bytes)
        } catch (err) {
            console.error('Failed to export bundle:', err)
            exportState = { stage: 'error', session, message: err.message || String(err) }
        }
    }

    function triggerDownload(session, manifest, bytes) {
        const label = (manifest.name || session.title || session.branch).trim() || session.branch
        const safe = label.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'session'
        const blob = new Blob([bytes], { type: 'application/zip' })
        const url = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = url
        a.download = `${safe}.agex`
        document.body.appendChild(a)
        a.click()
        a.remove()
        URL.revokeObjectURL(url)
    }

    function phaseLabel(phase) {
        switch (phase) {
            case 'walking': return 'Walking history'
            case 'packing-commits': return 'Packing commits'
            case 'packing-nodes': return 'Packing nodes'
            case 'packing-blobs': return 'Packing blobs'
            case 'finalizing': return 'Finalizing'
            default: return phase
        }
    }

    function openImportPicker() {
        importError = ''
        fileInput?.click()
    }

    async function handleFileSelected(e) {
        const file = e.target.files?.[0]
        e.target.value = ''  // reset so same file re-select fires change
        if (!file) return
        importError = ''
        try {
            const bytes = new Uint8Array(await file.arrayBuffer())
            const manifest = await inspectBundle(bytes)
            importPreview = { bytes, manifest }
        } catch (err) {
            console.error('Failed to read bundle:', err)
            importError = `Could not read bundle: ${err.message || err}`
        }
    }

    function closeImportPreview() {
        if (importing) return
        importPreview = null
        importError = ''
    }

    async function handleConfirmImport() {
        if (!importPreview || importing) return
        importing = true
        try {
            await importBundle(importPreview.bytes)
            importPreview = null
            onClose()
        } catch (err) {
            console.error('Failed to import bundle:', err)
            importError = `Import failed: ${err.message || err}`
        } finally {
            importing = false
        }
    }

    async function handleSaveMeta(e) {
        e?.preventDefault?.()
        if (!editingSession || savingMeta) return
        savingMeta = true
        try {
            await setSessionMeta(
                editingSession.branch,
                editName.trim(),
                editDescription.trim(),
            )
            closeEdit()
        } catch (err) {
            console.error('Failed to save session meta:', err)
        } finally {
            savingMeta = false
        }
    }

    function formatDate(iso) {
        if (!iso) return ''
        const d = new Date(iso)
        const now = new Date()
        const diff = now.getTime() - d.getTime()
        if (diff < 60000) return 'just now'
        if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`
        if (diff < 604800000) return `${Math.floor(diff / 86400000)}d ago`
        return d.toLocaleDateString()
    }
</script>

{#if open}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="overlay" onclick={onClose} onkeydown={(e) => e.key === 'Escape' && onClose()}></div>
    <div class="drawer">
        <div class="drawer-header">
            <h2>Sessions</h2>
            <div class="header-actions">
                <button class="header-btn" onclick={openImportPicker} title="Import a bundle">Import</button>
                <div class="split-btn-group">
                    <button
                        class="new-btn kernel-ts split-btn-main"
                        onclick={() => handleNew('ts')}
                        title="New TypeScript session (recommended)"
                    >+ New</button>
                    <button
                        class="split-btn-edge"
                        onclick={() => (createMenuOpen = !createMenuOpen)}
                        title="More create options"
                        aria-label="More create options"
                        aria-expanded={createMenuOpen}
                    >
                        <svg width="10" height="10" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <polyline points="3 5 6 8 9 5"></polyline>
                        </svg>
                    </button>
                    {#if createMenuOpen}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div
                            class="split-menu-backdrop"
                            onclick={() => (createMenuOpen = false)}
                            onkeydown={(e) => e.key === 'Escape' && (createMenuOpen = false)}
                        ></div>
                        <div class="split-menu" role="menu">
                            <button
                                class="split-menu-item"
                                role="menuitem"
                                onclick={() => { createMenuOpen = false; handleNew('py') }}
                            >
                                <span class="split-menu-item-label">Python session</span>
                                <span class="split-menu-item-tag">experimental</span>
                            </button>
                        </div>
                    {/if}
                </div>
            </div>
        </div>
        <input
            bind:this={fileInput}
            type="file"
            accept=".agex,.zip,application/zip"
            style="display: none"
            onchange={handleFileSelected}
        />
        {#if importError}
            <div class="import-error">{importError}</div>
        {/if}

        {#if hasImported}
            <div class="update-check-bar">
                <button
                    class="update-check-btn"
                    onclick={handleCheckUpdates}
                    disabled={checkState === 'checking'}
                    title="Check imported sessions for newer gist revisions"
                >{checkState === 'checking' ? 'Checking…' : 'Check for updates'}</button>
                {#if checkState && checkState !== 'checking'}
                    <span class="update-check-status">{checkState}</span>
                {/if}
            </div>
        {/if}

        <div class="session-list">
            {#each sessions as s (s.branch)}
                {@const rt = peekSessionRuntime(s.branch)}
                <!-- svelte-ignore a11y_no_static_element_interactions -->
                <div
                    class="session-item"
                    class:active={s.branch === currentBranch}
                    onclick={() => handleSwitch(s.branch)}
                    onkeydown={(e) => e.key === 'Enter' && handleSwitch(s.branch)}
                    role="button"
                    tabindex="0"
                >
                    <div class="session-title">
                        {#if rt?.busy}
                            <span class="status-dot working" title="Working…"></span>
                        {:else if rt?.unseen}
                            <span class="status-dot unseen" title="New result — not yet viewed"></span>
                        {/if}
                        {s.name || s.title}
                    </div>
                    {#if s.description}
                        <div class="session-description" title={s.description}>{s.description}</div>
                    {/if}
                    {#if s.updateAvailable}
                        <!-- svelte-ignore a11y_no_static_element_interactions -->
                        <div class="update-row" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
                            <span class="update-label">Update available</span>
                            <button
                                class="update-btn"
                                disabled={updatingBranch === s.branch}
                                onclick={() => handleUpdate(s.branch)}
                            >{updatingBranch === s.branch ? 'Updating…' : 'Update'}</button>
                            <button
                                class="update-dismiss"
                                title="Ignore this version"
                                onclick={() => dismissImportedUpdate(s.branch)}
                            >&times;</button>
                        </div>
                    {/if}
                    {#if syncConnected && s.kernel === 'ts' && $syncStatusStore[s.branch]}
                        {@const syncStatus = $syncStatusStore[s.branch]}
                        {#if ['diverged', 'error', 'remote-gone'].includes(syncStatus.state)}
                        <div class="update-row" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
                            {#if syncStatus.state === 'diverged'}
                                <span class="update-label">Diverged — changed on another device</span>
                                <button
                                    class="update-btn"
                                    disabled={resolvingBranch === s.branch}
                                    onclick={() => handleForkDiverged(s.branch)}
                                >Keep both</button>
                                <button
                                    class="update-btn"
                                    disabled={resolvingBranch === s.branch}
                                    onclick={() => handleResetToRemote(s.branch)}
                                >{confirmResetBranch === s.branch ? 'Discard local turns?' : 'Take synced'}</button>
                            {:else if syncStatus.state === 'error'}
                                <span class="update-label" title={syncStatus.detail}>Sync error</span>
                                <button
                                    class="update-btn"
                                    disabled={resolvingBranch === s.branch}
                                    onclick={() => handleRetrySync(s.branch)}
                                >Retry</button>
                            {:else}
                                <span class="update-label">Removed from sync repo elsewhere</span>
                                <button
                                    class="update-btn"
                                    disabled={resolvingBranch === s.branch}
                                    onclick={() => handleRepush(s.branch)}
                                >Sync again</button>
                                <button
                                    class="update-btn"
                                    disabled={resolvingBranch === s.branch}
                                    onclick={() => handleKeepLocal(s.branch)}
                                >Keep local</button>
                            {/if}
                        </div>
                        {/if}
                    {/if}
                    <div class="session-meta">
                        <span class="session-date">
                            <span
                                class="kernel-badge kernel-{s.kernel || 'py'}"
                                title="Runtime kernel: {s.kernel === 'ts' ? 'TypeScript (agex-ts)' : 'Python (agex-py) — experimental, larger sandbox surface'}"
                            >{s.kernel || 'py'}{(s.kernel || 'py') === 'py' ? ' · exp' : ''}</span>
                            {#if syncConnected && s.kernel === 'ts' && $syncStatusStore[s.branch] && $syncStatusStore[s.branch].state !== 'synced'}
                                <span
                                    class="sync-glyph sync-{$syncStatusStore[s.branch].state}"
                                    title={syncGlyphTitle($syncStatusStore[s.branch], nowTick)}
                                >{syncGlyph($syncStatusStore[s.branch].state)}</span>
                            {/if}
                            {#if $syncStatusStore[s.branch]?.state === 'syncing' && $syncStatusStore[s.branch].detail}
                                <span class="sync-progress">{$syncStatusStore[s.branch].detail}</span>
                            {:else}
                                <span title={dateTitle(s, $syncStatusStore[s.branch], nowTick)}>{formatDate(s.updated)}</span>
                            {/if}
                            {#if s.app_storage_bytes > 0}
                                <span class="app-storage-badge" title="App save data: {formatBytes(s.app_storage_bytes)}">· app</span>
                            {/if}
                        </span>
                        <span class="session-actions">
                            <!-- Desktop layout: three icon buttons inline.
                                 Hidden at ≤768px via media query; mobile
                                 sees the overflow menu below instead. -->
                            <span class="desktop-actions">
                            <button
                                class="action-btn icon-btn"
                                onclick={(e) => handleFork(e, s.branch)}
                                title="Fork session"
                                aria-label="Fork session"
                            >
                                <!-- Feather "git-branch" — vertical
                                     trunk on the left, branch arcing
                                     off to a node on the right. Reads
                                     unambiguously as "fork" at this
                                     14px size next to the gear. -->
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                    <line x1="6" y1="3" x2="6" y2="15"></line>
                                    <circle cx="18" cy="6" r="3"></circle>
                                    <circle cx="6" cy="18" r="3"></circle>
                                    <path d="M18 9a9 9 0 0 1-9 9"></path>
                                </svg>
                            </button>
                            <button
                                class="action-btn icon-btn"
                                onclick={(e) => handleEdit(e, s)}
                                title="Session settings"
                                aria-label="Session settings"
                            >
                                &#9881;
                            </button>
                            {#if sessions.length > 1}
                                <button
                                    class="action-btn delete"
                                    class:confirm={deleteConfirmBranch === s.branch}
                                    onclick={(e) => handleDelete(e, s.branch)}
                                    disabled={!!deletingBranch}
                                    title="Delete session"
                                >
                                    {#if deletingBranch === s.branch}
                                        <span class="row-spinner" aria-label="Deleting"></span>
                                    {:else if deleteConfirmBranch === s.branch}
                                        delete?
                                    {:else}
                                        {'\u00d7'}
                                    {/if}
                                </button>
                            {/if}
                            </span>

                            <!-- Mobile layout: single overflow trigger;
                                 popover surfaces the three actions as
                                 touch-friendly menu items. Visible only
                                 at \u2264768px via CSS, AND only on the
                                 active row \u2014 inactive rows stay
                                 chrome-free (tap to switch, then act).
                                 Mirrors the desktop hover-to-reveal
                                 pattern at the touch breakpoint:
                                 actions surface only when the row is
                                 "current context." -->
                            <span
                                class="mobile-actions"
                                class:hidden={s.branch !== currentBranch}
                            >
                                <button
                                    class="action-btn icon-btn overflow-btn"
                                    onclick={(e) => toggleActionsMenu(e, s.branch)}
                                    title="Session actions"
                                    aria-label="Session actions"
                                    aria-expanded={actionsMenuBranch === s.branch}
                                >
                                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                                        <circle cx="5" cy="12" r="2"></circle>
                                        <circle cx="12" cy="12" r="2"></circle>
                                        <circle cx="19" cy="12" r="2"></circle>
                                    </svg>
                                </button>
                                {#if actionsMenuBranch === s.branch}
                                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                                    <div
                                        class="menu-backdrop"
                                        onclick={(e) => { e.stopPropagation(); closeActionsMenu() }}
                                        onkeydown={(e) => e.key === 'Escape' && closeActionsMenu()}
                                    ></div>
                                    <div class="actions-menu" role="menu">
                                        <button
                                            class="actions-menu-item"
                                            role="menuitem"
                                            onclick={(e) => { handleFork(e, s.branch); closeActionsMenu() }}
                                        >
                                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                <line x1="6" y1="3" x2="6" y2="15"></line>
                                                <circle cx="18" cy="6" r="3"></circle>
                                                <circle cx="6" cy="18" r="3"></circle>
                                                <path d="M18 9a9 9 0 0 1-9 9"></path>
                                            </svg>
                                            <span>Fork</span>
                                        </button>
                                        <button
                                            class="actions-menu-item"
                                            role="menuitem"
                                            onclick={(e) => { handleEdit(e, s); closeActionsMenu() }}
                                        >
                                            <span class="menu-gear" aria-hidden="true">&#9881;</span>
                                            <span>Settings</span>
                                        </button>
                                        {#if sessions.length > 1}
                                            <button
                                                class="actions-menu-item destructive"
                                                class:confirm={deleteConfirmBranch === s.branch}
                                                role="menuitem"
                                                disabled={!!deletingBranch}
                                                onclick={(e) => {
                                                    const wasArmed = deleteConfirmBranch === s.branch
                                                    handleDelete(e, s.branch)
                                                    // If the first tap (arming the confirm), keep
                                                    // the menu open so the second tap lands on
                                                    // the same visible button. If already armed,
                                                    // the row is gone \u2014 nothing to close.
                                                    if (wasArmed) closeActionsMenu()
                                                }}
                                            >
                                                {#if deletingBranch === s.branch}
                                                    <span class="row-spinner" aria-hidden="true"></span>
                                                {:else}
                                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                                                        <polyline points="3 6 5 6 21 6"></polyline>
                                                        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path>
                                                        <path d="M10 11v6"></path>
                                                        <path d="M14 11v6"></path>
                                                    </svg>
                                                {/if}
                                                <span>
                                                    {#if deletingBranch === s.branch}
                                                        Deleting…
                                                    {:else if deleteConfirmBranch === s.branch}
                                                        Tap again to delete
                                                    {:else}
                                                        Delete
                                                    {/if}
                                                </span>
                                            </button>
                                        {/if}
                                    </div>
                                {/if}
                            </span>
                        </span>
                    </div>
                </div>
            {/each}

            <!-- Cloud stubs: sessions that exist in the sync repo but
                 not on this device. Download materializes them. -->
            {#if syncConnected}
                {#each $syncRosterStore.remoteOnly as r (r.branch)}
                    <div class="session-item cloud-stub">
                        <div class="stub-title">☁ {r.title || 'Cloud session'}</div>
                        <div class="session-meta">
                            <span class="session-date"><code>{r.branch}</code></span>
                            <button
                                class="action-btn stub-download"
                                disabled={downloadingStub === r.branch}
                                onclick={() => handleStubDownload(r.branch)}
                            >
                                {downloadingStub === r.branch
                                    ? $syncStatusStore[r.branch]?.detail || 'Downloading…'
                                    : 'Download'}
                            </button>
                        </div>
                    </div>
                {/each}
            {/if}
        </div>

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

        <!-- Gallery entry — sits below the session list. Opens the
             static `/gallery/` page in the same tab; users return to
             the editor via the gallery's own "Open editor" button.
             Hidden when the gallery JSON is empty would be nice but
             requires a fetch; for the very small steady-state size
             (a handful of items), always-show is fine. -->
        <a class="gallery-link" href="/gallery/">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="7" height="7" rx="1"></rect>
                <rect x="14" y="3" width="7" height="7" rx="1"></rect>
                <rect x="3" y="14" width="7" height="7" rx="1"></rect>
                <rect x="14" y="14" width="7" height="7" rx="1"></rect>
            </svg>
            <span>Browse gallery</span>
            <span class="gallery-link-chevron">→</span>
        </a>


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
    </div>
{/if}

{#if exportState}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="modal-overlay"
        onclick={closeExport}
        onkeydown={(e) => e.key === 'Escape' && closeExport()}
    ></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Export Session</h3>
        </div>

        {#if exportState.stage === 'loading'}
            <div class="modal-body">
                <div class="stage-loading">Reading session...</div>
            </div>
        {:else if exportState.stage === 'preview'}
            <div class="modal-body">
                <div class="preview-field">
                    <span class="field-label">Name</span>
                    <div class="preview-value">
                        {exportState.stats.name || exportState.stats.title || '(untitled)'}
                    </div>
                </div>
                {#if exportState.stats.description}
                    <div class="preview-field">
                        <span class="field-label">Description</span>
                        <div class="preview-value preview-description">
                            {exportState.stats.description}
                        </div>
                    </div>
                {/if}
                <div class="preview-field">
                    <span class="field-label">Contents</span>
                    <div class="preview-value preview-stats">
                        {exportState.stats.commits} commits
                    </div>
                </div>
                <div class="preview-hint">
                    Downloads a self-contained <code>.agex</code> bundle you can share, archive, or re-import as a new session.
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closeExport}>Cancel</button>
                <button type="button" class="btn-save" onclick={confirmExport}>Export</button>
            </div>
        {:else if exportState.stage === 'progress'}
            <div class="modal-body">
                <div class="progress-label">{phaseLabel(exportState.phase)}</div>
                <div class="progress-bar">
                    <div
                        class="progress-fill"
                        class:indeterminate={!exportState.total}
                        style={exportState.total
                            ? `width: ${Math.round((exportState.done / exportState.total) * 100)}%`
                            : ''}
                    ></div>
                </div>
                <div class="progress-counts">
                    {#if exportState.total}
                        {exportState.done} / {exportState.total}
                    {:else}
                        working...
                    {/if}
                </div>
            </div>
        {:else if exportState.stage === 'done'}
            <div class="modal-body">
                <div class="stage-done">
                    <div class="done-check">✓</div>
                    <div class="done-message">
                        Bundle downloaded.
                    </div>
                    <div class="preview-stats">
                        {exportState.manifest.stats?.commits ?? 0} commits ·
                        {formatBytes(exportState.bytes.length)}
                    </div>
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-save" onclick={closeExport}>Close</button>
            </div>
        {:else if exportState.stage === 'error'}
            <div class="modal-body">
                <div class="import-error">{exportState.message}</div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closeExport}>Close</button>
            </div>
        {/if}
    </div>
{/if}

{#if publishState}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="modal-overlay"
        onclick={closePublish}
        onkeydown={(e) => e.key === 'Escape' && closePublish()}
    ></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Publish to Gist</h3>
        </div>

        {#if publishState.stage === 'options'}
            <div class="modal-body">
                <div class="preview-field">
                    <span class="field-label">
                        What to include
                        <button
                            type="button"
                            class="help-toggle"
                            class:open={publishHelpOpen}
                            aria-label="Explain the options"
                            onclick={() => publishHelpOpen = !publishHelpOpen}
                        >?</button>
                    </span>
                    {#if publishHelpOpen}
                        <div class="publish-help">
                            <strong>Everything</strong> keeps the full session
                            history, so importers can undo into past turns.
                            <strong>Current state</strong> drops that history —
                            the app, files, and conversation stay intact.
                            The image options also re-encode observed images
                            (screenshots, rendered pages) smaller, or replace
                            them with placeholders. Files you uploaded are
                            never touched.
                        </div>
                    {/if}
                    <div class="destination-choice">
                        <label class="destination-option">
                            <input type="radio" name="publish-shape" value="full" bind:group={publishState.shape} />
                            <span class="destination-option-title">Everything{publishSizeHint('full')}</span>
                        </label>
                        <label class="destination-option">
                            <input type="radio" name="publish-shape" value="flat" bind:group={publishState.shape} />
                            <span class="destination-option-title">Current state{publishSizeHint('flat')}</span>
                        </label>
                        <label class="destination-option">
                            <input type="radio" name="publish-shape" value="flat-downsample" bind:group={publishState.shape} />
                            <span class="destination-option-title">Current state, smaller images{publishSizeHint('flat-downsample')}</span>
                        </label>
                        <label class="destination-option">
                            <input type="radio" name="publish-shape" value="flat-strip" bind:group={publishState.shape} />
                            <span class="destination-option-title">Current state, no images{publishSizeHint('flat-strip')}</span>
                        </label>
                    </div>
                    {#if !publishState.estimates}
                        <div class="destination-detail">estimating sizes…</div>
                    {/if}
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closePublish}>Cancel</button>
                <button type="button" class="btn-save" onclick={proceedPublish}>Continue</button>
            </div>
        {:else if publishState.stage === 'bundling'}
            <div class="modal-body">
                <div class="progress-label">{phaseLabel(publishState.phase)}</div>
                <div class="progress-bar">
                    <div
                        class="progress-fill"
                        class:indeterminate={!publishState.total}
                        style={publishState.total
                            ? `width: ${Math.round((publishState.done / publishState.total) * 100)}%`
                            : ''}
                    ></div>
                </div>
                <div class="progress-counts">
                    {#if publishState.total}
                        {publishState.done} / {publishState.total}
                    {:else}
                        bundling...
                    {/if}
                </div>
            </div>
        {:else if publishState.stage === 'preview'}
            <div class="modal-body">
                <div class="preview-field">
                    <span class="field-label">Name</span>
                    <div class="preview-value">
                        {publishState.session.name || publishState.session.title || '(untitled)'}
                    </div>
                </div>
                <div class="preview-field">
                    <span class="field-label">Bundle</span>
                    <div class="preview-value preview-stats">
                        {publishState.manifest.stats?.commits ?? 0} commits ·
                        {formatBytes(Math.ceil(publishState.bytes.length * 4 / 3))}
                    </div>
                </div>
                <div class="preview-field">
                    <span class="field-label">Destination</span>
                    {#if publishState.priorGist}
                        <!-- A prior gist mapping exists (this branch
                             published before, or inherited it from a fork).
                             Let the user update it (same URL) or split off a
                             new gist. -->
                        <div class="destination-choice">
                            <label class="destination-option">
                                <input
                                    type="radio"
                                    name="publish-target"
                                    value="existing"
                                    bind:group={publishState.target}
                                />
                                <span class="destination-option-body">
                                    <span class="destination-option-title">Update existing gist</span>
                                    <span class="destination-detail">
                                        <a
                                            href={`https://gist.github.com/${publishState.priorGist.gistId}`}
                                            target="_blank"
                                            rel="noopener"
                                            class="destination-link"
                                            onclick={(e) => e.stopPropagation()}
                                        >gist.github.com/…/{publishState.priorGist.gistId.slice(0, 8)}</a>
                                        {#if publishState.priorGist.lastPublishedAt}
                                            · last published {_relativeTime(publishState.priorGist.lastPublishedAt)}
                                        {/if}
                                        — keeps the same share URL
                                    </span>
                                </span>
                            </label>
                            <label class="destination-option">
                                <input
                                    type="radio"
                                    name="publish-target"
                                    value="new"
                                    bind:group={publishState.target}
                                />
                                <span class="destination-option-body">
                                    <span class="destination-option-title">Create a new gist</span>
                                    <span class="destination-detail">
                                        publishes as a separate app with its own URL{#if publishState.priorGist.inherited} — this is a forked copy{/if}
                                    </span>
                                </span>
                            </label>
                        </div>
                    {:else}
                        <div class="preview-value">
                            New gist
                            <div class="destination-detail">
                                {#if publishState.session.external}
                                    this is an imported session — publishing creates a fresh gist under your account
                                {:else}
                                    this session has not been published from this browser before
                                {/if}
                            </div>
                        </div>
                    {/if}
                </div>
                <div class="publish-disclosure">
                    <strong>Anyone with the URL can see everything in this bundle</strong> — your conversation history, agent-authored helper modules, the app, and any data persisted into the session.  Treat this like an "anyone with the link" share, not a private copy.
                </div>
                <label class="publish-ack">
                    <input
                        type="checkbox"
                        bind:checked={publishState.ack}
                    />
                    <span>I understand the bundle will be publicly accessible by URL.</span>
                </label>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closePublish}>Cancel</button>
                <button type="button" class="btn-save" onclick={confirmPublish} disabled={!publishState.ack}>
                    Publish
                </button>
            </div>
        {:else if publishState.stage === 'uploading'}
            <div class="modal-body">
                <div class="progress-label">Uploading to GitHub...</div>
                <div class="progress-bar">
                    <div class="progress-fill indeterminate"></div>
                </div>
            </div>
        {:else if publishState.stage === 'done'}
            <div class="modal-body">
                <div class="stage-done">
                    <div class="done-check">✓</div>
                    <div class="done-message">Published as a secret gist</div>
                </div>
                {#if publishState.fallbackFromGistId}
                    <!-- 404-fallback notice: preview promised "Update
                         existing gist", but the prior gist was no longer
                         reachable on github.com (deleted, renamed by
                         owner, scope changed, etc.), so we created a
                         fresh one instead. Explains why the URL below
                         differs from what the preview showed. -->
                    <div class="publish-notice">
                        Your previous gist at
                        <a
                            href={`https://gist.github.com/${publishState.fallbackFromGistId}`}
                            target="_blank"
                            rel="noopener"
                        >gist.github.com/…/{publishState.fallbackFromGistId.slice(0, 8)}</a>
                        was no longer reachable — created a fresh one instead.
                    </div>
                {/if}
                <div class="preview-field">
                    <span class="field-label">
                        Share with users
                        <span class="field-hint">— app-only view, no chat chrome</span>
                    </span>
                    <div class="publish-url-row">
                        <input
                            type="text"
                            class="publish-url-input"
                            readonly
                            value={`${publishState.result.runtimeUrl}&play=1`}
                            onfocus={(e) => e.target.select()}
                        />
                        <button type="button" class="btn-copy" onclick={() => copyPublishUrl(`${publishState.result.runtimeUrl}&play=1`, 'play')}>
                            {copyFlash === 'play' ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                </div>
                <div class="preview-field">
                    <span class="field-label">
                        Share with builders
                        <span class="field-hint">— split view, see how it was made</span>
                    </span>
                    <div class="publish-url-row">
                        <input
                            type="text"
                            class="publish-url-input"
                            readonly
                            value={publishState.result.runtimeUrl}
                            onfocus={(e) => e.target.select()}
                        />
                        <button type="button" class="btn-copy" onclick={() => copyPublishUrl(publishState.result.runtimeUrl, 'showcase')}>
                            {copyFlash === 'showcase' ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                </div>
                <div class="publish-secondary">
                    <button type="button" class="btn-gallery" onclick={submitToGallery} title="Submit to the agex.studio gallery">
                        ✨ Submit to gallery
                    </button>
                    <a href={publishState.result.gistHtmlUrl} target="_blank" rel="noopener">View on GitHub ↗</a>
                </div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-save" onclick={closePublish}>Close</button>
            </div>
        {:else if publishState.stage === 'error'}
            <div class="modal-body">
                <div class="import-error">{publishState.message}</div>
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closePublish}>Close</button>
            </div>
        {/if}
    </div>
{/if}

{#if importPreview}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={closeImportPreview} onkeydown={(e) => e.key === 'Escape' && closeImportPreview()}></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Import Bundle</h3>
        </div>
        <div class="modal-body">
            <div class="preview-field">
                <span class="field-label">Name</span>
                <div class="preview-value">{importPreview.manifest.name || '(untitled)'}</div>
            </div>
            {#if importPreview.manifest.description}
                <div class="preview-field">
                    <span class="field-label">Description</span>
                    <div class="preview-value preview-description">{importPreview.manifest.description}</div>
                </div>
            {/if}
            {#if importPreview.manifest.author}
                <div class="preview-field">
                    <span class="field-label">Author</span>
                    <div class="preview-value">{importPreview.manifest.author}</div>
                </div>
            {/if}
            <div class="preview-field">
                <span class="field-label">Kernel</span>
                <div class="preview-value">
                    <span class="kernel-badge kernel-{importPreview.manifest.kernel || 'py'}">
                        {importPreview.manifest.kernel || 'py'}{(importPreview.manifest.kernel || 'py') === 'py' ? ' · exp' : ''}
                    </span>
                    {(importPreview.manifest.kernel || 'py') === 'ts' ? 'TypeScript (agex-ts)' : 'Python (agex-py) — experimental'}
                </div>
            </div>
            <div class="preview-field">
                <span class="field-label">Contents</span>
                <div class="preview-value preview-stats">
                    {importPreview.manifest.stats?.commits ?? 0} commits ·
                    {importPreview.manifest.stats?.blobs ?? 0} blobs ·
                    {formatBytes(importPreview.bytes.length)}
                </div>
            </div>
            {#if (importPreview.manifest.kernel || 'py') === 'py'}
                <div class="import-py-warning">
                    Python uses a softer sandbox than the TypeScript kernel.
                    Only import Python sessions from sources you trust.
                </div>
            {/if}
            {#if importError}
                <div class="import-error">{importError}</div>
            {/if}
        </div>
        <div class="modal-actions">
            <button type="button" class="btn-cancel" onclick={closeImportPreview} disabled={importing}>Cancel</button>
            <button type="button" class="btn-save" onclick={handleConfirmImport} disabled={importing}>
                {importing ? 'Importing...' : 'Import as new session'}
            </button>
        </div>
    </div>
{/if}

{#if pendingPyConfirm}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="modal-overlay"
        onclick={() => (pendingPyConfirm = false)}
        onkeydown={(e) => e.key === 'Escape' && (pendingPyConfirm = false)}
    ></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Heads up — Python kernel</h3>
        </div>
        <div class="modal-body">
            <p class="py-warning-text">
                Python sessions boot Pyodide plus pandas / NumPy / SciPy /
                Plotly. First boot takes ~30 seconds and uses meaningful
                browser memory; subsequent boots are cached.
            </p>
            <p class="py-warning-text">
                The Python sandbox is softer than the TypeScript interpreter
                sandbox — broader network access, more plausible escape
                paths if something goes wrong. Use only with code you trust.
                The TypeScript kernel is recommended for new work.
            </p>
        </div>
        <div class="modal-actions">
            <button type="button" class="btn-cancel" onclick={() => (pendingPyConfirm = false)}>Cancel</button>
            <button type="button" class="btn-save" onclick={confirmPyCreate}>Got it, create session</button>
        </div>
    </div>
{/if}

{#if editingSession}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="modal-overlay" onclick={closeEdit} onkeydown={(e) => e.key === 'Escape' && closeEdit()}></div>
    <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-header">
            <h3>Session Settings</h3>
        </div>
        <form onsubmit={handleSaveMeta}>
            <div class="modal-body">
                <div class="section-label">Details</div>
                <label class="field">
                    <span class="field-label">Name</span>
                    <input
                        type="text"
                        bind:value={editName}
                        placeholder={editingSession.title}
                        autofocus
                    />
                    <div class="field-hint">Custom label for this session. If blank, the agent-generated title ({editingSession.title}) is used.</div>
                </label>
                <label class="field">
                    <span class="field-label">Description</span>
                    <textarea
                        bind:value={editDescription}
                        placeholder="What is this session for?"
                        rows="4"
                    ></textarea>
                    <div class="field-hint">Shown when sharing this session as an artifact.</div>
                </label>

                <div class="section-divider"></div>
                <div class="section-label">Sync &amp; Share</div>
                {#if syncConnected && editingSession.kernel === 'ts'}
                    <label class="field sync-toggle">
                        <span>
                            <input
                                type="checkbox"
                                checked={editSyncEnabled}
                                onchange={(e) => {
                                    editSyncEnabled = e.currentTarget.checked
                                    setSyncEnabled(editingSession.branch, editSyncEnabled)
                                }}
                            />
                            Sync across your devices
                        </span>
                        <div class="field-hint">
                            Private and automatic, via {$settingsStore.syncRepo}.
                            Off keeps this session on this device only.
                        </div>
                        {#if editSyncEnabled}
                            {@const stamps = lastSyncStamps(editingSession.branch)}
                            {#if stamps.syncedAt}
                                <div class="field-hint sync-ledger">
                                    Last synced {_relativeTime(stamps.syncedAt)}{stamps.appAt
                                        ? ` · app data ${_relativeTime(stamps.appAt)}`
                                        : ''}
                                </div>
                            {/if}
                        {/if}
                    </label>

                {/if}
                <div class="action-row">
                    <button
                        type="button"
                        class="btn-action"
                        onclick={handleSettingsExport}
                        disabled={!!exportState || !!publishState}
                    >
                        Export bundle
                    </button>
                    <div class="action-hint">Download this session as a shareable <code>.agex</code> file.</div>
                </div>
                <div class="action-row">
                    <button
                        type="button"
                        class="btn-action"
                        onclick={handleSettingsPublish}
                        disabled={!!exportState || !!publishState}
                    >
                        Publish to gist
                    </button>
                    <div class="action-hint">
                        {#if !$settingsStore.githubPat}
                            Add a GitHub token in Settings first (gist scope only).
                        {:else}
                            Snapshot a shareable link for others.
                            {#if !syncConnected && editingSession.kernel === 'ts'}
                                Just moving between your own devices? Connect
                                Sync in Settings instead — it's automatic.
                            {/if}
                        {/if}
                    </div>
                </div>
                {#if editingSession.app_storage_bytes > 0}
                    <div class="action-row">
                        <button
                            type="button"
                            class="btn-action destructive"
                            class:confirm={settingsResetConfirm}
                            onclick={handleSettingsReset}
                        >
                            {settingsResetConfirm ? 'Confirm reset?' : 'Reset app data'}
                        </button>
                        <div class="action-hint">
                            Clear {formatBytes(editingSession.app_storage_bytes)} of app
                            save data. The agent's code is preserved.
                        </div>
                    </div>
                {/if}
            </div>
            <div class="modal-actions">
                <button type="button" class="btn-cancel" onclick={closeEdit}>Cancel</button>
                <button type="submit" class="btn-save" disabled={savingMeta}>
                    {savingMeta ? 'Saving...' : 'Save'}
                </button>
            </div>
        </form>
    </div>
{/if}

<ForkModal
    open={forkModalOpen}
    sourceTitle={forkSourceInfo?.title ?? ''}
    onClose={() => { forkModalOpen = false; forkSourceBranch = null }}
    onConfirm={handleForkConfirm}
/>

<style>
    .overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 100;
    }

    .drawer {
        position: fixed;
        top: 0;
        left: 0;
        bottom: 0;
        width: 300px;
        max-width: 85vw;
        background: var(--surface);
        border-right: 1px solid var(--border);
        padding: 1.25rem;
        z-index: 101;
        display: flex;
        flex-direction: column;
    }

    .drawer-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 1rem;
    }

    h2 {
        font-size: 1.1rem;
        font-weight: 600;
    }

    .new-btn {
        color: white;
        border: none;
        border-radius: 6px;
        padding: 0.35rem 0.6rem;
        font-size: 0.8rem;
        font-weight: 600;
        cursor: pointer;
    }

    /* Split-button group: primary `+ New` (creates TS) plus a small
       chevron edge that opens a dropdown for alternates (currently
       just py-experimental). Visual hierarchy is firmly on the
       primary action; py-create is one click further in but
       discoverable via the chevron affordance.

       The two buttons render as visually fused — shared height,
       borderless seam between them, single rounded rectangle
       enclosing both. Chevron stays in the TS kernel color so the
       group reads as a single unit. */
    .split-btn-group {
        position: relative;
        display: inline-flex;
        align-items: stretch;
    }

    .new-btn.kernel-ts {
        background: #3b82f6;
    }

    .new-btn.kernel-ts:hover {
        background: #2563eb;
    }

    .split-btn-main {
        border-top-right-radius: 0;
        border-bottom-right-radius: 0;
    }

    .split-btn-edge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        padding: 0 0.4rem;
        background: #3b82f6;
        color: white;
        border: none;
        border-left: 1px solid color-mix(in srgb, #ffffff 20%, transparent);
        border-top-right-radius: 6px;
        border-bottom-right-radius: 6px;
        cursor: pointer;
    }

    .split-btn-edge:hover {
        background: #2563eb;
    }

    .split-btn-edge svg {
        flex-shrink: 0;
    }

    /* Dropdown menu sits below the split button, aligned to the
       right edge so it stays inside the drawer on narrow viewports.
       Backdrop is a full-viewport overlay that catches click-out
       without forcing us to wire a document-level listener. */
    .split-menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
    }

    .split-menu {
        position: absolute;
        top: calc(100% + 0.3rem);
        right: 0;
        z-index: 201;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 6px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
        min-width: 220px;
        padding: 0.25rem;
    }

    .split-menu-item {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.6rem;
        width: 100%;
        padding: 0.45rem 0.6rem;
        background: none;
        color: var(--text);
        border: none;
        border-radius: 4px;
        font-size: 0.85rem;
        text-align: left;
        cursor: pointer;
    }

    .split-menu-item:hover {
        background: var(--surface-hover);
    }

    .split-menu-item-label {
        color: var(--text);
        white-space: nowrap;
    }

    .split-menu-item-tag {
        font-size: 0.65rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 0.1rem 0.35rem;
        border-radius: 3px;
        background: color-mix(in srgb, var(--warning) 18%, transparent);
        color: var(--warning);
        white-space: nowrap;
    }

    .header-actions {
        display: flex;
        align-items: center;
        gap: 0.4rem;
    }

    .header-btn {
        background: none;
        color: var(--text-muted);
        border: 1px solid var(--border);
        border-radius: 6px;
        padding: 0.3rem 0.6rem;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
    }

    .header-btn:hover {
        color: var(--text);
        border-color: var(--text-muted);
    }

    .import-error {
        margin: 0 0 0.5rem 0;
        padding: 0.4rem 0.6rem;
        background: color-mix(in srgb, var(--error) 15%, transparent);
        border: 1px solid var(--error);
        border-radius: 4px;
        color: var(--error);
        font-size: 0.72rem;
    }

    /* Trust warning when importing a Python session bundle. Same
       shape as `.import-error` but warning-colored rather than
       error-colored — it's a heads-up, not a failure. Only renders
       when the bundle's manifest declares kernel === 'py'. */
    .import-py-warning {
        margin: 0.5rem 0 0 0;
        padding: 0.45rem 0.6rem;
        background: color-mix(in srgb, var(--warning) 12%, transparent);
        border: 1px solid color-mix(in srgb, var(--warning) 55%, transparent);
        border-radius: 4px;
        color: var(--warning);
        font-size: 0.78rem;
        line-height: 1.45;
    }

    .preview-field {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .preview-value {
        font-size: 0.85rem;
        color: var(--text);
    }

    .preview-description {
        white-space: pre-wrap;
        line-height: 1.4;
    }

    .preview-stats {
        font-size: 0.75rem;
        color: var(--text-muted);
    }

    /* Inline info notice for the publish-done modal — fires when a
       404-fallback created a new gist instead of updating the prior
       one the preview promised. Soft warning tone (not an error;
       publish succeeded), with the prior gist linkable so the user
       can confirm it's gone. */
    .publish-notice {
        background: color-mix(in srgb, var(--warning, #d29922) 12%, transparent);
        border-left: 2px solid color-mix(in srgb, var(--warning, #d29922) 60%, transparent);
        padding: 0.45rem 0.65rem;
        border-radius: 0 4px 4px 0;
        font-size: 0.78rem;
        color: var(--text);
        line-height: 1.4;
    }

    .publish-notice a {
        color: inherit;
        text-decoration: underline;
    }

    .publish-notice a:hover {
        color: var(--accent);
    }

    /* Publish destination sub-line — sits under the main value
       ("Update existing gist" / "New gist") with the linkable gist
       URL fragment + relative timestamp. Muted so the parent value
       reads as the primary message. */
    .destination-detail {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-top: 0.15rem;
        line-height: 1.35;
    }

    /* New-vs-existing gist radio choice in the publish preview. */
    .destination-choice {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        margin-top: 0.1rem;
    }

    .destination-option {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        cursor: pointer;
    }

    .destination-option input[type="radio"] {
        margin-top: 0.15rem;
        flex-shrink: 0;
        cursor: pointer;
    }

    .destination-option-body {
        display: flex;
        flex-direction: column;
    }

    .destination-option-title {
        font-size: 0.85rem;
        color: var(--text);
    }

    .destination-option .destination-detail {
        margin-top: 0.1rem;
    }

    .destination-link {
        color: var(--text-muted);
        text-decoration: underline;
    }

    /* The publish options' "?" explainer — a tap target (tooltips
       don't exist on touch) toggling one compact help block. */
    .help-toggle {
        width: 1.05rem;
        height: 1.05rem;
        padding: 0;
        margin-left: 0.35rem;
        border: 1px solid var(--border);
        border-radius: 50%;
        background: transparent;
        color: var(--text-muted);
        font-size: 0.7rem;
        line-height: 1;
        cursor: pointer;
        vertical-align: middle;
    }

    .help-toggle.open,
    .help-toggle:hover {
        color: var(--text);
        border-color: var(--text-muted);
    }

    .publish-help {
        font-size: 0.72rem;
        color: var(--text-muted);
        line-height: 1.45;
        margin: 0.25rem 0 0.4rem;
    }

    .publish-help strong {
        color: var(--text);
        font-weight: 500;
    }

    .destination-link:hover {
        color: var(--text);
    }

    .preview-hint {
        font-size: 0.72rem;
        color: var(--text-muted);
        line-height: 1.4;
    }

    .publish-disclosure {
        background: rgba(255, 200, 100, 0.10);
        border-left: 2px solid rgba(255, 165, 0, 0.7);
        padding: 0.55rem 0.7rem;
        border-radius: 0 4px 4px 0;
        font-size: 0.78rem;
        line-height: 1.4;
        color: var(--text);
    }

    .publish-disclosure strong {
        color: var(--text);
        font-weight: 600;
    }


    .publish-ack {
        display: flex;
        gap: 0.5rem;
        align-items: flex-start;
        font-size: 0.78rem;
        line-height: 1.4;
        cursor: pointer;
    }

    .publish-ack input[type="checkbox"] {
        margin-top: 0.15rem;
        flex-shrink: 0;
    }

    .publish-url-row {
        display: flex;
        gap: 0.4rem;
        align-items: stretch;
    }

    .publish-url-input {
        flex: 1;
        font-family: var(--mono, ui-monospace, monospace);
        font-size: 0.75rem;
        padding: 0.4rem 0.5rem;
        background: var(--input-bg, var(--surface));
        border: 1px solid var(--border);
        border-radius: 4px;
        color: var(--text);
        min-width: 0;
    }

    .publish-url-input:focus {
        outline: 2px solid var(--accent);
        outline-offset: -1px;
    }

    .btn-copy {
        background: var(--accent);
        color: white;
        border: none;
        border-radius: 4px;
        padding: 0 0.8rem;
        font-size: 0.75rem;
        font-weight: 600;
        cursor: pointer;
        white-space: nowrap;
    }

    .btn-copy:hover {
        filter: brightness(1.1);
    }

    .publish-secondary {
        font-size: 0.75rem;
        color: var(--text-muted);
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.5rem;
        flex-wrap: wrap;
    }

    .publish-secondary a {
        color: var(--text-muted);
        text-decoration: underline;
    }

    .publish-secondary a:hover {
        color: var(--text);
    }

    /* "Submit to gallery" button — secondary action sitting next to
       the View-on-GitHub link.  Subtle so it doesn't compete with
       Copy/Close, but tinted so it reads as a real CTA. */
    .btn-gallery {
        background: color-mix(in srgb, var(--accent) 12%, transparent);
        color: var(--accent);
        border: 1px solid color-mix(in srgb, var(--accent) 30%, transparent);
        padding: 0.35rem 0.65rem;
        border-radius: 6px;
        font-size: 0.75rem;
        font-weight: 500;
        cursor: pointer;
    }

    .btn-gallery:hover {
        background: color-mix(in srgb, var(--accent) 20%, transparent);
    }

    /* Inline hint after the all-caps field label.  Lowercase + muted
       so the structure (LABEL — context) reads naturally. */
    .field-hint {
        text-transform: none;
        letter-spacing: 0;
        font-weight: 400;
        opacity: 0.7;
    }

    .preview-hint code {
        background: var(--input-bg, var(--surface));
        padding: 0.05rem 0.25rem;
        border-radius: 3px;
        font-size: 0.7rem;
    }

    .stage-loading {
        font-size: 0.85rem;
        color: var(--text-muted);
        padding: 0.5rem 0;
    }

    .progress-label {
        font-size: 0.8rem;
        color: var(--text);
        margin-bottom: 0.4rem;
    }

    .progress-bar {
        height: 6px;
        background: var(--input-bg, var(--surface));
        border-radius: 3px;
        overflow: hidden;
        position: relative;
    }

    .progress-fill {
        height: 100%;
        background: var(--accent);
        transition: width 0.15s ease-out;
    }

    .progress-fill.indeterminate {
        width: 30%;
        animation: progress-indeterminate 1.2s ease-in-out infinite;
    }

    @keyframes progress-indeterminate {
        0% { transform: translateX(-100%); }
        100% { transform: translateX(400%); }
    }

    .progress-counts {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-top: 0.35rem;
        text-align: right;
    }

    .stage-done {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.35rem;
        padding: 0.4rem 0;
    }

    .done-check {
        font-size: 2rem;
        color: var(--accent);
        line-height: 1;
    }

    .done-message {
        font-size: 0.9rem;
        color: var(--text);
    }

    .session-list {
        flex: 1;
        overflow-y: auto;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .session-item {
        padding: 0.6rem 0.75rem;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        /* `relative` so the mobile overflow button can absolute-
           anchor to the row's top-right corner without stretching
           the meta line (the button's 44px touch target was
           pushing inactive vs active rows to different heights). */
        position: relative;
    }

    .session-item:hover {
        background: var(--surface-hover);
    }

    .session-item.active {
        background: var(--surface-hover);
        border-left: 2px solid var(--accent);
    }

    .session-title {
        font-size: 0.85rem;
        font-weight: 500;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    /* Per-session status indicator before the title. `working` pulses
       like the chat's thinking dot (a turn is in flight on this
       session); `unseen` is a steady badge — the turn finished while
       the user was looking at another session and hasn't been viewed. */
    .status-dot {
        display: inline-block;
        width: 6px;
        height: 6px;
        border-radius: 50%;
        margin-right: 0.4rem;
        vertical-align: middle;
        flex-shrink: 0;
    }

    .status-dot.working {
        background: var(--accent);
        animation: session-pulse 1.2s ease-in-out infinite;
    }

    /* Distinct from the working dot: a steady GREEN dot (done, ready to
       view) vs the blue pulsing one (in flight). No ring — the title's
       `overflow: hidden` clips it. */
    .status-dot.unseen {
        background: var(--success);
    }

    @keyframes session-pulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.35; }
    }

    /* Manual "check for updates" bar — shown only when ≥1 imported
       session exists. Forces a check past the lazy TTL. */
    .update-check-bar {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.3rem 1rem 0;
    }

    .update-check-btn {
        background: none;
        border: 1px solid var(--border);
        color: var(--text-muted);
        border-radius: 4px;
        padding: 0.18rem 0.5rem;
        font-size: 0.72rem;
        cursor: pointer;
    }

    .update-check-btn:hover:not(:disabled) {
        color: var(--text);
        background: var(--surface-hover);
    }

    .update-check-btn:disabled { opacity: 0.6; cursor: default; }

    .update-check-status {
        font-size: 0.72rem;
        color: var(--text-muted);
    }

    /* "Update available" affordance on an imported session's card. */
    .update-row {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        margin: 0.3rem 0 0.1rem;
    }

    .update-label {
        font-size: 0.72rem;
        color: var(--success);
        font-weight: 500;
    }

    .update-btn {
        background: var(--success);
        color: #fff;
        border: none;
        border-radius: 4px;
        padding: 0.12rem 0.45rem;
        font-size: 0.7rem;
        font-weight: 600;
        cursor: pointer;
    }

    .update-btn:hover { filter: brightness(1.08); }
    .update-btn:disabled { opacity: 0.6; cursor: default; }

    .update-dismiss {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 0.95rem;
        line-height: 1;
        cursor: pointer;
        padding: 0 0.15rem;
    }

    .update-dismiss:hover { color: var(--text); }

    .session-description {
        font-size: 0.72rem;
        color: var(--text-muted);
        margin-top: 0.15rem;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .py-warning-text {
        color: var(--text);
        font-size: 0.88rem;
        line-height: 1.5;
        margin: 0 0 0.75rem;
    }

    .py-warning-text:last-child {
        margin-bottom: 0;
    }

    .session-meta {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }

    .session-date {
        font-size: 0.7rem;
        color: var(--text-muted);
    }

    .app-storage-badge {
        /* Identity fact, not status — neutral, not accent. */
        color: var(--text-muted);
        opacity: 0.8;
        margin-left: 0.15rem;
    }

    /* Status glyph appears only while sync is active or unhappy —
       healthy rows show nothing (freshness rides the timestamp hover).
       Color scale: muted for in-flight, amber for needs-a-look, red
       for broken — words live in the tooltip and the action rows. */
    .sync-progress {
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
    }

    .sync-glyph {
        margin-right: 0.15rem;
        font-size: 0.7rem;
    }

    .sync-glyph.sync-pending {
        color: var(--text-muted);
    }

    .sync-glyph.sync-syncing {
        color: var(--text-muted);
        display: inline-block;
        animation: sync-spin 1.2s linear infinite;
    }

    .sync-glyph.sync-diverged,
    .sync-glyph.sync-remote-gone {
        color: #d9822b;
        opacity: 1;
    }

    .sync-glyph.sync-error {
        color: #c0392b;
        opacity: 1;
    }

    @keyframes sync-spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
    }

    .sync-toggle input[type='checkbox'] {
        margin-right: 0.4rem;
        accent-color: var(--accent);
    }

    .cloud-stub {
        opacity: 0.75;
        border-style: dashed;
    }

    .stub-title {
        font-size: 0.9rem;
        color: var(--text-muted);
    }

    .stub-download {
        font-size: 0.75rem;
    }

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

    .diverged-box {
        display: flex;
        flex-direction: column;
        gap: 0.4rem;
        margin-top: 0.25rem;
    }

    .kernel-badge {
        display: inline-block;
        font-size: 0.6rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        padding: 0.05rem 0.3rem;
        border-radius: 3px;
        margin-right: 0.35rem;
        line-height: 1.4;
        vertical-align: 0.05em;
    }

    .kernel-badge.kernel-py {
        background: color-mix(in srgb, var(--accent) 15%, transparent);
        color: var(--accent);
    }

    .kernel-badge.kernel-ts {
        background: color-mix(in srgb, #3b82f6 18%, transparent);
        color: #3b82f6;
    }

    .action-btn.confirm {
        color: var(--accent);
        font-weight: 600;
        opacity: 1;
    }

    .session-actions {
        display: flex;
        gap: 0.3rem;
        /* No `position: relative` here — the mobile-actions span
           inside is its own positioned ancestor for the popover,
           and on mobile the overflow button anchors absolutely to
           the parent `.session-item` (top-right of the row). A
           positioned `.session-actions` would intercept that
           anchor and drop the button below the meta line. */
    }

    /* Hover-to-reveal applies only to the desktop icon strip. The
       mobile overflow button needs to stay visible at rest (no
       hover on touch), so opacity is scoped to .desktop-actions. */
    .desktop-actions {
        display: flex;
        gap: 0.3rem;
        opacity: 0;
    }

    .session-item:hover .desktop-actions {
        opacity: 1;
    }

    /* The mobile overflow span is hidden on desktop entirely; the
       media query below flips visibility at the breakpoint. */
    .mobile-actions {
        display: none;
        position: relative;
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

    .action-btn.delete {
        font-size: 1rem;
    }

    .action-btn.delete:hover {
        color: var(--error);
    }

    .action-btn.delete.confirm {
        color: var(--error);
        font-size: 0.65rem;
        font-weight: 600;
        opacity: 1;
    }

    .action-btn.icon-btn {
        font-size: 0.9rem;
        line-height: 1;
        /* `inline-flex` so SVG icons vertical-center with the
           sibling unicode-glyph icon (the gear), which otherwise
           sits on the text baseline. SVG and glyph render on the
           same row regardless. */
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    /* Mobile overflow trigger — 44×44 minimum touch target.
       Sits where the three desktop icons would be; opens the
       actions menu below it. */
    .overflow-btn {
        min-width: 44px;
        min-height: 44px;
        padding: 0.5rem;
    }

    /* Popover containing Fork / Settings / Delete on mobile.
       Anchored to the overflow button via the `.mobile-actions`
       wrapper's position:relative. Right-aligned so it doesn't
       extend off-screen at the right edge of the drawer. */
    .actions-menu {
        position: absolute;
        right: 0;
        top: calc(100% + 0.3rem);
        z-index: 201;
        background: var(--surface);
        border: 1px solid var(--border);
        border-radius: 8px;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
        min-width: 180px;
        padding: 0.25rem;
        display: flex;
        flex-direction: column;
        gap: 0.1rem;
    }

    /* Backdrop pattern matches ChatInput's attach menu — covers
       the viewport to catch click-out without stealing pointer
       events from the menu itself. */
    .menu-backdrop {
        position: fixed;
        inset: 0;
        z-index: 200;
    }

    .actions-menu-item {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        width: 100%;
        min-height: 44px;
        padding: 0.5rem 0.75rem;
        background: none;
        color: var(--text);
        border: none;
        border-radius: 6px;
        font-size: 0.9rem;
        text-align: left;
        cursor: pointer;
    }

    .actions-menu-item:hover {
        background: var(--surface-hover);
    }

    .actions-menu-item.destructive {
        color: var(--error);
    }

    .actions-menu-item.destructive:hover {
        background: color-mix(in srgb, var(--error) 12%, transparent);
    }

    .actions-menu-item.destructive.confirm {
        background: color-mix(in srgb, var(--error) 18%, transparent);
        font-weight: 600;
    }

    .menu-gear {
        font-size: 1.05rem;
        line-height: 1;
        width: 16px;
        display: inline-flex;
        justify-content: center;
    }

    /* Breakpoint flip: at ≤768px, hide the desktop icon strip
       and show the mobile overflow trigger. Matches SplitPane's
       breakpoint so the whole UI shifts to "touch mode" together. */
    @media (max-width: 768px) {
        .desktop-actions {
            display: none;
        }
        /* Anchor the overflow trigger to the session-item's top-
           right corner rather than the inline meta row. The 44px
           touch target on the button would otherwise stretch the
           meta line, making the active row visibly taller than
           inactive ones. Absolute positioning keeps the row at its
           natural height while preserving a comfortable tap area.
           Right inset chosen to clear the row's padding. */
        .mobile-actions {
            display: inline-flex;
            position: absolute;
            top: 0.25rem;
            right: 0.4rem;
        }
        /* Inactive rows stay chrome-free at the touch breakpoint —
           the overflow trigger only appears on the current session.
           Tapping an inactive row switches to it; from there the
           overflow surfaces. */
        .mobile-actions.hidden {
            display: none;
        }
        /* Reserve room on the meta line so the absolutely-
           positioned button doesn't overlap the kernel badge / date
           when both render at full width. */
        .session-item.active .session-meta {
            padding-right: 3rem;
        }
    }

    .section-label {
        font-size: 0.68rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.06em;
        font-weight: 600;
        margin-bottom: 0.15rem;
    }

    .section-divider {
        height: 1px;
        background: var(--border);
        margin: 0.3rem -1.1rem 0.8rem -1.1rem;
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

    /* Gallery entry — sits below the session list, above the debug
       section. Reads as "another place to go" in the same drawer
       context; subdued (no accent color) so it doesn't compete with
       active-session styling above it. */
    .gallery-link {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.55rem 0.75rem;
        margin-top: 0.75rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: transparent;
        color: var(--text-muted);
        text-decoration: none;
        font-size: 0.85rem;
        transition: color 0.15s, border-color 0.15s, background 0.15s;
    }

    .gallery-link:hover {
        color: var(--text);
        background: var(--surface-hover);
        border-color: color-mix(in srgb, var(--accent) 30%, var(--border));
    }

    .gallery-link-chevron {
        margin-left: auto;
        opacity: 0.6;
    }

    .gallery-link:hover .gallery-link-chevron {
        opacity: 1;
    }

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

    /* -- Edit session modal -- */

    .modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.5);
        z-index: 200;
    }

    .modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: min(440px, calc(100% - 2rem));
        max-height: calc(100% - 2rem);
        overflow: auto;
        background: var(--bg);
        border: 1px solid var(--border);
        border-radius: 8px;
        z-index: 201;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
    }

    .modal-header {
        padding: 0.9rem 1.1rem;
        border-bottom: 1px solid var(--border);
    }

    .modal-header h3 {
        margin: 0;
        font-size: 0.95rem;
        font-weight: 600;
    }

    .modal-body {
        padding: 1.1rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .field {
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
    }

    .field-label {
        font-size: 0.75rem;
        color: var(--text-muted);
        text-transform: uppercase;
        letter-spacing: 0.05em;
    }

    .field input,
    .field textarea {
        padding: 0.5rem 0.6rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.85rem;
        font-family: inherit;
        resize: vertical;
    }

    .field-hint {
        font-size: 0.7rem;
        color: var(--text-muted);
        line-height: 1.35;
    }

    .modal-actions {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.9rem 1.1rem;
        border-top: 1px solid var(--border);
    }

    .btn-cancel,
    .btn-save {
        padding: 0.45rem 0.85rem;
        border: 1px solid var(--border);
        border-radius: 6px;
        background: var(--surface);
        color: var(--text);
        font-size: 0.82rem;
        cursor: pointer;
    }

    .btn-save {
        background: var(--accent, var(--text));
        color: var(--bg);
        border-color: var(--accent, var(--text));
    }

    .btn-save:disabled {
        opacity: 0.5;
        cursor: default;
    }

    .btn-cancel:hover:not(:disabled),
    .btn-save:hover:not(:disabled) {
        filter: brightness(1.1);
    }
    /* Small in-row spinner used during a session delete — the
       kvgit orphan sweep can take a non-trivial moment, and the
       row should look "working" rather than frozen. */
    .row-spinner {
        display: inline-block;
        width: 12px;
        height: 12px;
        border: 2px solid var(--border);
        border-top-color: var(--text-muted);
        border-radius: 50%;
        animation: row-spin 0.8s linear infinite;
        flex-shrink: 0;
        /* Tiny vertical nudge so the spinner aligns with the
           letterforms of any adjacent text in the mobile menu. */
        vertical-align: -1px;
    }
    @keyframes row-spin {
        to { transform: rotate(360deg); }
    }
</style>
