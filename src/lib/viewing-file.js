/**
 * Shared "file currently being viewed in the file-preview modal" store.
 *
 * Multiple call sites open the file modal:
 *
 *   - FileDrawer.svelte: clicking a file in the list.
 *   - vfs-download.js: clicking a `[label](vfs:path)` markdown link
 *     anywhere rendered markdown surfaces (chat messages, report
 *     sections inside the activity modal, chapter summaries, etc.).
 *
 * Centralizing the state means `FileModal` renders once at the App
 * level and any of those clicks can set `viewingFile` to open it.
 * Previously each opener kept its own local state + rendered its own
 * `FileModal` instance, which meant the link-click handler had no
 * easy way to reach a modal.
 *
 * Set to a `string` (the VFS path) to open the modal; set to `null`
 * to close.
 */

import { writable } from "svelte/store";

/** @type {import('svelte/store').Writable<string | null>} */
export const viewingFile = writable(null);
