/**
 * Pending file attachments for the next chat message.
 *
 * Multiple call sites add to this:
 *   - `ChatInput`'s `+ Local files` menu item (opens file picker).
 *   - `ChatShell`'s chat-area drag-drop handler.
 *   - (future) clipboard paste.
 *
 * Files queue here as `{name, bytes}` entries. They're not written to
 * the VFS until the user clicks Send — at which point `ChatShell`'s
 * `handleSend` writes them via `adapter.writeFiles`, fires
 * `handleUpload` (which renders the upload bubble), and then sends
 * the prompt (if any).
 *
 * "Remove" from this queue is non-destructive — files aren't in the
 * VFS yet, removing a chip just drops the entry.
 *
 * Drive imports DON'T go through this queue — they have their own
 * "import to VFS now" flow (see `drive-import.js` + `ChatInput`'s
 * `+ Google Drive` menu item). Drive paths land in the VFS
 * immediately and trigger `handleUpload` directly without queueing.
 */

import { writable } from "svelte/store";

/**
 * @typedef {Object} PendingAttachment
 * @property {string} name
 * @property {Uint8Array} bytes
 */

/** @type {import('svelte/store').Writable<PendingAttachment[]>} */
export const pendingAttachments = writable([]);

/**
 * Read each File from a FileList / File[] and append to the queue.
 * @param {FileList | File[]} fileList
 */
export async function queueFiles(fileList) {
    const list = Array.from(fileList);
    if (list.length === 0) return;
    const entries = await Promise.all(
        list.map(async (f) => ({
            name: f.name,
            bytes: new Uint8Array(await f.arrayBuffer()),
        })),
    );
    pendingAttachments.update((a) => [...a, ...entries]);
}

/** @param {number} index */
export function removeAttachment(index) {
    pendingAttachments.update((a) => a.filter((_, i) => i !== index));
}

export function clearAttachments() {
    pendingAttachments.set([]);
}
