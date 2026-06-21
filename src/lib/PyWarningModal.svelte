<script>
    import Modal from './Modal.svelte'

    /** One-time heads-up shown before creating the first Python session
     *  on a browser that hasn't dismissed it. Purely presentational —
     *  the caller owns the "seen" flag and the actual create. */
    /** @type {{ onCancel: () => void, onConfirm: () => void }} */
    let { onCancel, onConfirm } = $props()
</script>

<Modal
    title="Heads up — Python kernel"
    onClose={onCancel}
    actions={[
        { label: 'Cancel', variant: 'cancel', onClick: onCancel },
        { label: 'Got it, create session', variant: 'primary', onClick: onConfirm },
    ]}
>
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
</Modal>
