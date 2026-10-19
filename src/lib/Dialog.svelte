<script>
    /**
     * A modal dialog's frame, the same for every one: a title (or what
     * stands in its place) and a close button; below them, optionally,
     * what stays put above the scrolling body (tabs); the body; and,
     * optionally, buttons that stay put under it.
     *
     * It's the browser's own modal <dialog>: above everything else on
     * the page, which can't be reached until it closes. The keyboard
     * starts in it, so Tab and Escape work at once, and goes back, once
     * it closes, to what had it before (the button that opened it). It
     * closes on Escape (unless a field inside handled the key: a list
     * it opened closes instead), on its close button, and on a click on
     * the dim page around it; not when a press inside it is let go
     * outside (text selected in a field, dragged too far).
     *
     * Its parent shows it while it's open and drops it once `onClose`
     * is called.
     */
    import { onMount } from 'svelte'

    /**
     * @type {{
     *   label: string,
     *   onClose: () => void,
     *   title?: string,
     *   width?: string,
     *   fill?: boolean,
     *   tall?: boolean,
     *   heading?: import('svelte').Snippet,
     *   head?: import('svelte').Snippet,
     *   children: import('svelte').Snippet,
     *   actions?: import('svelte').Snippet,
     * }}
     *   `label` names it to a screen reader; `title`, shown at its top,
     *   defaults to it, and `heading` takes its place there. `width` is
     *   the most it takes of a wide screen; `tall`, it takes nearly all
     *   of the screen's height (a file to read); `fill`, all of a
     *   phone's screen.
     */
    let { label, onClose, title = label, width = '31rem', fill = false, tall = false, heading, head, children, actions } = $props()

    /** @type {HTMLDialogElement | undefined} */
    let dialog = $state()
    /** What had the keyboard before the dialog opened. */
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    /** Whether the press now ending began on the page around the dialog. */
    let pressedOutside = false

    onMount(() => {
        dialog?.showModal()
        dialog?.focus()
        return () => {
            if (opener?.isConnected) opener.focus()
        }
    })

    /** Escape: the browser would close the dialog itself; the parent
     *  does, by dropping it. @param {Event} e */
    function oncancel(e) {
        e.preventDefault()
        onClose()
    }

    /** A press on the dialog element itself, not on what's inside it, is
     *  on the dim page around it: the frame fills the dialog's box.
     *  @param {PointerEvent} e */
    function onpointerdown(e) {
        pressedOutside = e.target === dialog
    }

    /** @param {MouseEvent} e */
    function onclick(e) {
        if (pressedOutside && e.target === dialog) onClose()
        pressedOutside = false
    }
</script>

<dialog
    bind:this={dialog}
    class:fill
    class:tall
    style:--width={width}
    aria-label={label}
    tabindex="-1"
    {oncancel}
    {onpointerdown}
    {onclick}
>
    <div class="frame">
        <header class:tabbed={head}>
            <div class="title">
                {#if heading}{@render heading()}{:else}<h2>{title}</h2>{/if}
                <button class="close" onclick={onClose} aria-label="Close" title="Close (Esc)">✕</button>
            </div>
            {@render head?.()}
        </header>
        <div class="body">
            {@render children()}
        </div>
        {#if actions}
            <footer>{@render actions()}</footer>
        {/if}
    </div>
</dialog>

<style>
    /* anchored near the top, so a dialog grows and shrinks downward (a
       tab, a section opened) rather than moving */
    dialog {
        margin: min(10vh, 6rem) auto auto;
        width: min(var(--width), calc(100vw - 2rem));
        max-width: none;
        max-height: calc(100dvh - 2 * min(10vh, 6rem));
        padding: 0;
        background: var(--surface);
        color: var(--text);
        border: 1px solid var(--border);
        border-radius: 10px;
        box-shadow: 0 10px 40px rgb(0 0 0 / 50%);
        overflow: hidden;
        outline: none;
    }
    dialog.tall {
        margin: 1.5rem auto;
        max-height: calc(100dvh - 3rem);
    }
    dialog::backdrop {
        background: rgb(0 0 0 / 50%);
    }
    /* header and buttons fixed, the body scrolling between */
    .frame {
        display: flex;
        flex-direction: column;
        max-height: inherit;
    }
    header {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        padding: 1rem 1.2rem 0.8rem;
        border-bottom: 1px solid var(--border);
    }
    /* tabs sit on the rule under the header */
    header.tabbed {
        padding-bottom: 0;
    }
    .title {
        display: flex;
        align-items: center;
        gap: 0.4rem;
        min-width: 0;
    }
    h2 {
        flex: 1;
        min-width: 0;
        font-size: 1.2rem;
        overflow-wrap: anywhere;
    }
    .close {
        margin-left: auto;
        flex-shrink: 0;
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 1rem;
        padding: 0.2rem 0.4rem;
        border-radius: 6px;
    }
    .close:hover {
        color: var(--text);
        background: var(--surface-hover);
    }
    .body {
        flex: 1;
        min-height: 0;
        overflow-y: auto;
        padding: 1rem 1.2rem 1.2rem;
        display: flex;
        flex-direction: column;
        gap: 0.7rem;
    }
    footer {
        display: flex;
        justify-content: flex-end;
        gap: 0.5rem;
        padding: 0.8rem 1.2rem;
        border-top: 1px solid var(--border);
    }
    @media (max-width: 768px) {
        dialog.fill {
            margin: 0;
            width: 100vw;
            height: 100dvh;
            max-height: none;
            border: none;
            border-radius: 0;
        }
        dialog.fill .frame {
            height: 100%;
        }
    }
</style>
