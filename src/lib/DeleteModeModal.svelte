<script>
    import Modal from './Modal.svelte'

    /** Delete chooser for a synced session: remove from this device
     *  (keep in the sync repo) vs. delete everywhere (archive to
     *  trash on all devices). `mode` is bindable so the caller reads
     *  the chosen value on confirm. */
    /** @type {{
     *   sessionTitle: string,
     *   mode: 'device' | 'everywhere',
     *   onCancel: () => void,
     *   onConfirm: () => void,
     * }} */
    let { sessionTitle, mode = $bindable(), onCancel, onConfirm } = $props()
</script>

<Modal
    title="Delete session"
    onClose={onCancel}
    actions={[
        { label: 'Cancel', variant: 'cancel', onClick: onCancel },
        { label: 'Delete', variant: 'danger', onClick: onConfirm },
    ]}
>
    <div class="modal-body">
        <p class="delete-prompt">Delete <strong>{sessionTitle}</strong>?</p>
        <div class="destination-choice">
            <label class="destination-option">
                <input type="radio" name="delete-mode" value="device" bind:group={mode} />
                <span class="destination-option-body">
                    <span class="destination-option-title">Remove from this device</span>
                    <span class="destination-detail">
                        Keeps it in the sync repo — reappears here as a
                        cloud session you can re-open. Untouched on your
                        other devices.
                    </span>
                </span>
            </label>
            <label class="destination-option">
                <input type="radio" name="delete-mode" value="everywhere" bind:group={mode} />
                <span class="destination-option-body">
                    <span class="destination-option-title">Delete everywhere</span>
                    <span class="destination-detail">
                        Moves to Trash on all your devices. Recoverable
                        until you empty the trash.
                    </span>
                </span>
            </label>
        </div>
    </div>
</Modal>
