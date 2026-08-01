<script>
    import { formatBytes } from './bytes.js'
    import { formatDate, relativeTime } from './format-time.js'

    /**
     * One session in the drawer's list: title + status dots, the
     * imported-update and sync-attention rows, the meta line (kernel
     * badge / sync glyph / date), and the desktop icon strip + mobile
     * overflow menu.
     *
     * Deliberately dumb: the parent owns all session/sync/menu state and
     * passes this row's slice as plain booleans (`deleting`, `menuOpen`,
     * …). Actions are reported up via callbacks bound to this branch by
     * the parent, so the row never names a branch itself.
     */
    /** @type {{
     *   session: any,
     *   active: boolean,
     *   runtime: any,
     *   syncStatus: any,
     *   syncConnected: boolean,
     *   nowTick: number,
     *   canDelete: boolean,
     *   updating: boolean,
     *   resolving: boolean,
     *   deleting: boolean,
     *   deleteBusy: boolean,
     *   deleteArmed: boolean,
     *   resetArmed: boolean,
     *   menuOpen: boolean,
     *   onSwitch: () => void,
     *   onFork: (e: Event) => void,
     *   onEdit: (e: Event) => void,
     *   onDelete: (e: Event) => void,
     *   onUpdate: () => void,
     *   onDismissUpdate: () => void,
     *   onForkDiverged: () => void,
     *   onResetToRemote: () => void,
     *   onRetrySync: () => void,
     *   onRepush: () => void,
     *   onKeepLocal: () => void,
     *   onToggleMenu: (e: Event) => void,
     *   onCloseMenu: () => void,
     * }} */
    let {
        session: s,
        active,
        runtime: rt,
        syncStatus,
        syncConnected,
        nowTick,
        canDelete,
        updating,
        resolving,
        deleting,
        deleteBusy,
        deleteArmed,
        resetArmed,
        menuOpen,
        onSwitch,
        onFork,
        onEdit,
        onDelete,
        onUpdate,
        onDismissUpdate,
        onForkDiverged,
        onResetToRemote,
        onRetrySync,
        onRepush,
        onKeepLocal,
        onToggleMenu,
        onCloseMenu,
    } = $props()

    // No glyph for the steady state: a synced session is the norm, so a
    // standing ✓ is noise. The glyph only appears while something is
    // happening (queued / syncing) or wrong (attention states); synced
    // freshness lives in the timestamp's hover instead.
    function syncGlyph(state) {
        if (state === 'syncing') return '↻'
        if (state === 'pending') return '↑'
        return '⚠'
    }

    function syncGlyphTitle(status) {
        const { state, detail } = status
        if (state === 'syncing') return detail ? `Syncing — ${detail}` : 'Syncing…'
        if (state === 'pending') return detail ? `Sync queued — ${detail}` : 'Sync queued'
        return detail || `Session sync: ${state}`
    }

    /** Hover ledger on the row's timestamp: when the session last
     *  changed, and (when synced) when that was last verified. The
     *  times themselves carry staleness — no glyph semantics needed. */
    function dateTitle(session, status) {
        const updated = `Updated ${relativeTime(session.updated)}`
        if (status?.state !== 'synced') return updated
        const app = status.appAt ? ` · app data ${relativeTime(status.appAt)}` : ''
        return `${updated} · synced ${relativeTime(status.at)}${app}`
    }

    // nowTick is read so the relative-time titles recompute each minute
    // while the drawer is open; the values themselves come from the
    // helpers above.
    // `nowTick` is read purely to register a reactive dependency, so
    // these relative timestamps re-render as it advances. `$derived.by`
    // with an explicit `void` states that intent; the comma-operator
    // form it replaces read as a typo (and tripped svelte-check).
    let syncTitle = $derived.by(() => {
        void nowTick
        return syncStatus ? syncGlyphTitle(syncStatus) : ''
    })
    let metaDateTitle = $derived.by(() => {
        void nowTick
        return dateTitle(s, syncStatus)
    })
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
    class="session-item"
    class:active
    onclick={onSwitch}
    onkeydown={(e) => e.key === 'Enter' && onSwitch()}
    role="button"
    tabindex="0"
