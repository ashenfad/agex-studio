/**
 * `set_variables`, a tool of the studio's: a session's agent sets its
 * variables (`variables.js`), configuration anyone may read, without
 * asking: they are public, as a file it writes is. The change is on the
 * session's plane, so rewinding the turn undoes it, and the world reads
 * them live, so the next tool call has them.
 *
 * A delegate is refused: the variables are its top session's. It says in
 * its answer which to set, and that session's agent sets them.
 */

export const SET_VARIABLES_DESCRIPTION =
    "Set the session's variables: configuration anyone may read, like a service's base URL or a public key (never a secret: those are keys, from request_secret). " +
    '`variables` maps each NAME to its value, or to null to remove it: {"API_URL": "https://api.example.com"}. ' +
    "The app's page has them as window.env (the preview rebuilds), your code as env.NAME, the shell as $NAME, from your next tool call. " +
    "They travel with the session when it is shared or published.";

/**
 * What a delegate is told: the variables are its session's.
 * @param {string[]} names
 */
const delegateRefusal = (names) =>
    `a delegate can't set variables: they are the session's that asked you. Finish, and say in your answer which to set${names.length > 0 ? ` (${names.join(", ")})` : ""} and to what; that session can set them.`;

/** What was done, a clause each. @param {Record<string, unknown>} changes */
function done(changes) {
    const set = Object.keys(changes).filter((n) => changes[n] !== null);
    const removed = Object.keys(changes).filter((n) => changes[n] === null);
    return [set.length > 0 ? `Set ${set.join(", ")}` : null, removed.length > 0 ? `removed ${removed.join(", ")}` : null].filter((x) => x !== null).join("; ");
}

/**
 * The tool, for session `session` (a delegate's refuses).
 *
 * @param {{ name: string, delegate?: boolean, setVariables?: (changes: Record<string, unknown>) => Promise<string[]> }} session
 */
export function setVariablesTool(session) {
    return {
        name: "set_variables",
        description: SET_VARIABLES_DESCRIPTION,
        parameters: {
            type: "object",
            properties: {
                variables: { type: "object" },
            },
            required: ["variables"],
        },
        /**
         * @param {Record<string, unknown>} args
         * @returns {Promise<import("@agex-ts/world").ToolOutput>}
         */
        async call(args) {
            const changes = args.variables;
            if (changes === null || typeof changes !== "object" || Array.isArray(changes)) {
                return { text: 'variables: an object of NAME to value (null removes), like {"API_URL": "https://api.example.com"}', images: [], isError: true };
            }
            const given = /** @type {Record<string, unknown>} */ (changes);
            if (session.delegate || session.setVariables === undefined) return { text: delegateRefusal(Object.keys(given)), images: [], isError: true };
            if (Object.keys(given).length === 0) return { text: "variables: name at least one to set or remove", images: [], isError: true };
            const errors = await session.setVariables(given);
            if (errors.length > 0) return { text: `Nothing was changed:\n${errors.join("\n")}`, images: [], isError: true };
            return { text: `${done(given)}. The app's page has them as window.env, your code as env.NAME, the shell as $NAME.`, images: [], isError: false };
        },
    };
}
