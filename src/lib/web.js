/**
 * `web`, a host object: web search and page reading, through OpenRouter.
 *
 * Search runs on Perplexity's Sonar models. Reading a page runs a small
 * model with OpenRouter's `web_fetch` server tool, whose extraction
 * engine turns the page into clean text, and the model answers a
 * question from it. The page's text itself never comes back: OpenRouter
 * hands fetched content only to a model, and a model asked to relay a
 * page verbatim silently abridges it, so `fetch` is a question rather
 * than a download.
 *
 * It is the agent's, not an app's: an app's code runs in the preview,
 * which has no host objects.
 */

import { typedHost } from "@agex-ts/world";
import { z } from "zod";
import { routerJson } from "./openrouter-api.js";

export const SEARCH_MODEL = "perplexity/sonar";
export const DEEP_SEARCH_MODEL = "perplexity/sonar-pro-search";
export const FETCH_MODEL = "google/gemini-3.5-flash-lite";
/** Parallel extracts a page's main content, without its navigation and
 *  other furniture, and read a page's current version where the others
 *  served an older copy. */
const FETCH_ENGINE = "parallel";
/** How much of a page the reading model is shown, in tokens: a longer
 *  page is cut, not summarized. */
const FETCH_MAX_CONTENT_TOKENS = 25_000;

// A quick search takes 3-5s, a deep one 20-40s, a page read 4-10s.
const SEARCH_TIMEOUT = 60;
const DEEP_SEARCH_TIMEOUT = 150;
const FETCH_TIMEOUT = 90;

const SEARCH_PROMPT = "Answer the question using web search. Be specific and cite sources.";
const FETCH_PROMPT =
    "Read the page at the URL with the web_fetch tool, then answer the question from that page alone. " +
    "Quote exact names, figures, code and wording where they matter. If the page could not be fetched, " +
    "or does not answer the question, say so plainly instead of answering from memory.";

/** Search the web and read pages. Every method returns plain text. */
export class Web {
    /** @param {{ fetchImpl?: typeof fetch }} [opts] */
    constructor({ fetchImpl } = {}) {
        this._fetch = fetchImpl;
    }

    /**
     * Answer `query` from a web search: the answer, then its numbered
     * sources. `deep` runs a multi-step search, slower and pricier, for
     * questions that need synthesis.
     *
     * @param {string} query
     * @param {{ deep?: boolean }} [options]
     */
    async search(query, options = {}) {
        if (query.trim() === "") throw new Error("web.search: the query is empty");
        const deep = options.deep === true;
        const data = await routerJson({
            label: "web.search",
            path: "/chat/completions",
            body: {
                model: deep ? DEEP_SEARCH_MODEL : SEARCH_MODEL,
                messages: [
                    { role: "system", content: SEARCH_PROMPT },
                    { role: "user", content: query },
                ],
            },
            timeout: deep ? DEEP_SEARCH_TIMEOUT : SEARCH_TIMEOUT,
            fetchImpl: this._fetch,
        });
        const answer = content("web.search", data);
        const sources = sourcesOf(data);
        return sources ? `${answer}\n\nSources:\n${sources}` : answer;
    }

    /**
     * Read the page at `url` and answer `question` from it: an extract,
     * not the page's text.
     *
     * @param {string} url
     * @param {string} question
     */
    async fetch(url, question) {
        url = url.trim();
        if (!/^https?:\/\//i.test(url)) throw new Error(`web.fetch: not an http(s) URL: ${JSON.stringify(url)}`);
        if (question.trim() === "") throw new Error("web.fetch: say what to find on the page");
        const data = await routerJson({
            label: "web.fetch",
            path: "/chat/completions",
            body: {
                model: FETCH_MODEL,
                messages: [
                    { role: "system", content: FETCH_PROMPT },
                    { role: "user", content: `URL: ${url}\nQuestion: ${question.trim()}` },
                ],
                tools: [
                    {
                        type: "openrouter:web_fetch",
                        parameters: { engine: FETCH_ENGINE, max_uses: 1, max_content_tokens: FETCH_MAX_CONTENT_TOKENS },
                    },
                ],
                // the model may not skip the read and answer from memory
                tool_choice: "required",
            },
            timeout: FETCH_TIMEOUT,
            fetchImpl: this._fetch,
        });
        // the answer is credited to the page, so the page must have been
        // read: OpenRouter counts the server tool calls it ran
        if (!data?.usage?.server_tool_use_details?.tool_calls_executed) {
            throw new Error(`web.fetch: the page was not read, so there is no answer from it: ${url}`);
        }
        return `${content("web.fetch", data)}\n\nSource: ${url}`;
    }
}

/** @param {string} label @param {any} data */
function content(label, data) {
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string" || text.trim() === "") throw new Error(`${label}: the answer was empty`);
    return text.trim();
}

/** The numbered source list for an answer's `[n]` markers, which count
 *  through the response's url citations from 1.
 *  @param {any} data */
function sourcesOf(data) {
    /** @type {string[]} */
    const lines = [];
    const notes = data?.choices?.[0]?.message?.annotations ?? [];
    notes.forEach((/** @type {any} */ note, /** @type {number} */ i) => {
        const cite = note?.url_citation;
        if (typeof cite?.url !== "string" || cite.url === "") return;
        const title = typeof cite.title === "string" ? cite.title.trim() : "";
        lines.push(title ? `[${i + 1}] ${title} — ${cite.url}` : `[${i + 1}] ${cite.url}`);
    });
    return lines.join("\n");
}

/** `web` as the profile grants it, its arguments checked.
 *  @param {{ fetchImpl?: typeof fetch }} [opts] */
export function webHost(opts) {
    return typedHost(new Web(opts), {
        search: {
            args: { query: z.string(), options: z.strictObject({ deep: z.boolean().optional() }).optional() },
            returns: z.string(),
        },
        fetch: { args: { url: z.string(), question: z.string() }, returns: z.string() },
    });
}
