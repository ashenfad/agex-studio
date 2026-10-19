/**
 * The studio's skills: each a directory here, its `SKILL.md` and any
 * files beside it (references, examples, templates), mounted read-only
 * at /workspace/skills/<name> in every session.
 */

import readmes from "virtual:package-readmes";

/** @typedef {{ name: string, files: Record<string, string> }} Skill */

/**
 * The agex-ecosystem skill's references: the studio's README and each
 * package's, as `references/<name>.md` (a scoped name without its
 * scope), each opening with the name and version it was taken from.
 *
 * @param {Record<string, { version: string, readme: string }>} packages
 * @returns {Record<string, string>}
 */
export function readmeFiles(packages) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const [name, { version, readme }] of Object.entries(packages)) {
        out[`./agex-ecosystem/references/${name.split("/").at(-1)}.md`] = `<!-- ${name} ${version} -->\n${readme}`;
    }
    return out;
}

/**
 * Skills from files by path (`./<name>/<rel>`), one per directory, in
 * name order.
 *
 * @param {Record<string, string>} sources
 * @returns {Skill[]}
 */
export function skillsFrom(sources) {
    /** @type {Map<string, Record<string, string>>} */
    const byName = new Map();
    for (const path of Object.keys(sources).sort()) {
        const [, name, ...rest] = path.split("/");
        if (name === undefined || rest.length === 0) continue;
        const files = byName.get(name) ?? {};
        files[rest.join("/")] = /** @type {string} */ (sources[path]);
        byName.set(name, files);
    }
    return [...byName].map(([name, files]) => ({ name, files }));
}

export const SKILLS = skillsFrom({
    .../** @type {Record<string, string>} */ (import.meta.glob("./*/**/*", { query: "?raw", import: "default", eager: true })),
    ...readmeFiles(readmes),
});
