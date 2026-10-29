/**
 * `request_sites`, a tool of the studio's, offered while its browser
 * extension is here: a session's agent asks the person to let it open
 * sites in its browser tabs, by domain (each with its subdomains), and
 * why. The person answers in the chat (`site-requests.svelte.js`); what
 * they allow is granted to the session's agent, and the extension holds
 * every page load in the session's tabs to it.
 *
 * Ask early, in one request: every site a task means to search, before it
 * fans out, so what reaches the person mid-task is only what couldn't be
 * planned. A delegate is refused, as with keys: it says what it needs in
 * its answer, and the session that asked it asks the person.
 */

import { WHY_MAX } from "./app-needs.js";
import { SITES_MAX, checkDomains, covered } from "./site-grants.js";
import { siteRequests as deviceRequests } from "./site-requests.svelte.js";
import { vault as deviceVault } from "./vault.svelte.js";

export const REQUEST_SITES_DESCRIPTION =
    `Ask the person to let you open sites in browser tabs: \`domains\` (like "marriott.com"; each covers its subdomains, so www. and book. come with it; up to ${SITES_MAX}) and \`why\` (one sentence, shown to them, like "to compare hotels in Lisbon for December 3 to 6"). ` +
    "Ask once, for every site the task needs, before you start: the person answers one card for all of them, and may allow some and not others. " +
    "A page that goes on to a domain you weren't allowed is stopped before it loads; ask for that domain, saying why.";

/**
 * What a delegate is told: it can't ask, so it says what it needs.
 * @param {string[]} domains
 */
const delegateRefusal = (domains) =>
    `a delegate can't ask the person for sites: nobody is at the card while it runs. Finish, and say in your answer that you need ${domains.length > 0 ? domains.join(", ") : "sites"} opened and why; the session that asked you can ask the person and delegate again.`;

/**
 * The request's arguments checked, each thing wrong said.
 *
 * @param {Record<string, unknown>} args
 * @returns {{ want: { domains: string[], why: string } | null, errors: string[] }}
 */
export function checkRequest(args) {
    const { domains, errors } = checkDomains(args.domains);
    if (errors.length === 0 && domains.length === 0) errors.push(`domains: name the sites, like ["marriott.com", "hyatt.com"]`);
    const why = typeof args.why === "string" ? args.why.trim() : "";
    if (why === "") errors.push("why: say in a sentence what the sites are for; the person reads it");
    else if (why.length > WHY_MAX) errors.push(`why: keep it to ${WHY_MAX} characters or fewer`);
    if (errors.length > 0) return { want: null, errors };
    return { want: { domains, why }, errors };
}

/**
 * The tool, for session `session` (a delegate's refuses).
 *
 * @param {{ name: string, delegate?: boolean }} session
 * @param {{ vault?: import("./vault.svelte.js").Vault, requests?: import("./site-requests.svelte.js").SiteRequests }} [deps]
 */
export function requestSitesTool(session, { vault = deviceVault, requests = deviceRequests } = {}) {
    return {
        name: "request_sites",
        description: REQUEST_SITES_DESCRIPTION,
        parameters: {
            type: "object",
            properties: {
                domains: { type: "array", items: { type: "string" } },
                why: { type: "string" },
            },
            required: ["domains", "why"],
        },
        /**
         * @param {Record<string, unknown>} args
         * @param {{ signal?: AbortSignal }} [opts]
         * @returns {Promise<import("@agex-ts/world").ToolOutput>}
         */
        async call(args, opts = {}) {
            if (session.delegate) return { text: delegateRefusal(checkDomains(args.domains).domains), images: [], isError: true };
            const { want, errors } = checkRequest(args);
            if (want === null) return { text: errors.join("\n"), images: [], isError: true };
            const have = vault.sitesOf(session.name);
            const asked = want.domains.filter((d) => !covered(have, d));
            if (asked.length === 0) return { text: `You may open ${want.domains.join(", ")} already (each with its subdomains).`, images: [], isError: false };
            /** @type {boolean} */
            let yes;
            try {
                yes = await requests.ask(session.name, { domains: asked, why: want.why }, opts.signal);
            } catch (e) {
                if (opts.signal?.aborted) return { text: "the turn ended before the person answered", images: [], isError: true };
                return { text: e instanceof Error ? e.message : String(e), images: [], isError: true };
            }
            const now = vault.sitesOf(session.name);
            const allowed = want.domains.filter((d) => covered(now, d));
            const refused = want.domains.filter((d) => !covered(now, d));
            if (!yes || allowed.length === 0) {
                return { text: `The person chose not to allow ${refused.join(", ")} now. Go on without them if you can, or say what they're for.`, images: [], isError: false };
            }
            const rest = refused.length > 0 ? ` Not ${refused.join(", ")}: leave those out, or say why you need them.` : "";
            return { text: `The person allowed ${allowed.join(", ")} (each with its subdomains) for this session.${rest}`, images: [], isError: false };
        },
    };
}
