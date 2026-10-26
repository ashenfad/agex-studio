/**
 * The vault: the person's keys for apps, and each app's grants to them.
 *
 * An entry is a key the person saved (a label, the value, and the
 * origins it may go to); a grant links one secret an app declares (in
 * `app/agex.json`, see `app-needs.js`) to one entry, by reference, so a
 * key replaced in the vault is replaced for every app that uses it. An
 * entry serves a need only while its origins cover the need's: apps and
 * keys meet by origin, not by name.
 *
 * It is kept in this device's `localStorage`, under a key of its own,
 * and nowhere else: not synced, not bundled, not published, and not in
 * any app's storage. Apps run on another origin, so can't read it.
 *
 * A value goes in, and out only to `valueFor`, for the request it is
 * for: the entries the vault shows (`entries`, `toJSON`) carry none,
 * and no error names one.
 */

import { checkKeyOrigins } from "./app-needs.js";
import { readLocalJson, writeLocalJson } from "./local.js";

/** Where the vault is kept. */
export const STORAGE_KEY = "agex-studio-vault";

/** The longest label an entry takes. */
export const LABEL_MAX = 80;

/**
 * An entry as the vault shows it: no value.
 * @typedef {{ id: string, label: string, origins: string[] }} VaultEntry
 * @typedef {{ name: string, origins: string[] }} Need
 * @typedef {Record<string, Record<string, string>>} Grants app key, then
 *   secret name, to entry id
 */

/** A change the vault refused: each thing wrong, in `errors`. */
export class VaultError extends Error {
    /** @param {string[]} errors */
    constructor(errors) {
        super(errors.join("; "));
        this.name = "VaultError";
        /** @type {string[]} */
        this.errors = errors;
    }
}

/**
 * Who a session's app is to its grants:
 *
 * - `gist:<owner>/<id>`, an app opened from a gist, so its new
 *   versions (each a session of its own) keep its grants;
 * - `bundle:<head>`, one opened from a bundle;
 * - `session:<name>`, the person's own (a fork included).
 *
 * @param {Pick<import("./store.js").SessionInfo, "name" | "source">} info
 */
export function appKeyOf(info) {
    const gist = info.source?.gist;
    if (gist !== undefined) return `gist:${gist.owner}/${gist.id}`;
    if (info.source !== undefined) return `bundle:${info.source.head}`;
    return `session:${info.name}`;
}

/**
 * The sessions whose app is `appKey`: one for the person's own, and
 * possibly several for an import (each opened copy of one gist).
 *
 * @template {Pick<import("./store.js").SessionInfo, "name" | "source">} T
 * @param {string} appKey @param {T[]} sessions
 * @returns {T[]}
 */
export function sessionsOf(appKey, sessions) {
    return sessions.filter((s) => appKeyOf(s) === appKey);
}

/**
 * An entry's fields checked, from what the person typed, each error in
 * the order the fields are asked for: the label trimmed and not one of
 * `taken` (another entry's), the key trimmed (left out, no key is
 * checked: an edit keeping the one saved), the origins normalized (blank
 * lines skipped). No error shows the key.
 *
 * @param {{ label?: unknown, value?: unknown, origins?: unknown }} fields
 * @param {{ studioOrigins?: Iterable<string>, taken?: string[] }} [opts]
 *   `studioOrigins` as `checkKeyOrigins`'s
 * @returns {{ label: string, value: string, origins: string[], errors: string[] }}
 */
export function checkFields({ label, value, origins }, opts = {}) {
    /** @type {string[]} */
    const errors = [];
    const text = typeof label === "string" ? label.trim() : "";
    if (text === "") errors.push(`label: give the key a name, like "Stripe (personal)"`);
    else if (text.length > LABEL_MAX) errors.push(`label: keep it to ${LABEL_MAX} characters or fewer`);
    else if ((opts.taken ?? []).some((t) => t.toLowerCase() === text.toLowerCase())) errors.push(`label: another key is called "${text}"; give this one its own name`);
    const key = typeof value === "string" ? value.trim() : "";
    if (value !== undefined && key === "") errors.push("key: paste the key");
    const list = Array.isArray(origins) ? origins : [];
    const checked = checkKeyOrigins(list, opts);
    if (list.every((o) => typeof o === "string" && o.trim() === "")) errors.push(`origins: list where the key may go, one per line, like "https://api.stripe.com"`);
    errors.push(...checked.errors);
    return { label: text, value: key, origins: checked.origins, errors };
}

