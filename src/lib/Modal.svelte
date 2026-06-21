<script>
    /**
     * Shared modal shell: backdrop + centered dialog + header, with a
     * body (`children`) and an optional footer. Two footer paths:
     *
     *   - `actions` — declarative `[{ label, onClick, variant, disabled,
     *     type }]`; Modal renders the buttons. Covers the common
     *     Cancel + primary / single-Close cases.
     *   - `footer`  — a snippet, when a modal needs custom footer markup
     *     (the publish "done" copy rows, a <form> submit button, etc.).
     *
     * Dismissal (overlay click / Escape) calls `onClose`. Callers whose
     * close is conditional (mid-export, mid-upload) guard inside their
     * own `onClose`; pass `dismissable={false}` to also drop the visual
     * affordance while a flow is in flight.
     *
     * Button + body content classes (`.btn-save`, `.preview-field`, …)
     * are global (see app.css "Modal content") because snippet content
     * carries the *caller's* style scope, not this component's.
     */
    /** @type {{
     *   title: string,
     *   onClose: () => void,
     *   dismissable?: boolean,
     *   actions?: Array<{ label: string, onClick?: () => void, variant?: 'cancel' | 'primary' | 'danger', disabled?: boolean, type?: 'button' | 'submit' }>,
     *   children: import('svelte').Snippet,
     *   footer?: import('svelte').Snippet,
     * }} */
    let { title, onClose, dismissable = true, actions, children, footer } = $props()

    function handleOverlayClick() {
        if (dismissable) onClose()
    }

    function handleKeydown(e) {
        if (dismissable && e.key === 'Escape') onClose()
    }

    function variantClass(variant) {
        if (variant === 'danger') return 'btn-save btn-danger'
        if (variant === 'cancel') return 'btn-cancel'
        return 'btn-save'
    }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div class="modal-overlay" onclick={handleOverlayClick}></div>
<!-- Escape lives on the dialog (not the sibling overlay): a keydown
     while focus is on a control inside bubbles through the modal's
     ancestors, never the overlay. -->
<div class="modal" role="dialog" aria-modal="true" tabindex="-1" onkeydown={handleKeydown}>
    <div class="modal-header">
        <h3>{title}</h3>
    </div>
    {@render children()}
    {#if footer}
        {@render footer()}
    {:else if actions && actions.length}
        <div class="modal-actions">
            {#each actions as a}
                <button
                    type={a.type || 'button'}
                    class={variantClass(a.variant)}
                    disabled={a.disabled}
                    onclick={a.onClick}
                >{a.label}</button>
            {/each}
        </div>
    {/if}
</div>

<style>
    /* Chrome only. Backdrop is dimmer than the global `.modal-overlay`
       (0.5 vs 0.6) and skips the flex-centering — the dialog centers
       itself via absolute positioning so its own max-height/scroll
       behave independently of the backdrop. */
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

    /* `.modal-body` and `.modal-actions` are global (app.css) so they
       reach snippet content rendered in the caller's scope. */
</style>
