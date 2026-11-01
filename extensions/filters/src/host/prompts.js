/**
 * What the agent is told when its turn starts: the person submitted a
 * page of the site, saved as one of the site's pages.
 */

/**
 * The prompt for a turn after a submission.
 *
 * @param {{ site: string, page: string, url: string, title: string, shot: boolean }} submitted
 *   `page`: the saved page's path without its extension (`pages/3`).
 */
export function submittedPrompt({ site, page, url, title, shot }) {
    return [
        `The person submitted a page of ${site} for filtering: ${JSON.stringify(title)} (${url}).`,
        `It's saved as ${page}.json (the page as they saw it: its HTML, every element's box, what doesn't show marked)${shot ? `, with a screenshot of what was in view at ${page}.jpg` : ""}.`,
        "Find what on it is clutter or advertising and write the site's filter so it hides that, on this page and the site's other saved pages, then present it. The site-filters skill says how.",
    ].join("\n");
}
