/**
 * `request_secret`, a tool of the studio's: a session's agent asks the
 * person for a key a task needs, by name, for the origins it goes to,
 * and why. The person answers in the chat (`key-requests.svelte.js`);
 * what they pick is granted to the session's agent, and the world reads
 * its secrets live, so the key is there for the next tool call. The tool's
 * result names the secret, never its value.
 *
 * A delegate is refused: nobody is at the picker while it runs. It says
 * in its answer which key it needs, and the session that asked it asks
 * the person.
 */

import { WHY_MAX, checkKeyOrigins, secretNameRefusal } from "./app-needs.js";
import { keyRequests as deviceRequests } from "./key-requests.svelte.js";
import { liveVariables } from "./variables.js";
import { vault as deviceVault } from "./vault.svelte.js";

export const REQUEST_SECRET_DESCRIPTION =
    "Ask the person for a key (an API token) a task needs: `name` (upper-case, like STRIPE_KEY), `origins` (where it goes, each https://host alone), and `why` (one sentence, shown to them). " +
    "They pick one of their saved keys or add one; you get the name only, never the value. " +
    'Use it as $NAME in curl (-H "Authorization: Bearer $NAME") or secret(\'NAME\') in http.fetch\'s headers, at those origins only. ' +
    "The secrets you have already are listed in the terminal's and run_ts's descriptions: use one of those rather than asking. " +
    "Never ask the person to type a key into the chat.";

/**
 * What a delegate is told: it can't ask, so it says what it needs.
 * @param {string} name
 */
const delegateRefusal = (name) =>
    `a delegate can't ask the person for a key: nobody is at the picker while it runs. Finish, and say in your answer that you need ${name || "a key"}, with the origins it goes to and why; the session that asked you can ask the person and delegate again.`;

/**
 * The request's arguments checked, each thing wrong said. `variables`
 * are the session's variables' names, which a key can't have.
 *
 * @param {Record<string, unknown>} args
 * @param {{ variables?: string[] }} [opts]
 * @returns {{ want: { name: string, origins: string[], why: string } | null, errors: string[] }}
 */
export function checkRequest(args, { variables = [] } = {}) {
    /** @type {string[]} */
    const errors = [];
    const nameWhy = secretNameRefusal(args.name);
    if (nameWhy !== null) errors.push(`name: ${nameWhy}`);
    else if (variables.includes(/** @type {string} */ (args.name))) {
        errors.push(`name: ${args.name} is one of this session's variables (public configuration); a name is a key or a variable, not both, so pick another`);
    }
    const list = Array.isArray(args.origins) ? args.origins : typeof args.origins === "string" ? [args.origins] : [];
    const origins = checkKeyOrigins(list);
    errors.push(...origins.errors);
    if (origins.errors.length === 0 && origins.origins.length === 0) errors.push(`origins: name where the key goes, like ["https://api.stripe.com"]`);
    const why = typeof args.why === "string" ? args.why.trim() : "";
    if (why === "") errors.push("why: say in a sentence what the key is for; the person reads it");
    else if (why.length > WHY_MAX) errors.push(`why: keep it to ${WHY_MAX} characters or fewer`);
    if (errors.length > 0) return { want: null, errors };
    return { want: { name: /** @type {string} */ (args.name), origins: origins.origins, why }, errors };
}

/**
 * How to use secret `name`, for the tool's result.
 * @param {string} name @param {string[]} origins
 */
const usage = (name, origins) =>
    `Use it as $${name} in curl (-H "Authorization: Bearer $${name}") or secret('${name}') in http.fetch's headers, with ${origins.join(", ")} only. Its value never reaches you: a response that echoes it shows ${"${"}${name}}.`;

/**
 * The tool, for session `session` (a delegate's refuses).
 *
 * @param {{ name: string, delegate?: boolean }} session
 * @param {{ vault?: import("./vault.svelte.js").Vault, requests?: import("./key-requests.svelte.js").KeyRequests, variables?: (name: string) => import("./variables.js").Variables }} [deps]
 */
export function requestSecretTool(session, { vault = deviceVault, requests = deviceRequests, variables = liveVariables } = {}) {
    return {
        name: "request_secret",
        description: REQUEST_SECRET_DESCRIPTION,
        parameters: {
            type: "object",
            properties: {
                name: { type: "string" },
                origins: { type: "array", items: { type: "string" } },
                why: { type: "string" },
            },
            required: ["name", "origins", "why"],
        },
        /**
         * @param {Record<string, unknown>} args
         * @param {{ signal?: AbortSignal }} [opts]
         * @returns {Promise<import("@agex-ts/world").ToolOutput>}
         */
        async call(args, opts = {}) {
            if (session.delegate) return { text: delegateRefusal(typeof args.name === "string" ? args.name : ""), images: [], isError: true };
            const { want, errors } = checkRequest(args, { variables: Object.keys(variables(session.name)) });
            if (want === null) return { text: errors.join("\n"), images: [], isError: true };
            const have = vault.agentSecrets(session.name)[want.name];
            if (have !== undefined && want.origins.every((o) => have.origins.includes(o))) {
                return { text: `You have ${want.name} already. ${usage(want.name, want.origins)}`, images: [], isError: false };
            }
            /** @type {boolean} */
            let yes;
            try {
                yes = await requests.ask(session.name, want, opts.signal);
            } catch (e) {
                if (opts.signal?.aborted) return { text: "the turn ended before the person answered", images: [], isError: true };
                return { text: e instanceof Error ? e.message : String(e), images: [], isError: true };
            }
            if (!yes) {
                return {
                    text: `The person chose not to give ${want.name} now. Go on without it if you can, or say what it is for; never ask them to type a key into the chat.`,
                    images: [],
                    isError: false,
                };
            }
            return { text: `The person granted ${want.name}. ${usage(want.name, want.origins)}`, images: [], isError: false };
        },
    };
}
