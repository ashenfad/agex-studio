/**
 * Click handler for inline VFS download links.
 *
 * Markdown like ``[label](vfs:path/to/file.png)`` renders as
 * ``<a class="vfs-download" data-vfs-path="...">`` (see markdown.js's
 * link override).  This handler turns those clicks into a fetch
 * from the agent's VFS + a browser blob download.
 *
 * The handler is delegated app-wide from App.svelte's window click
 * listener, so it works wherever rendered markdown lives — chat
 * messages (MessageList), thinking / report sections (EventDetail),
 * chapter summaries, etc.
 */

import { downloadFile } from "./agent.js";

/**
 * @param {MouseEvent} e
 */
export async function handleVfsClick(e) {
    const target = e.target?.closest?.(".vfs-download");
    if (!target) return;
    e.preventDefault();
    const raw = target.dataset.vfsPath;
    if (!raw) return;
    const path = decodeURIComponent(raw);
    try {
        const b64 = await downloadFile(path);
        const blob = base64ToBlob(b64);
        const url = URL.createObjectURL(blob);
        try {
            const a = document.createElement("a");
            a.href = url;
            a.download = path.split("/").pop() || "download";
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
        } finally {
            URL.revokeObjectURL(url);
        }
    } catch (err) {
        console.error("vfs download failed", path, err);
    }
}

/** Decode a base64 string into a Blob.  No mime type set — browsers
 * infer from the download anchor's filename, which is good enough
 * for most cases (PNG / PDF / CSV land with the right type). */
function base64ToBlob(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes]);
}