>
    <div class="session-title">
        {#if rt?.busy}
            <span class="status-dot working" title="Working…"></span>
        {:else if rt?.unseen}
            <span class="status-dot unseen" title="New result — not yet viewed"></span>
        {/if}
        {#if s.starred}
            <!-- Read-only "kept app" marker. The toggle lives on the
                 active app's header (app-presence isn't knowable cold
                 for a background row); here it just signals membership
                 in the pinned Apps group. -->
            <svg class="star-glyph" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
            </svg>
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
                disabled={updating}
                onclick={onUpdate}
            >{updating ? 'Updating…' : 'Update'}</button>
            <button
                class="update-dismiss"
                title="Ignore this version"
                onclick={onDismissUpdate}
            >&times;</button>
        </div>
    {/if}
    {#if syncConnected && s.kernel === 'ts' && syncStatus}
        {#if ['diverged', 'error', 'remote-gone'].includes(syncStatus.state)}
        <div class="update-row" onclick={(e) => e.stopPropagation()} onkeydown={(e) => e.stopPropagation()}>
            {#if syncStatus.state === 'diverged'}
                <span class="update-label">Diverged — changed on another device</span>
                <button class="update-btn" disabled={resolving} onclick={onForkDiverged}>Keep both</button>
                <button class="update-btn" disabled={resolving} onclick={onResetToRemote}>
                    {resetArmed ? 'Discard local turns?' : 'Take synced'}
                </button>
            {:else if syncStatus.state === 'error'}
                <span class="update-label" title={syncStatus.detail}>Sync error</span>
                <button class="update-btn" disabled={resolving} onclick={onRetrySync}>Retry</button>
            {:else}
                <span class="update-label">Removed from sync repo elsewhere</span>
                <button class="update-btn" disabled={resolving} onclick={onRepush}>Sync again</button>
                <button class="update-btn" disabled={resolving} onclick={onKeepLocal}>Keep local</button>
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
            {#if syncConnected && s.kernel === 'ts' && syncStatus && syncStatus.state !== 'synced'}
                <span class="sync-glyph sync-{syncStatus.state}" title={syncTitle}>{syncGlyph(syncStatus.state)}</span>
            {/if}
            {#if syncStatus?.state === 'syncing' && syncStatus.detail}
                <span class="sync-progress">{syncStatus.detail}</span>
            {:else}
                <span title={metaDateTitle}>{formatDate(s.updated)}</span>
            {/if}
            {#if s.app_storage_bytes > 0}
                <span class="app-storage-badge" title="App save data: {formatBytes(s.app_storage_bytes)}">· app</span>
            {/if}
        </span>
        <span class="session-actions">
            <!-- Desktop layout: three icon buttons inline. Hidden at
                 ≤768px via media query; mobile sees the overflow menu
                 below instead. -->
            <span class="desktop-actions">
            <button
                class="action-btn icon-btn"
                onclick={onFork}
                title="Fork session"
                aria-label="Fork session"
            >
                <!-- Feather "git-branch" — vertical trunk on the left,
                     branch arcing off to a node on the right. Reads
                     unambiguously as "fork" at this 14px size next to
                     the gear. -->
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="6" y1="3" x2="6" y2="15"></line>
                    <circle cx="18" cy="6" r="3"></circle>
                    <circle cx="6" cy="18" r="3"></circle>
                    <path d="M18 9a9 9 0 0 1-9 9"></path>
                </svg>
            </button>
            <button
                class="action-btn icon-btn"
                onclick={onEdit}
                title="Session settings"
                aria-label="Session settings"
            >
                &#9881;
            </button>
            {#if canDelete}
                <button
                    class="action-btn delete"
                    class:confirm={deleteArmed}
                    onclick={onDelete}
                    disabled={deleteBusy}
                    title="Delete session"
                >
                    {#if deleting}
                        <span class="row-spinner" aria-label="Deleting"></span>
                    {:else if deleteArmed}
                        delete?
                    {:else}
                        {'×'}
                    {/if}
                </button>
            {/if}
            </span>

            <!-- Mobile layout: single overflow trigger; popover surfaces
                 the three actions as touch-friendly menu items. Visible
                 only at ≤768px via CSS, AND only on the active row —
                 inactive rows stay chrome-free (tap to switch, then
                 act). Mirrors the desktop hover-to-reveal pattern at the
                 touch breakpoint: actions surface only when the row is
                 "current context." -->
            <span class="mobile-actions" class:hidden={!active}>
                <button
                    class="action-btn icon-btn overflow-btn"
                    onclick={onToggleMenu}
                    title="Session actions"
                    aria-label="Session actions"
                    aria-expanded={menuOpen}
                >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                        <circle cx="5" cy="12" r="2"></circle>
                        <circle cx="12" cy="12" r="2"></circle>
                        <circle cx="19" cy="12" r="2"></circle>
                    </svg>
                </button>
                {#if menuOpen}
                    <!-- svelte-ignore a11y_no_static_element_interactions -->
                    <div
                        class="menu-backdrop"
                        onclick={(e) => { e.stopPropagation(); onCloseMenu() }}
                        onkeydown={(e) => e.key === 'Escape' && onCloseMenu()}
                    ></div>
                    <div class="actions-menu" role="menu">
                        <button
                            class="actions-menu-item"
                            role="menuitem"
                            onclick={(e) => { onFork(e); onCloseMenu() }}
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
                            onclick={(e) => { onEdit(e); onCloseMenu() }}
                        >
                            <span class="menu-gear" aria-hidden="true">&#9881;</span>
                            <span>Settings</span>
                        </button>
                        {#if canDelete}
                            <button
                                class="actions-menu-item destructive"
                                class:confirm={deleteArmed}
                                role="menuitem"
                                disabled={deleteBusy}
                                onclick={(e) => {
                                    const wasArmed = deleteArmed
                                    onDelete(e)
                                    // First tap arms the confirm — keep the menu open
                                    // so the second tap lands on the same visible
                                    // button. If already armed, the row is gone —
                                    // nothing to close.
                                    if (wasArmed) onCloseMenu()
                                }}
                            >
                                {#if deleting}
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
                                    {#if deleting}
                                        Deleting…
                                    {:else if deleteArmed}
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

<style>
    .session-item {
        padding: 0.6rem 0.75rem;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        flex-direction: column;
        gap: 0.2rem;
        /* `relative` so the mobile overflow button can absolute-anchor
           to the row's top-right corner without stretching the meta
           line (the button's 44px touch target was pushing inactive vs
           active rows to different heights). */
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

    /* Kept-app star, inline before the title. Accent-tinted to match
       the header toggle's kept state; nudged to baseline so it sits
       with the text rather than riding high. */
    .star-glyph {
        color: var(--accent);
        vertical-align: -1px;
        margin-right: 1px;
        flex-shrink: 0;
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
       Color scale: muted for in-flight, amber for needs-a-look, red for
       broken — words live in the tooltip and the action rows. */
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

    .session-actions {
        display: flex;
        gap: 0.3rem;
        /* No `position: relative` here — the mobile-actions span inside
           is its own positioned ancestor for the popover, and on mobile
           the overflow button anchors absolutely to the parent
           `.session-item` (top-right of the row). A positioned
           `.session-actions` would intercept that anchor and drop the
           button below the meta line. */
    }

    /* Hover-to-reveal applies only to the desktop icon strip. The mobile
       overflow button needs to stay visible at rest (no hover on
       touch), so opacity is scoped to .desktop-actions. */
    .desktop-actions {
        display: flex;
        gap: 0.3rem;
        opacity: 0;
    }

    .session-item:hover .desktop-actions {
        opacity: 1;
    }

    /* The mobile overflow span is hidden on desktop entirely; the media
       query below flips visibility at the breakpoint. */
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

    .action-btn.confirm {
        color: var(--accent);
        font-weight: 600;
        opacity: 1;
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
        /* `inline-flex` so SVG icons vertical-center with the sibling
           unicode-glyph icon (the gear), which otherwise sits on the
           text baseline. SVG and glyph render on the same row
           regardless. */
        display: inline-flex;
        align-items: center;
        justify-content: center;
    }

    /* Mobile overflow trigger — 44×44 minimum touch target. Sits where
       the three desktop icons would be; opens the actions menu below
       it. */
    .overflow-btn {
        min-width: 44px;
        min-height: 44px;
        padding: 0.5rem;
    }

    /* Popover containing Fork / Settings / Delete on mobile. Anchored to
       the overflow button via the `.mobile-actions` wrapper's
       position:relative. Right-aligned so it doesn't extend off-screen
       at the right edge of the drawer. */
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

    /* Backdrop pattern matches ChatInput's attach menu — covers the
       viewport to catch click-out without stealing pointer events from
       the menu itself. */
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

    /* Small in-row spinner used during a session delete — the kvgit
       orphan sweep can take a non-trivial moment, and the row should
       look "working" rather than frozen. */
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

    /* Breakpoint flip: at ≤768px, hide the desktop icon strip and show
       the mobile overflow trigger. Matches SplitPane's breakpoint so the
       whole UI shifts to "touch mode" together. */
    @media (max-width: 768px) {
        .desktop-actions {
            display: none;
        }
        /* Anchor the overflow trigger to the session-item's top-right
           corner rather than the inline meta row. The 44px touch target
           on the button would otherwise stretch the meta line, making
           the active row visibly taller than inactive ones. Absolute
           positioning keeps the row at its natural height while
           preserving a comfortable tap area. Right inset chosen to clear
           the row's padding. */
        .mobile-actions {
            display: inline-flex;
            position: absolute;
            top: 0.25rem;
            right: 0.4rem;
        }
        /* Inactive rows stay chrome-free at the touch breakpoint — the
           overflow trigger only appears on the current session. Tapping
           an inactive row switches to it; from there the overflow
           surfaces. */
        .mobile-actions.hidden {
            display: none;
        }
        /* Reserve room on the meta line so the absolutely-positioned
           button doesn't overlap the kernel badge / date when both
           render at full width. */
        .session-item.active .session-meta {
            padding-right: 3rem;
        }
    }
</style>
