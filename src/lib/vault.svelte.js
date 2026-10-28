/**
 * The vault: the person's keys, each app's and each session's agent's
 * grants to them, and the apps allowed the person's model.
 *
 * An entry is a key the person saved (a label, the value, and the
 * origins it may go to); a grant links one secret an app declares (in
 * `app/agex.json`, see `app-needs.js`) to one entry, by reference, so a
 * key replaced in the vault is replaced for every app that uses it. An
 * entry serves a need only while its origins cover the need's: apps and
 * keys meet by origin, not by name. An app allowed the model (`models`)
 * may run its calls on the person's model and key until that is revoked.
 *
 * A session's agent has a key two ways: an entry the person made
 * available to their agents (`agentName`, the name agents know it by),
 * which every session's agent has; or a grant to that session's agent
 * (`agentGrants`, under `agent:<session>`), which keeps the origins the
 * person approved, the key going to those only. A grant beats an entry
 * made available under the same name. An agent's grants are apart from
 * its session's app's: granting one gives the other nothing.
 *
 * It is kept in this device's `localStorage`, under a key of its own,
 * and nowhere else: not synced, not bundled, not published, and not in
 * any app's storage. Apps run on another origin, so can't read it.
 *
 * A value goes in, and out only to `valueFor`, for the request it is
 * for: the entries the vault shows (`entries`, `toJSON`) carry none,
 * and no error names one.
 */

import { checkKeyOrigins, secretNameRefusal } from "./app-needs.js";
import { readLocalJson, writeLocalJson } from "./local.js";

/** Where the vault is kept. */
export const STORAGE_KEY = "agex-studio-vault";

/** The longest label an entry takes. */
export const LABEL_MAX = 80;

/**
 * An entry as the vault shows it: no value. `agentName`, when there is
 * one, is the name the person's agents have it by.
 * @typedef {{ id: string, label: string, origins: string[], agentName?: string }} VaultEntry
 * @typedef {{ name: string, origins: string[] }} Need
 * @typedef {Record<string, Record<string, string>>} Grants app key, then
 *   secret name, to entry id
 * @typedef {Record<string, true>} ModelGrants the apps allowed the
 *   model, by app key
 * @typedef {{ entry: string, origins: string[] }} AgentGrant an entry,
 *   and the origins the person approved it for
 * @typedef {Record<string, Record<string, AgentGrant>>} AgentGrants
 *   agent key (`agentKeyOf`), then secret name, to its grant
 * @typedef {Readonly<Record<string, { value: string, origins: string[] }>>} AgentSecrets
 *   a profile's `secrets`
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
 * Who session `name`'s agent is to its grants: `agent:<session>`, a
 * delegate (`top.child`) its top session's, whose grants it has.
 *
 * @param {string} name
 */
export function agentKeyOf(name) {
    return `agent:${name.split(".")[0]}`;
}

/** Whether app `appKey` is the person's own (see `appKeyOf`).
 *  @param {string} appKey */
