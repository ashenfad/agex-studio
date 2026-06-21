<script>
    import Modal from './Modal.svelte'
    import ProgressBar from './ProgressBar.svelte'
    import { formatBytes } from './bytes.js'
    import { phaseLabel } from './bundle-format.js'

    /** Thin view over an export flow (see export-flow.svelte.js). The
     *  flow owns the stage state machine; this just renders each stage. */
    /** @type {{ flow: ReturnType<typeof import('./export-flow.svelte.js').createExportFlow> }} */
    let { flow } = $props()

    let st = $derived(flow.state)
</script>

{#if st}
    <Modal title="Export Session" onClose={flow.close} dismissable={st.stage !== 'progress'}>
        {#if st.stage === 'loading'}
            <div class="modal-body">
                <div class="stage-loading">Reading session...</div>
            </div>
        {:else if st.stage === 'preview'}
            <div class="modal-body">
                <div class="preview-field">
                    <span class="field-label">Name</span>
                    <div class="preview-value">
                        {st.stats.name || st.stats.title || '(untitled)'}
                    </div>
                </div>
                {#if st.stats.description}
                    <div class="preview-field">
                        <span class="field-label">Description</span>
                        <div class="preview-value preview-description">{st.stats.description}</div>
                    </div>
                {/if}
                <div class="preview-field">
                    <span class="field-label">Contents</span>
                    <div class="preview-value preview-stats">{st.stats.commits} commits</div>
                </div>
                <div class="preview-hint">
                    Downloads a self-contained <code>.agex</code> bundle you can share, archive, or re-import as a new session.
                </div>
            </div>
        {:else if st.stage === 'progress'}
            <div class="modal-body">
                <ProgressBar label={phaseLabel(st.phase)} done={st.done} total={st.total} pending="working..." />
            </div>
        {:else if st.stage === 'done'}
            <div class="modal-body">
                <div class="stage-done">
                    <div class="done-check">✓</div>
                    <div class="done-message">Bundle downloaded.</div>
                    <div class="preview-stats">
                        {st.manifest.stats?.commits ?? 0} commits ·
                        {formatBytes(st.bytes.length)}
                    </div>
                </div>
            </div>
        {:else if st.stage === 'error'}
            <div class="modal-body">
                <div class="import-error">{st.message}</div>
            </div>
        {/if}

        {#snippet footer()}
            {#if st.stage === 'preview'}
                <div class="modal-actions">
                    <button type="button" class="btn-cancel" onclick={flow.close}>Cancel</button>
                    <button type="button" class="btn-save" onclick={flow.confirm}>Export</button>
                </div>
            {:else if st.stage === 'done'}
                <div class="modal-actions">
                    <button type="button" class="btn-save" onclick={flow.close}>Close</button>
                </div>
            {:else if st.stage === 'error'}
                <div class="modal-actions">
                    <button type="button" class="btn-cancel" onclick={flow.close}>Close</button>
                </div>
            {/if}
        {/snippet}
    </Modal>
{/if}
