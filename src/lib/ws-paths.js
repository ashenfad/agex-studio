/**
 * Workspace paths for the studio's host objects, which take paths from
 * code: relative ones are taken from the workspace root (not the code's
 * working directory, which a host object doesn't share), and nothing
 * may land outside the root.
 */

/** `path` with `.` and `..` resolved, absolute. @param {string} path */
function normalize(path) {
    /** @type {string[]} */
    const out = [];
    for (const part of path.split("/")) {
        if (part === "" || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
    }
    return `/${out.join("/")}`;
}

/**
 * The absolute path `raw` names in a workspace rooted at `root`, or an
 * error naming `label` when it is empty or outside the root.
 *
 * @param {string} label the call, as code wrote it
 * @param {string} root
 * @param {string} raw
 */
export function inWorkspace(label, root, raw) {
    const trimmed = raw.trim();
    if (trimmed === "") throw new Error(`${label}: say where (a path)`);
    const full = normalize(trimmed.startsWith("/") ? trimmed : `${root}/${trimmed}`);
    if (full !== root && !full.startsWith(`${root}/`)) throw new Error(`${label}: ${JSON.stringify(raw)} is outside ${root}`);
    return full;
}

/** The directory holding `path`. @param {string} path */
export function parentOf(path) {
    return path.slice(0, path.lastIndexOf("/")) || "/";
}

/**
 * Write `data` to `path` through `fs`, making its directories: pending
 * until the call's commit, as the code's own writes are.
 *
 * @param {import("@agex-ts/world").Workspace["files"]["fs"]} fs
 * @param {string} path
 * @param {Uint8Array} data
 */
export async function writeFile(fs, path, data) {
    await fs.mkdir(parentOf(path), { parents: true, existOk: true });
    await fs.write(path, data);
}
