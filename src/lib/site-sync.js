/**
 * The site grants, given to the browser extension: each session's
 * agent's sites (`vault.agentSites`) and its title (the session's tab
 * group's), sent with `session` whenever the vault changes or the titles
 * may have (`sync`), and again each time the port opens. A session whose
 * sites were taken back is sent none, so its open tabs are held to
 * nothing at once. The extension keeps what it was told while the studio
 * is away, so on each opening the studio asks it which sessions it knows
 * (`sessions`), and sends none to those whose sites went meanwhile.
 *
 * A session given a tab the person shared may hold no sites, and the
 * extension takes a tab only for a session it knows: `tell` tells it of
 * that one first.
 */

/**
 * Keep the extension told: `sync` tells it what changed, `stop` stops.
 *
 * @param {{
 *   vault: import("./vault.svelte.js").Vault,
 *   extension: import("./browser-extension.svelte.js").BrowserExtension,
 *   titleOf: (session: string) => string,
 * }} deps
 */
export function watchSites({ vault, extension, titleOf }) {
    /** What the extension was last told of each session, this page. @type {Map<string, string>} */
    const told = new Map();

    /** @returns {Record<string, string[]>} */
    const sitesNow = () => Object.fromEntries(Object.entries(vault.agentSites).map(([key, domains]) => [key.slice("agent:".length), [...domains]]));

    /** @param {string} session @param {string[]} domains */
    const say = (session, domains) => {
        const name = titleOf(session);
        const said = JSON.stringify([name, domains]);
        if (told.get(session) === said) return Promise.resolve();
        told.set(session, said);
        return extension.call("session", { session, name, domains }).catch((/** @type {unknown} */ e) => {
            // told again the next time the port opens
            if (told.get(session) === said) told.set(session, "");
            throw e;
        });
    };

    const sync = () => {
        if (extension.status !== "found") return; // told on the port's opening
        const sites = sitesNow();
        for (const session of new Set([...Object.keys(sites), ...told.keys()])) void say(session, sites[session] ?? []).catch(() => {});
    };

    const stopVault = vault.onChange(sync);
    const stopOpen = extension.onOpen(() => {
        for (const session of told.keys()) told.set(session, "");
        void extension
            .call("sessions")
            .then((/** @type {{ session: string }[]} */ known) => {
                // a session the extension knows that the studio doesn't tell of is told none
                for (const { session } of known) if (!told.has(session)) told.set(session, "");
            })
            .catch(() => {})
            .finally(sync);
    });
    sync();
    return {
        sync,
        /** The extension told of `session` (its title and sites), if it
         *  wasn't: before it's given a tab the person shared.
         *  @param {string} session */
        tell: (session) => say(session, sitesNow()[session] ?? []),
        stop() {
            stopVault();
            stopOpen();
        },
    };
}