/** A new entry's id. */
function newId() {
    const bytes = crypto.getRandomValues(new Uint8Array(9));
    return `k-${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Whether `entry`'s origins include every one of `origins`; a need
 *  that lists none is covered by no entry.
 *  @param {VaultEntry} entry @param {string[]} origins */
function covers(entry, origins) {
    return origins.length > 0 && origins.every((o) => entry.origins.includes(o));
}

export class Vault {
    /** The entries, in the order they were added, without values.
     *  @type {VaultEntry[]} */
    entries = $state([]);
    /** Each app's grants. @type {Grants} */
    grants = $state({});
    /** Each entry's value, by id. @type {Map<string, string>} */
    #values = new Map();

    constructor() {
        this.#load();
        // another tab's change shows here
        if (typeof window !== "undefined") {
            window.addEventListener("storage", (e) => {
                if (e.key === STORAGE_KEY) this.#load();
            });
        }
    }

    /** Read what is kept, dropping what doesn't hold together (an entry
     *  without a value or origins, a grant to no entry). With nothing
     *  readable, what this page holds stays. */
    #load() {
        const kept = readLocalJson(STORAGE_KEY);
        if (kept === null || typeof kept !== "object") return;
        /** @type {VaultEntry[]} */
        const entries = [];
        /** @type {Map<string, string>} */
        const values = new Map();
        for (const e of Array.isArray(kept.entries) ? kept.entries : []) {
            if (e === null || typeof e !== "object") continue;
            const { id, label, value, origins } = e;
            if (typeof id !== "string" || typeof label !== "string" || typeof value !== "string" || value === "") continue;
            if (!Array.isArray(origins) || origins.length === 0 || !origins.every((o) => typeof o === "string")) continue;
            if (values.has(id)) continue;
            entries.push({ id, label, origins: [...origins] });
            values.set(id, value);
        }
        /** @type {Grants} */
        const grants = {};
        const held = typeof kept.grants === "object" && kept.grants !== null ? kept.grants : {};
        for (const [app, names] of Object.entries(held)) {
            if (names === null || typeof names !== "object") continue;
            for (const [name, id] of Object.entries(names)) {
                if (typeof id === "string" && values.has(id)) (grants[app] ??= {})[name] = id;
            }
        }
        this.entries = entries;
        this.grants = grants;
        this.#values = values;
    }

    #save() {
        const entries = this.entries.map((e) => ({ id: e.id, label: e.label, value: this.#values.get(e.id), origins: [...e.origins] }));
        writeLocalJson(STORAGE_KEY, { entries, grants: $state.snapshot(this.grants) });
    }

    /** Make a change to the vault as it is kept now (another tab's
     *  changes included), then keep it. @template T @param {() => T} fn */
    #change(fn) {
        this.#load();
        const out = fn();
        this.#save();
        return out;
    }

    /** Entry `id`, or a refusal. @param {string} id */
    #entry(id) {
        const entry = this.entries.find((e) => e.id === id);
        if (entry === undefined) throw new VaultError([`no key ${JSON.stringify(id)} in the vault`]);
        return entry;
    }

    /** The labels of the entries other than `id`. @param {string} [id] */
    #labelsBut(id) {
        return this.entries.filter((e) => e.id !== id).map((e) => e.label);
    }

    /**
     * Add a key; its id. Refused, with each thing wrong, for a missing
     * label or key, or origins that aren't `https://host` alone.
     *
     * @param {{ label: string, value: string, origins: string[] }} fields
     * @param {{ studioOrigins?: Iterable<string> }} [opts]
     */
    add({ label, value, origins }, opts = {}) {
        return this.#change(() => {
            const fields = checkFields({ label, value: value ?? "", origins }, { ...opts, taken: this.#labelsBut() });
            if (fields.errors.length > 0) throw new VaultError(fields.errors);
            const id = newId();
            this.entries.push({ id, label: fields.label, origins: fields.origins });
            this.#values.set(id, fields.value);
            return id;
        });
    }

    /**
     * Change entry `id`: its label, its origins, or its key (`value`, a
     * new one in its place). What isn't given stays. Narrowed origins
     * keep its grants, but a need they no longer cover gets no value.
     *
     * @param {string} id
     * @param {{ label?: string, origins?: string[], value?: string }} patch
     * @param {{ studioOrigins?: Iterable<string> }} [opts]
     */
    update(id, { label, origins, value }, opts = {}) {
        this.#change(() => {
            const entry = this.#entry(id);
            const fields = checkFields({ label: label ?? entry.label, value, origins: origins ?? entry.origins }, { ...opts, taken: this.#labelsBut(id) });
            if (fields.errors.length > 0) throw new VaultError(fields.errors);
            entry.label = fields.label;
            entry.origins = fields.origins;
            if (value !== undefined) this.#values.set(id, fields.value);
        });
    }

    /** Remove entry `id`, and every grant to it. @param {string} id */
    remove(id) {
        this.#change(() => {
            this.entries = this.entries.filter((e) => e.id !== id);
            this.#values.delete(id);
            for (const [app, names] of Object.entries(this.grants)) {
                for (const [name, to] of Object.entries(names)) if (to === id) delete names[name];
                if (Object.keys(names).length === 0) delete this.grants[app];
            }
        });
    }

    /** The entries whose origins cover every one of `origins` (a
     *  need's): those that can serve it. @param {string[]} origins */
    entriesCovering(origins) {
        return this.entries.filter((e) => covers(e, origins));
    }

    /**
     * Grant app `appKey`'s secret `need.name` the key in entry
     * `entryId`, in place of any it had. Refused unless the entry's
     * origins cover the need's.
     *
     * @param {string} appKey @param {Need} need @param {string} entryId
     */
    grant(appKey, need, entryId) {
        this.#change(() => {
            const entry = this.#entry(entryId);
            if (typeof need?.name !== "string" || need.name === "") throw new VaultError(["a grant is for a secret the app names"]);
            const missing = (need.origins ?? []).filter((o) => !entry.origins.includes(o));
            if (!covers(entry, need.origins ?? [])) {
                const which = missing.length > 0 ? `: it may go to ${entry.origins.join(", ")}, not ${missing.join(", ")}` : "";
                throw new VaultError([`"${entry.label}" doesn't cover ${need.name}'s origins${which}`]);
            }
            (this.grants[appKey] ??= {})[need.name] = entryId;
        });
    }

    /** Take back app `appKey`'s grant for secret `name`, or with no
     *  name every grant it has. @param {string} appKey @param {string} [name] */
    revoke(appKey, name) {
        this.#change(() => {
            const names = this.grants[appKey];
            if (names === undefined) return;
            if (name !== undefined) delete names[name];
            if (name === undefined || Object.keys(names).length === 0) delete this.grants[appKey];
        });
    }

    /** App `appKey`'s grants: each secret's entry id.
     *  @param {string} appKey @returns {Record<string, string>} */
    grantsOf(appKey) {
        return { ...this.grants[appKey] };
    }

    /** The apps granted entry `id`, and the secret each uses it as.
     *  @param {string} id @returns {{ appKey: string, name: string }[]} */
    usedBy(id) {
        return Object.entries(this.grants).flatMap(([appKey, names]) =>
            Object.entries(names)
                .filter(([, to]) => to === id)
                .map(([name]) => ({ appKey, name })),
        );
    }

    /**
     * The key app `appKey` has for `need`: null when it has no grant for
     * it, the entry is gone, or the entry no longer covers the need's
     * origins.
     *
     * @param {string} appKey @param {Need} need
     * @returns {string | null}
     */
    valueFor(appKey, need) {
        const id = this.grants[appKey]?.[need.name];
        const entry = id === undefined ? undefined : this.entries.find((e) => e.id === id);
        if (entry === undefined || !covers(entry, need.origins ?? [])) return null;
        return this.#values.get(entry.id) ?? null;
    }

    /** Give app `toKey` app `fromKey`'s grants (a fork its parent's),
     *  beside any of its own. @param {string} fromKey @param {string} toKey */
    copyGrants(fromKey, toKey) {
        if (fromKey === toKey) return;
        this.#change(() => {
            const from = this.grants[fromKey];
            if (from !== undefined) this.grants[toKey] = { ...this.grants[toKey], ...from };
        });
    }

    /** App `appKey` is gone: its grants go. @param {string} appKey */
    forgetApp(appKey) {
        this.revoke(appKey);
    }

    /** The vault as it may be shown: entries without values. */
    toJSON() {
        return { entries: $state.snapshot(this.entries), grants: $state.snapshot(this.grants) };
    }

    toString() {
        return `Vault(${this.entries.length} keys)`;
    }
}

/** This device's vault. */
export const vault = new Vault();
