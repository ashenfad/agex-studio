/**
 * Click handler for inline VFS file links.
 *
 * Markdown like ``[label](vfs:path/to/file.png)`` renders as
 * ``<a class="vfs-download" data-vfs-path="...">`` (see markdown.js's
 * link override). This handler turns those clicks into "open the
 * shared `FileModal` on that path" — the modal provides a preview
 * for image / PDF / markdown / CSV / text files and a download
 * button regardless of file type.
 *
 * Previously the handler did a direct VFS read + blob download via
 * `agent.js`'s py-only `downloadFile`. That broke for TS sessions
 * ("Pyodide not ready" on click). Routing through the modal makes
 * the click kernel-agnostic and gives the user preview-before-
 * download for free.
 *
 * The window-level click listener that delegates to this handler
 * lives in `App.svelte`, so it works wherever rendered markdown
 * appears — chat messages (MessageList), thinking / report sections
 * (EventDetail), chapter summaries, file modal markdown bodies, etc.
 */

import { viewingFile } from "./viewing-file.js";

/**
 * @param {MouseEvent} e
 */
export function handleVfsClick(e) {
    // `EventTarget` has no `closest`; only Elements do. Delegated
    // clicks can also originate from a text node's parent, hence the
    // optional call rather than an instanceof narrow.
    const target = /** @type {HTMLElement | null | undefined} */ (
        /** @type {Element | null} */ (e.target)?.closest?.(".vfs-download")
    );
    if (!target) return;
    e.preventDefault();
    const raw = target.dataset.vfsPath;
    if (!raw) return;
    const path = decodeURIComponent(raw);
    viewingFile.set(path);
}
