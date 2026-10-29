/**
 * A session's variables: configuration anyone may read (a service's
 * URL, a public key), kept on the session's plane under `variables`, so
 * a checkout rewinds them, a fork copies them, and a bundle or a publish
 * carries them. Its agent has them live (`env.NAME` in code, `$NAME` in
 * the shell), its delegates their top session's.
 *
 * A name is a key or a variable, not both: setting one refuses a name
 * the session's agent has as a key, or one the app declares as a secret
 * (`app/agex.json`). A key made available to agents later under a
 * variable's name wins: the variable is left out of the world.
 */

/** The plane key a session's variables are kept under. */
export const VARIABLES_KEY = "variables";

/** How many a session may have. */
export const MAX_VARIABLES = 64;

/** A value's most bytes (UTF-8): configuration, not data. */
export const VALUE_MAX = 4096;

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** A name's most characters. */
const NAME_MAX = 64;

/** @typedef {Record<string, string>} Variables */

/**
 * Why `name` can't be a variable's name, or null when it can.
 * @param {unknown} name
 */
export function variableNameRefusal(name) {
    if (typeof name !== "string" || !NAME.test(name)) return "a name is letters, digits and _, not starting with a digit (like API_URL)";
    if (name.length > NAME_MAX) return `keep a name to ${NAME_MAX} characters or fewer`;
    return null;
}

/** Whether `value` fits in a variable. @param {string} value */
const fits = (value) => new TextEncoder().encode(value).length <= VALUE_MAX;

/**
 * The variables a plane record holds, held to what setting them is (a
 * record from a bundle, a gist or a sync was written elsewhere): its
 * string values that fit under good names, the first `MAX_VARIABLES` of
 * them, anything else left out.
 * @param {unknown} record
 * @returns {Variables}
 */
export function variablesOf(record) {
    if (record === null || typeof record !== "object" || Array.isArray(record)) return {};
    const kept = Object.entries(record).filter(([name, value]) => typeof value === "string" && variableNameRefusal(name) === null && fits(value));
    return Object.fromEntries(kept.slice(0, MAX_VARIABLES));
}

/**
 * `current` with `changes` made (a value sets a variable, null removes
 * it), or what is wrong with them, a line each. `taken` names what can't
 * be a variable, each with why (a key's name).
 *
 * @param {Variables} current
 * @param {Record<string, unknown>} changes
 * @param {{ taken?: Record<string, string> }} [opts]
 * @returns {{ next: Variables | null, errors: string[] }}
 */
export function applyVariables(current, changes, { taken = {} } = {}) {
    /** @type {string[]} */
    const errors = [];
    // a map: any name the pattern allows is a variable's, `__proto__` too
    const next = new Map(Object.entries(current));
    for (const [name, value] of Object.entries(changes)) {
        if (value === null) {
            next.delete(name);
            continue;
        }
        const refusal = variableNameRefusal(name);
        if (refusal !== null) {
            errors.push(`${name}: ${refusal}`);
            continue;
        }
        if (Object.hasOwn(taken, name)) {
            errors.push(`${name}: ${taken[name]}; a name is a key or a variable, not both`);
            continue;
        }
        if (typeof value !== "string") {
            errors.push(`${name}: a value is a string (null removes it)`);
            continue;
        }
        if (!fits(value)) {
            errors.push(`${name}: keep a value to ${VALUE_MAX} bytes or fewer; variables are configuration, not data`);
            continue;
        }
        next.set(name, value);
    }
    if (next.size > MAX_VARIABLES) errors.push(`a session has at most ${MAX_VARIABLES} variables`);
    return errors.length > 0 ? { next: null, errors } : { next: Object.fromEntries(next), errors };
}

/** Each open top session's variables, as its world reads them. @type {Map<string, Variables>} */
const live = new Map();

/** The top session of session `name` (a delegate's is the one it was
 *  asked from). @param {string} name */
const topOf = (name) => name.split(".")[0] ?? name;

/**
 * Session `name`'s variables as its world has them now: its top
 * session's, as last read or set.
 * @param {string} name
 * @returns {Variables}
 */
export function liveVariables(name) {
    return live.get(topOf(name)) ?? {};
}

/**
 * Keep top session `name`'s variables for its world (and its
 * delegates').
 * @param {string} name @param {Variables} variables
 */
export function putLiveVariables(name, variables) {
    live.set(name, variables);
}

/** Forget session `name`'s variables. @param {string} name */
export function forgetLiveVariables(name) {
    live.delete(name);
}

/**
 * `variables` without the names `keys` has: a key under a variable's
 * name wins.
 * @param {Variables} variables @param {Record<string, unknown>} keys
 * @returns {Variables}
 */
export function withoutKeys(variables, keys) {
    return Object.fromEntries(Object.entries(variables).filter(([name]) => !Object.hasOwn(keys, name)));
}
