/**
 * Drive import — on-demand OAuth + picker + download into VFS.
 *
 * Replaces the live /drive/ virtual mount. Users pick files via the
 * Google Picker; we fetch each file's bytes (with the access token in
 * main-thread scope only) and post them to the worker to write into
 * the agent's VFS under /downloads/.
 *
 * Token lifecycle: obtained at click time, used during downloads,
 * dropped immediately after. Never enters the Pyodide worker's Python
 * scope.
 */

import { requestAccessToken, isGoogleAvailable } from "./google-auth.js";
import { openPicker, isPickerAvailable } from "./google-picker.js";
import { getActiveAdapter } from "./active-adapter.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

/**
 * Export mappings for Google-native formats.
 * @type {Record<string, {mime: string, ext: string}>}
 */
const EXPORT_MAP = {
    "application/vnd.google-apps.document": {
        mime: "text/plain",
        ext: ".txt",
    },
    "application/vnd.google-apps.spreadsheet": {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ext: ".xlsx",
    },
    "application/vnd.google-apps.presentation": {
        mime: "application/pdf",
        ext: ".pdf",
    },
};

/**
 * Whether Drive import is available (both auth + picker configured).
 */
export function isDriveImportAvailable() {
    return isGoogleAvailable() && isPickerAvailable();
}

/**
 * Derive a safe filename from a picked file's name + its resolved
 * extension. Avoids double-extensions like "MyDoc.txt.txt" when the
 * user already has the extension in the name, and sanitizes path
 * separators.
 *
 * @param {string} pickedName
 * @param {string} ext - extension including leading dot (e.g. ".xlsx")
 */
function _resolveFilename(pickedName, ext) {
    const safe = pickedName.replace(/[/\\]/g, "_");
    if (ext && safe.toLowerCase().endsWith(ext.toLowerCase())) return safe;
    return `${safe}${ext}`;
}

/**
 * Fetch a single picked file's bytes from Drive.
 *
 * @param {{id: string, name: string, mimeType: string}} file
 * @param {string} token
 * @returns {Promise<{filename: string, bytes: Uint8Array}>}
 */
async function _fetchFile(file, token) {
    const exportInfo = EXPORT_MAP[file.mimeType];
    let url;
    let filename;

    if (exportInfo) {
        // Google-native format: use export endpoint
        const params = new URLSearchParams({ mimeType: exportInfo.mime });
        url = `${DRIVE_API}/${file.id}/export?${params}`;
        filename = _resolveFilename(file.name, exportInfo.ext);
    } else {
        // Regular file: fetch bytes directly
        url = `${DRIVE_API}/${file.id}?alt=media`;
        filename = file.name;
    }

    const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
    });

    if (!resp.ok) {
        let msg;
        try {
            const body = await resp.json();
            msg = body?.error?.message || JSON.stringify(body);
        } catch {
            msg = `HTTP ${resp.status}`;
        }
        throw new Error(`Drive download failed for "${file.name}": ${msg}`);
    }

    const buffer = await resp.arrayBuffer();
    return { filename, bytes: new Uint8Array(buffer) };
}

/**
 * Run the full import flow: request token → open picker → download
 * selected files → write to VFS.
 *
 * @returns {Promise<string[]>} List of filenames written to VFS
 *   (relative to the VFS root, e.g. "downloads/foo.xlsx"). Empty if
 *   the user cancelled at any step.
 */
export async function importFromDrive() {
    if (!isDriveImportAvailable()) {
        throw new Error("Drive import is not available (Google client not configured)");
    }

    // 1. Get a fresh access token (popup usually silent after first consent)
    const token = await requestAccessToken();
    if (!token) return [];  // user cancelled

    try {
        // 2. Open the Drive picker
        const picked = await openPicker(token);
        if (picked.length === 0) return [];

        // 3. Fetch each file in parallel; collect successes and surface
        //    per-file errors. allSettled (not all) so one bad fetch
        //    doesn't drop the whole batch.
        const results = await Promise.allSettled(
            picked.map(async (file) => {
                const { filename, bytes } = await _fetchFile(file, token);
                return { path: `downloads/${filename}`, bytes };
            }),
        );

        const writeBatch = {};
        const errors = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (r.status === "fulfilled") {
                writeBatch[r.value.path] = r.value.bytes;
            } else {
                errors.push(`${picked[i].name}: ${r.reason?.message || r.reason}`);
            }
        }
        if (errors.length > 0) {
            console.warn("[drive-import] Some files failed:", errors);
        }

        // 4. One adapter write commits all the downloads atomically;
        //    one kvgit commit instead of N (the previous per-file
        //    `writeDownloadedFile` path).
        const written = Object.keys(writeBatch);
        if (written.length > 0) {
            const { adapter, branch } = await getActiveAdapter();
            await adapter.writeFiles(branch, writeBatch);
        }
        return written;
    } finally {
        // Token falls out of scope — main thread drops its reference.
        // Google's server-side lifetime (~1 hour) is the outer bound;
        // we don't actively revoke.
    }
}