export function isOwnApp(appKey) {
    return appKey.startsWith("session:");
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
    /** The apps allowed the person's model. @type {ModelGrants} */
    models = $state({});
    /** Each session's agent's grants. @type {AgentGrants} */
    agentGrants = $state({});
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
     *  without a value or origins, a grant to no entry, a model grant
     *  that isn't `true`, a name for agents that isn't one or another
     *  entry has). With nothing readable, what this page holds stays. */
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
            const named = typeof e.agentName === "string" && secretNameRefusal(e.agentName) === null && !entries.some((x) => x.agentName === e.agentName);
            entries.push({ id, label, origins: [...origins], ...(named && { agentName: e.agentName }) });
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
        /** @type {ModelGrants} */
        const models = {};
        const allowed = typeof kept.models === "object" && kept.models !== null ? kept.models : {};
        for (const [app, yes] of Object.entries(allowed)) if (yes === true) models[app] = true;
        /** @type {AgentGrants} */
        const agentGrants = {};
        const given = typeof kept.agentGrants === "object" && kept.agentGrants !== null ? kept.agentGrants : {};
        for (const [agent, names] of Object.entries(given)) {
            if (!agent.startsWith("agent:") || names === null || typeof names !== "object") continue;
            for (const [name, g] of Object.entries(names)) {
                if (g === null || typeof g !== "object" || typeof g.entry !== "string" || !values.has(g.entry)) continue;
                if (!Array.isArray(g.origins) || g.origins.length === 0 || !g.origins.every((o) => typeof o === "string")) continue;
                if (secretNameRefusal(name) !== null) continue;
                (agentGrants[agent] ??= {})[name] = { entry: g.entry, origins: [...g.origins] };
            }
        }
        this.entries = entries;
        this.grants = grants;
        this.models = models;
        this.agentGrants = agentGrants;
        this.#values = values;
    }

    #save() {
        const entries = this.entries.map((e) => ({ id: e.id, label: e.label, value: this.#values.get(e.id), origins: [...e.origins], ...(e.agentName !== undefined && { agentName: e.agentName }) }));
        writeLocalJson(STORAGE_KEY, { entries, grants: $state.snapshot(this.grants), models: $state.snapshot(this.models), agentGrants: $state.snapshot(this.agentGrants) });
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

    /** Remove entry `id`, and every grant to it, an app's or an
     *  agent's. @param {string} id */
    remove(id) {
        this.#change(() => {
            this.entries = this.entries.filter((e) => e.id !== id);
            this.#values.delete(id);
            for (const [app, names] of Object.entries(this.grants)) {
                for (const [name, to] of Object.entries(names)) if (to === id) delete names[name];
                if (Object.keys(names).length === 0) delete this.grants[app];
            }
            for (const [agent, names] of Object.entries(this.agentGrants)) {
                for (const [name, g] of Object.entries(names)) if (g.entry === id) delete names[name];
                if (Object.keys(names).length === 0) delete this.agentGrants[agent];
            }
        });
    }

    /**
     * Make entry `id` available to every session's agent as `name`, or
     * with null no longer. Refused for a name that isn't upper-case
     * letters, digits and _, or that another entry has.
     *
     * @param {string} id @param {string | null} name
     */
    setAgentName(id, name) {
        this.#change(() => {
            const entry = this.#entry(id);
            if (name === null) {
                delete entry.agentName;
                return;
            }
            const why = secretNameRefusal(name);
            if (why !== null) throw new VaultError([`name for agents: ${why}`]);
            const other = this.entries.find((e) => e.id !== id && e.agentName === name);
            if (other !== undefined) throw new VaultError([`name for agents: "${other.label}" is ${name} to your agents; give this one its own name`]);
            entry.agentName = name;
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

    /** Allow app `appKey` the person's model. @param {string} appKey */
    allowModel(appKey) {
        this.#change(() => {
            this.models[appKey] = true;
        });
    }

    /** Whether app `appKey` is allowed the person's model.
     *  @param {string} appKey */
    modelAllowed(appKey) {
        return this.models[appKey] === true;
    }

    /** Take back app `appKey`'s use of the model. @param {string} appKey */
    revokeModel(appKey) {
        this.#change(() => {
            delete this.models[appKey];
        });
    }

    /** Give app `toKey` app `fromKey`'s grants and its model grant (a
     *  fork its parent's), beside any of its own.
     *  @param {string} fromKey @param {string} toKey */
    copyGrants(fromKey, toKey) {
        if (fromKey === toKey) return;
        this.#change(() => {
            const from = this.grants[fromKey];
            if (from !== undefined) this.grants[toKey] = { ...this.grants[toKey], ...from };
            if (this.models[fromKey]) this.models[toKey] = true;
        });
    }

    /** App `appKey` is gone: its grants go, and its model grant.
     *  @param {string} appKey */
    forgetApp(appKey) {
        this.revoke(appKey);
        this.revokeModel(appKey);
    }

    /**
     * Grant session `session`'s agent the key in entry `entryId` as
     * secret `name`, for `origins`, in place of any grant it had under
     * that name. Refused for a name that isn't one, origins that aren't
     * `https://host` alone (or are the studio's), or an entry whose
     * origins don't cover them. A delegate's grant is its top session's.
     *
     * @param {string} session
     * @param {{ name: string, origins: string[] }} want
     * @param {string} entryId
     * @param {{ studioOrigins?: Iterable<string> }} [opts]
     */
    grantAgent(session, { name, origins }, entryId, opts = {}) {
        this.#change(() => {
            const entry = this.#entry(entryId);
            const why = secretNameRefusal(name);
            if (why !== null) throw new VaultError([`name: ${why}`]);
            const checked = checkKeyOrigins(Array.isArray(origins) ? origins : [], opts);
            if (checked.errors.length > 0) throw new VaultError(checked.errors);
            if (checked.origins.length === 0) throw new VaultError([`origins: name where ${name} may go, like "https://api.stripe.com"`]);
            const missing = checked.origins.filter((o) => !entry.origins.includes(o));
            if (missing.length > 0) throw new VaultError([`"${entry.label}" may go to ${entry.origins.join(", ")}, not ${missing.join(", ")}`]);
            (this.agentGrants[agentKeyOf(session)] ??= {})[name] = { entry: entryId, origins: checked.origins };
        });
    }

    /** Take back session `session`'s agent's grant for secret `name`, or
     *  with no name every grant it has. @param {string} session @param {string} [name] */
    revokeAgent(session, name) {
        this.#change(() => {
            const key = agentKeyOf(session);
            const names = this.agentGrants[key];
            if (names === undefined) return;
            if (name !== undefined) delete names[name];
            if (name === undefined || Object.keys(names).length === 0) delete this.agentGrants[key];
        });
    }

    /** Session `session` is gone: its agent's grants go. A delegate's
     *  are its top session's, which keeps them. @param {string} session */
    forgetAgent(session) {
        if (!session.includes(".")) this.revokeAgent(session);
    }

    /** Session `session`'s agent's grants, by secret name.
     *  @param {string} session @returns {Record<string, AgentGrant>} */
    agentGrantsOf(session) {
        return $state.snapshot(this.agentGrants[agentKeyOf(session)] ?? {});
    }

    /** The sessions whose agents are granted entry `id`, and the secret
     *  each has it as. @param {string} id @returns {{ session: string, name: string }[]} */
    agentsUsing(id) {
        return Object.entries(this.agentGrants).flatMap(([agent, names]) =>
            Object.entries(names)
                .filter(([, g]) => g.entry === id)
                .map(([name]) => ({ session: agent.slice("agent:".length), name })),
        );
    }

    /** Give session `to`'s agent session `from`'s agent's grants (a fork
     *  its parent's), beside any of its own. @param {string} from @param {string} to */
    copyAgentGrants(from, to) {
        const [fromKey, toKey] = [agentKeyOf(from), agentKeyOf(to)];
        if (fromKey === toKey) return;
        this.#change(() => {
            const grants = this.agentGrants[fromKey];
            if (grants !== undefined) this.agentGrants[toKey] = { ...this.agentGrants[toKey], ...$state.snapshot(grants) };
        });
    }

    /**
     * The secrets session `session`'s agent has now, as its world's
     * profile takes them: each entry made available, by its name for
     * agents, to its own origins; then the session's grants, each to the
     * origins approved, in place of one made available by the same name.
     * A grant whose entry no longer covers its origins gives nothing under
     * its name, not the one made available: the person chose this
     * session's key, and another (a production key, say) mustn't stand in.
     *
     * @param {string} session @returns {AgentSecrets}
     */
    agentSecrets(session) {
        /** @type {Record<string, { value: string, origins: string[] }>} */
        const out = {};
        for (const e of this.entries) {
            const value = this.#values.get(e.id);
            if (e.agentName !== undefined && value !== undefined) out[e.agentName] = { value, origins: [...e.origins] };
        }
        for (const [name, g] of Object.entries(this.agentGrants[agentKeyOf(session)] ?? {})) {
            const entry = this.entries.find((e) => e.id === g.entry);
            const value = this.#values.get(g.entry);
            delete out[name];
            if (entry !== undefined && value !== undefined && covers(entry, g.origins)) out[name] = { value, origins: [...g.origins] };
        }
        return out;
    }

    /** The vault as it may be shown: entries without values. */
    toJSON() {
        return { entries: $state.snapshot(this.entries), grants: $state.snapshot(this.grants), models: $state.snapshot(this.models), agentGrants: $state.snapshot(this.agentGrants) };
    }

    toString() {
        return `Vault(${this.entries.length} keys)`;
    }
}

/** This device's vault. */
export const vault = new Vault();
