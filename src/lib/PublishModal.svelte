<script>
    import Modal from './Modal.svelte'
    import ProgressBar from './ProgressBar.svelte'
    import { formatBytes } from './bytes.js'
    import { relativeTime } from './format-time.js'
    import { phaseLabel, publishSizeHint } from './bundle-format.js'

    /** Thin view over a publish flow (see publish-flow.svelte.js). The
     *  flow owns the stage state machine + the gist PATCH/POST logic;
     *  this renders each stage and the view-only affordances (the "?"
     *  explainer, copy-to-clipboard flash, gallery submission). */
    /** @type {{ flow: ReturnType<typeof import('./publish-flow.svelte.js').createPublishFlow> }} */
    let { flow } = $props()

    let st = $derived(flow.state)

    // View-only state: nothing here feeds back into the flow's machine.
    let helpOpen = $state(false)
    /** @type {null | 'play' | 'showcase'} */
    let copyFlash = $state(null)

    let dismissable = $derived(st && st.stage !== 'bundling' && st.stage !== 'uploading')

    function close() {
        flow.close()
        helpOpen = false
        copyFlash = null
    }

    async function copyUrl(url, which) {
        if (st?.stage !== 'done') return
        try {
            await navigator.clipboard.writeText(url)
            copyFlash = which
            setTimeout(() => {
                // Only clear if we still own the flash; a follow-up copy
                // on the other field would have overwritten it already.
                if (copyFlash === which) copyFlash = null
            }, 2000)
        } catch (err) {
            console.error('Copy failed:', err)
        }
    }

    /** Open a prefilled GitHub issue against agex-studio with the
     *  just-published gist's URLs and metadata, for gallery submission.
     *  `body=` prefill (not `template=`) because GitHub's behavior with
     *  both present is inconsistent; the markdown template covers the
     *  "New issue" path on github.com directly. `labels=` lands it in
     *  the triage queue. */
    function submitToGallery() {
        if (st?.stage !== 'done') return
        const session = st.session
        // Gallery submissions use the *pinned* URL (embeds the gist's
        // commit SHA at publish time) so a curated entry can't silently
        // change content after admission. Friend-share URLs stay
        // HEAD-tracking. Falls back to the unpinned URL defensively.
        const showcaseUrl = st.result.runtimeUrlPinned || st.result.runtimeUrl
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
</script>

{#if st}
    <Modal title="Publish to Gist" onClose={close} {dismissable}>
        {#if st.stage === 'options'}
            <div class="modal-body">
                <div class="preview-field">
                    <span class="field-label">
                        What to include
                        <button
                            type="button"
                            class="help-toggle"
                            class:open={helpOpen}
                            aria-label="Explain the options"
                            onclick={() => helpOpen = !helpOpen}
                        >?</button>
                    </span>
                    {#if helpOpen}
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
                            <input type="radio" name="publish-shape" value="full" bind:group={st.shape} />
                            <span class="destination-option-title">Everything{publishSizeHint(st.estimates, 'full')}</span>
                        </label>
                        <label class="destination-option">
                            <input type="radio" name="publish-shape" value="flat" bind:group={st.shape} />
                            <span class="destination-option-title">Current state{publishSizeHint(st.estimates, 'flat')}</span>
                        </label>
                        <label class="destination-option">
                            <input type="radio" name="publish-shape" value="flat-downsample" bind:group={st.shape} />
                            <span class="destination-option-title">Current state, smaller images{publishSizeHint(st.estimates, 'flat-downsample')}</span>
                        </label>
                        <label class="destination-option">
                            <input type="radio" name="publish-shape" value="flat-strip" bind:group={st.shape} />
                            <span class="destination-option-title">Current state, no images{publishSizeHint(st.estimates, 'flat-strip')}</span>
                        </label>
                    </div>
                    {#if !st.estimates}
                        <div class="destination-detail">estimating sizes…</div>
                    {/if}
                </div>
            </div>
        {:else if st.stage === 'bundling'}
            <div class="modal-body">
                <ProgressBar label={phaseLabel(st.phase)} done={st.done} total={st.total} pending="bundling..." />
            </div>
        {:else if st.stage === 'preview'}
            <div class="modal-body">
                <div class="preview-field">
                    <span class="field-label">Name</span>
                    <div class="preview-value">
                        {st.session.name || st.session.title || '(untitled)'}
                    </div>
                </div>
                <div class="preview-field">
                    <span class="field-label">Bundle</span>
                    <div class="preview-value preview-stats">
                        {st.manifest.stats?.commits ?? 0} commits ·
                        {formatBytes(Math.ceil(st.bytes.length * 4 / 3))}
                    </div>
                </div>
                <div class="preview-field">
                    <span class="field-label">Destination</span>
                    {#if st.priorGist}
                        <!-- A prior gist mapping exists (this branch
                             published before, or inherited it from a fork).
                             Let the user update it (same URL) or split off a
                             new gist. -->
                        <div class="destination-choice">
                            <label class="destination-option">
                                <input type="radio" name="publish-target" value="existing" bind:group={st.target} />
                                <span class="destination-option-body">
                                    <span class="destination-option-title">Update existing gist</span>
                                    <span class="destination-detail">
                                        <a
                                            href={`https://gist.github.com/${st.priorGist.gistId}`}
                                            target="_blank"
                                            rel="noopener"
                                            class="destination-link"
                                            onclick={(e) => e.stopPropagation()}
                                        >gist.github.com/…/{st.priorGist.gistId.slice(0, 8)}</a>
                                        {#if st.priorGist.lastPublishedAt}
                                            · last published {relativeTime(st.priorGist.lastPublishedAt)}
                                        {/if}
                                        — keeps the same share URL
                                    </span>
                                </span>
                            </label>
                            <label class="destination-option">
                                <input type="radio" name="publish-target" value="new" bind:group={st.target} />
                                <span class="destination-option-body">
                                    <span class="destination-option-title">Create a new gist</span>
                                    <span class="destination-detail">
                                        publishes as a separate app with its own URL{#if st.priorGist.inherited} — this is a forked copy{/if}
                                    </span>
                                </span>
                            </label>
                        </div>
                    {:else}
                        <div class="preview-value">
                            New gist
                            <div class="destination-detail">
                                {#if st.session.external}
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
                    <input type="checkbox" bind:checked={st.ack} />
                    <span>I understand the bundle will be publicly accessible by URL.</span>
                </label>
            </div>
        {:else if st.stage === 'uploading'}
            <div class="modal-body">
                <ProgressBar label="Uploading to GitHub..." />
            </div>
        {:else if st.stage === 'done'}
            <div class="modal-body">
                <div class="stage-done">
                    <div class="done-check">✓</div>
                    <div class="done-message">Published as a secret gist</div>
                </div>
                {#if st.fallbackFromGistId}
                    <!-- 404-fallback notice: preview promised "Update
                         existing gist", but the prior gist was no longer
                         reachable on github.com, so we created a fresh one
                         instead. Explains why the URL below differs from
                         what the preview showed. -->
                    <div class="publish-notice">
                        Your previous gist at
                        <a
                            href={`https://gist.github.com/${st.fallbackFromGistId}`}
                            target="_blank"
                            rel="noopener"
                        >gist.github.com/…/{st.fallbackFromGistId.slice(0, 8)}</a>
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
                            value={`${st.result.runtimeUrl}&play=1`}
                            onfocus={(e) => /** @type {HTMLInputElement} */ (e.currentTarget).select()}
                        />
                        <button type="button" class="btn-copy" onclick={() => copyUrl(`${st.result.runtimeUrl}&play=1`, 'play')}>
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
                            value={st.result.runtimeUrl}
                            onfocus={(e) => /** @type {HTMLInputElement} */ (e.currentTarget).select()}
                        />
                        <button type="button" class="btn-copy" onclick={() => copyUrl(st.result.runtimeUrl, 'showcase')}>
                            {copyFlash === 'showcase' ? 'Copied!' : 'Copy'}
                        </button>
                    </div>
                </div>
                <div class="publish-secondary">
                    <button type="button" class="btn-gallery" onclick={submitToGallery} title="Submit to the agex.studio gallery">
                        ✨ Submit to gallery
                    </button>
                    <a href={st.result.gistHtmlUrl} target="_blank" rel="noopener">View on GitHub ↗</a>
                </div>
            </div>
        {:else if st.stage === 'error'}
            <div class="modal-body">
                <div class="import-error">{st.message}</div>
            </div>
        {/if}

        {#snippet footer()}
            {#if st.stage === 'options'}
                <div class="modal-actions">
                    <button type="button" class="btn-cancel" onclick={close}>Cancel</button>
                    <button type="button" class="btn-save" onclick={flow.proceed}>Continue</button>
                </div>
            {:else if st.stage === 'preview'}
                <div class="modal-actions">
                    <button type="button" class="btn-cancel" onclick={close}>Cancel</button>
                    <button type="button" class="btn-save" onclick={flow.confirm} disabled={!st.ack}>Publish</button>
                </div>
            {:else if st.stage === 'done'}
                <div class="modal-actions">
                    <button type="button" class="btn-save" onclick={close}>Close</button>
                </div>
            {:else if st.stage === 'error'}
                <div class="modal-actions">
                    <button type="button" class="btn-cancel" onclick={close}>Close</button>
                </div>
            {/if}
        {/snippet}
    </Modal>
{/if}

<style>
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

    /* 404-fallback info notice on the done view. Soft warning tone (not
       an error; publish succeeded), prior gist linkable so the user can
       confirm it's gone. */
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

    /* "Submit to gallery" — secondary CTA next to View-on-GitHub. Subtle
       so it doesn't compete with Copy/Close, but tinted to read as real. */
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
</style>
