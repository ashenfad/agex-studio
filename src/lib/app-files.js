/**
 * A session's app: the files under `/workspace/app`, as the preview and
 * `test_app` build it (`buildAppPage` takes text files by `app/<path>`,
 * and binary assets beside them).
 */

import { isBinaryAppFile } from "./app-assets.js";

/** Where a session's app lives. */
const APP_DIR = "/workspace/app";

/** @typedef {{ files: Record<string, string>, binaries: Record<string, Uint8Array> }} AppFiles */

/**
 * The app's files, read from `ws`: text files and binary assets, each
 * keyed `app/<path>`. Empty when there is no app.
 *
 * @param {import("@agex-ts/world").Workspace} ws
 * @returns {Promise<AppFiles>}
 */
export async function readApp(ws) {
    /** @type {AppFiles} */
    const out = { files: {}, binaries: {} };
    /** @type {string[]} */
    let paths;
    try {
        paths = await ws.files.list(APP_DIR, { recursive: true });
    } catch {
        return out;
    }
    const decoder = new TextDecoder();
    for (const rel of paths) {
        // a listed directory has its files listed after it
        if (paths.some((p) => p.startsWith(`${rel}/`))) continue;
        let bytes;
        try {
            bytes = await ws.files.read(`${APP_DIR}/${rel}`);
        } catch {
            continue;
        }
        const key = `app/${rel}`;
        if (isBinaryAppFile(rel)) out.binaries[key] = bytes;
        else out.files[key] = decoder.decode(bytes);
    }
    return out;
}

/** Whether there is an app to show: an entry page or a main script.
 *  @param {AppFiles} app */
export function hasApp(app) {
    return "app/index.html" in app.files || "app/main.js" in app.files;
}

/** A cheap fingerprint of the app, to tell whether it changed.
 *  @param {AppFiles} app */
export function appDigest(app) {
    let h = 0;
    const add = (/** @type {string} */ s) => {
        for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
    };
    for (const key of Object.keys(app.files).sort()) {
        add(key);
        add(app.files[key] ?? "");
    }
    for (const key of Object.keys(app.binaries).sort()) {
        add(key);
        const bytes = app.binaries[key] ?? new Uint8Array();
        add(String(bytes.length));
        for (let i = 0; i < bytes.length; i++) h = (Math.imul(h, 31) + (bytes[i] ?? 0)) | 0;
    }
    return `${Object.keys(app.files).length}:${Object.keys(app.binaries).length}:${h}`;
}
