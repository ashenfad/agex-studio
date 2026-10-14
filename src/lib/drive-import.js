/**
 * Files from Google Drive: an access token asked for at the click, the
 * Picker, and each picked file's bytes.
 *
 * The token lives only in this call: it is used for the downloads and
 * dropped (Google expires it within the hour), and it never reaches the
 * workspace or the agent. A Google-native file is exported to a format
 * code can read (a Doc as text, a Sheet as .xlsx, Slides as PDF).
 */

import { isGoogleAvailable, requestAccessToken } from "./google-auth.js";
import { isPickerAvailable, openPicker } from "./google-picker.js";

const DRIVE_API = "https://www.googleapis.com/drive/v3/files";

/** @type {Record<string, { mime: string, ext: string }>} */
const EXPORTS = {
    "application/vnd.google-apps.document": { mime: "text/plain", ext: ".txt" },
    "application/vnd.google-apps.spreadsheet": {
        mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ext: ".xlsx",
    },
    "application/vnd.google-apps.presentation": { mime: "application/pdf", ext: ".pdf" },
};

/** Whether Drive import is configured (a client id and an API key). */
export function isDriveImportAvailable() {
    return isGoogleAvailable() && isPickerAvailable();
}

/** A picked file's name with `ext`, unless it has it already; no path
 *  separators. @param {string} name @param {string} ext */
export function fileName(name, ext) {
    const safe = name.replace(/[/\\]/g, "_");
    return ext && !safe.toLowerCase().endsWith(ext.toLowerCase()) ? `${safe}${ext}` : safe;
}

/** @param {{ id: string, name: string, mimeType: string }} file @param {string} token */
async function download(file, token) {
    const exported = EXPORTS[file.mimeType];
    const url = exported
        ? `${DRIVE_API}/${file.id}/export?${new URLSearchParams({ mimeType: exported.mime })}`
        : `${DRIVE_API}/${file.id}?alt=media`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) {
        const body = await r.json().catch(() => null);
        throw new Error(`${file.name}: ${body?.error?.message ?? `HTTP ${r.status}`}`);
    }
    return { name: fileName(file.name, exported?.ext ?? ""), bytes: new Uint8Array(await r.arrayBuffer()) };
}

/**
 * Ask for a token, open the Picker, and download what was picked: the
 * files, and an error for each that failed. Empty when the person
 * cancels at either step.
 *
 * @returns {Promise<{ files: { name: string, bytes: Uint8Array }[], errors: string[] }>}
 */
export async function pickFromDrive() {
    if (!isDriveImportAvailable()) throw new Error("Drive import isn't configured");
    const token = await requestAccessToken();
    if (!token) return { files: [], errors: [] };
    const picked = await openPicker(token);
    const settled = await Promise.allSettled(picked.map((f) => download(f, token)));
    /** @type {{ name: string, bytes: Uint8Array }[]} */
    const files = [];
    /** @type {string[]} */
    const errors = [];
    for (const s of settled) {
        if (s.status === "fulfilled") files.push(s.value);
        else errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason));
    }
    return { files, errors };
}
