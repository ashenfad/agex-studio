<script>
    import Modal from './Modal.svelte'
    import { formatBytes } from './bytes.js'

    /** Bundle-inspection preview shown before committing an import.
     *  Caller owns the bytes/manifest read and the actual import. */
    /** @type {{
     *   preview: { bytes: Uint8Array, manifest: any },
     *   importing: boolean,
     *   error: string,
     *   onCancel: () => void,
     *   onConfirm: () => void,
     * }} */
    let { preview, importing, error, onCancel, onConfirm } = $props()

    let kernel = $derived(preview.manifest.kernel || 'py')
</script>

<Modal title="Import Bundle" onClose={onCancel}>
    <div class="modal-body">
        <div class="preview-field">
            <span class="field-label">Name</span>
            <div class="preview-value">{preview.manifest.name || '(untitled)'}</div>
        </div>
        {#if preview.manifest.description}
            <div class="preview-field">
                <span class="field-label">Description</span>
                <div class="preview-value preview-description">{preview.manifest.description}</div>
            </div>
        {/if}
        {#if preview.manifest.author}
            <div class="preview-field">
                <span class="field-label">Author</span>
                <div class="preview-value">{preview.manifest.author}</div>
            </div>
        {/if}
        <div class="preview-field">
            <span class="field-label">Kernel</span>
            <div class="preview-value">
                <span class="kernel-badge kernel-{kernel}">
                    {kernel}{kernel === 'py' ? ' · exp' : ''}
                </span>
                {kernel === 'ts' ? 'TypeScript (agex-ts)' : 'Python (agex-py) — experimental'}
            </div>
        </div>
        <div class="preview-field">
            <span class="field-label">Contents</span>
            <div class="preview-value preview-stats">
                {preview.manifest.stats?.commits ?? 0} commits ·
                {preview.manifest.stats?.blobs ?? 0} blobs ·
                {formatBytes(preview.bytes.length)}
            </div>
        </div>
        {#if kernel === 'py'}
            <div class="import-py-warning">
                Python uses a softer sandbox than the TypeScript kernel.
                Only import Python sessions from sources you trust.
            </div>
        {/if}
        {#if error}
            <div class="import-error">{error}</div>
        {/if}
    </div>

    {#snippet footer()}
        <div class="modal-actions">
            <button type="button" class="btn-cancel" onclick={onCancel} disabled={importing}>Cancel</button>
            <button type="button" class="btn-save" onclick={onConfirm} disabled={importing}>
                {importing ? 'Importing...' : 'Import as new session'}
            </button>
        </div>
    {/snippet}
</Modal>
