/**
 * Stand-ins for the services an app calls, in a `test_app` test: canned
 * responses by method, origin and path, so a test needs no key and
 * touches no real backend.
 *
 * A request with a secret (`agex.fetch` naming `${NAME}`) is checked by
 * the studio as it would be for real, then answered by its stand-in and
 * never sent; one no stand-in matches is refused, so a test never sends
 * a key anywhere. A request without one is answered in the test's page,
 * in place of the network (`standInsScript`); one no stand-in matches
 * goes out as it would.
 */

/** The most stand-ins a test takes. */
export const STAND_INS_MAX = 50;

/** Statuses a stand-in may answer with, as a `Response` takes them. */
const MIN_STATUS = 200;
const MAX_STATUS = 599;
const NULL_BODY = [204, 205, 304];
const KEYS = ["url", "method", "status", "headers", "body", "json"];

/**
 * A stand-in, as a test's page and the studio use it: `url` its origin
 * and path, `method` upper-cased (null: any), `body` the text (null:
 * none).
 *
 * @typedef {{ url: string, method: string | null, status: number, headers: Record<string, string>, body: string | null }} StandIn
 */

/** @param {unknown} value */
const describe = (value) => (Array.isArray(value) ? "a list" : value === null ? "null" : typeof value);

/**
 * Check a test's `standIns`, as the agent gives them: a list of
 * `{ url, method?, status?, headers?, body? | json? }`, `url` an
 * `https:` or `http:` origin and path with no query.
 *
 * @param {unknown} list
 * @returns {{ standIns: StandIn[], errors: string[] }}
 */
export function parseStandIns(list) {
    /** @type {StandIn[]} */
    const standIns = [];
    /** @type {string[]} */
    const errors = [];
    if (list === undefined || list === null) return { standIns, errors };
    if (!Array.isArray(list)) return { standIns, errors: [`standIns: must be a list of stand-ins; got ${describe(list)}`] };
    if (list.length > STAND_INS_MAX) return { standIns, errors: [`standIns: at most ${STAND_INS_MAX}; got ${list.length}`] };
    list.forEach((entry, i) => {
        const at = `standIns[${i}]`;
        const fail = (/** @type {string} */ where, /** @type {string} */ message) => errors.push(`${at}${where}: ${message}`);
        if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
            fail("", `must be an object like {"url": "https://api.example.com/v1/items", "json": [...]}; got ${describe(entry)}`);
            return;
        }
        const before = errors.length;
        for (const key of Object.keys(entry)) {
            if (!KEYS.includes(key)) fail("", `unknown key "${key}" (expected ${KEYS.map((k) => `"${k}"`).join(", ")})`);
        }
        /** @type {URL | null} */
        let url = null;
        if (typeof entry.url !== "string") {
            fail(".url", `must be a URL like "https://api.example.com/v1/items"; got ${describe(entry.url)}`);
        } else {
            try {
                url = new URL(entry.url);
            } catch {
                fail(".url", `${JSON.stringify(entry.url)} isn't an absolute URL`);
            }
            if (url !== null && url.protocol !== "https:" && url.protocol !== "http:") {
                fail(".url", `${JSON.stringify(entry.url)} isn't https: or http:`);
            } else if (url !== null && (url.search !== "" || url.hash !== "")) {
                fail(".url", `${JSON.stringify(entry.url)} has a query or fragment; give the origin and path, which any query matches`);
            }
        }
        if (entry.method !== undefined && (typeof entry.method !== "string" || !/^[A-Za-z]+$/.test(entry.method))) {
            fail(".method", `must be a method like "GET"; got ${JSON.stringify(entry.method)}`);
        }
        const status = entry.status ?? 200;
        if (!Number.isInteger(status) || status < MIN_STATUS || status > MAX_STATUS) {
            fail(".status", `must be a status from ${MIN_STATUS} to ${MAX_STATUS}; got ${JSON.stringify(entry.status)}`);
        }
        const headers = entry.headers ?? {};
        if (typeof headers !== "object" || headers === null || Array.isArray(headers) || !Object.values(headers).every((v) => typeof v === "string")) {
            fail(".headers", `must be an object of header names to strings; got ${describe(entry.headers)}`);
        } else {
            // as a Response will take them, so a stand-in that matches can answer
            for (const [name, value] of Object.entries(headers)) {
                try {
                    new Headers([[name, value]]);
                } catch {
                    fail(".headers", `${JSON.stringify(name)}: ${JSON.stringify(value)} isn't a header a response can carry (a name is letters, digits and -, a value one line)`);
                }
            }
        }
        if (entry.body !== undefined && entry.json !== undefined) fail("", "give body or json, not both");
        if (entry.body !== undefined && typeof entry.body !== "string") {
            fail(".body", `must be a string (json takes any value); got ${describe(entry.body)}`);
        }
        if (errors.length > before || url === null) return;
        /** @type {Record<string, string>} */
        const out = { ...headers };
        let body = entry.body ?? null;
        if (entry.json !== undefined) {
            body = JSON.stringify(entry.json);
            if (!Object.keys(out).some((h) => h.toLowerCase() === "content-type")) out["content-type"] = "application/json";
        }
        standIns.push({
            url: url.origin + url.pathname,
            method: entry.method === undefined ? null : entry.method.toUpperCase(),
            status,
            headers: out,
            body: NULL_BODY.includes(status) ? null : body,
        });
    });
    return { standIns, errors };
}

/**
 * The stand-in that answers `method` to `url` (its origin and path; any
 * query), or null: the first that names the method, else the first that
 * names none.
 *
 * @param {StandIn[]} standIns @param {string} method @param {string | URL} url
 * @returns {StandIn | null}
 */
export function matchStandIn(standIns, method, url) {
    let at;
    try {
        const u = new URL(url);
        at = u.origin + u.pathname;
    } catch {
        return null;
    }
    const m = method.toUpperCase();
    const here = standIns.filter((s) => s.url === at);
    return here.find((s) => s.method === m) ?? here.find((s) => s.method === null) ?? null;
}

/** A stand-in's response to `method`: to HEAD, without a body.
 *  @param {StandIn} s @param {string} method */
const respond = (s, method) => new Response(method.toUpperCase() === "HEAD" ? null : s.body, { status: s.status, headers: s.headers });

/**
 * Answer a test's request with a secret (`agex-fetch`) from its
 * stand-ins: checked by `answer` as for real, with a stand-in's key in
 * place of the viewer's, and never sent. One no stand-in matches is
 * refused. A reply that went through says so in `note`, which the page
 * shows in its console output.
 *
 * @param {StandIn[]} standIns
 * @param {Record<string, unknown>} data the page's `agex-fetch` message
 * @param {(ctx: { grantFor: (need: import("./app-needs.js").SecretNeed) => Promise<string>, fetch: typeof globalThis.fetch }) => Promise<Record<string, unknown>>} answer
 *   `answerFetch` over this request, given the stand-ins' grants and fetch
 * @returns {Promise<Record<string, unknown>>}
 */
export async function answerFromStandIns(standIns, data, answer) {
    /** @type {string | null} */
    let missed = null;
    const reply = await answer({
        // a key no service sees: the request goes no further than a stand-in
        grantFor: async (need) => `stand-in-key-for-${need.name}`,
        fetch: async (input, init) => {
            const method = init?.method ?? "GET";
            const s = matchStandIn(standIns, method, String(input));
            if (s !== null) return respond(s, method);
            const u = new URL(String(input));
            missed = `${method.toUpperCase()} ${u.origin}${u.pathname}`;
            return new Response(null, { status: 404 });
        },
    });
    const url = typeof data.url === "string" ? data.url : "";
    const method = (typeof data.method === "string" ? data.method : "GET").toUpperCase();
    if (missed !== null) {
        const error = `agex.fetch: no stand-in answers ${missed}; in a test with standIns, every request with a secret needs one, and none is sent`;
        return { type: "agex-fetch-result", id: data.id, error, note: `[stand-in] ${method} ${url}: none matches, refused` };
    }
    if (reply.error) return { ...reply, note: `[stand-in] ${method} ${url}: refused: ${reply.error}` };
    const keyed = (Array.isArray(data.headers) ? data.headers : [])
        .filter((h) => Array.isArray(h) && typeof h[1] === "string" && h[1].includes("${"))
        .map(([name, value]) => `${String(name).toLowerCase()}: ${value}`);
    return { ...reply, note: `[stand-in] ${method} ${url} (${keyed.join(", ")}) → ${reply.status}` };
}

/**
 * The code that answers a test's own requests from its stand-ins, in a
 * page or a worker (`self`): `fetch` to a stand-in resolves with its
 * response (its `url` the request's), said in the page's console output
 * (a worker has none), or rejects as fetch does when the request is
 * one fetch refuses or its signal is aborted first; any other goes on
 * to the `fetch` it wraps.
 *
 * @param {StandIn[]} standIns
 * @returns {string}
 */
function patchSource(standIns) {
    const json = JSON.stringify(standIns).replace(/</g, "\\u003c");
    return `(function() {
    var S = ${json};
    var real = self.fetch;
    self.fetch = function(input, init) {
        var isRequest = typeof Request !== 'undefined' && input instanceof Request;
        var method = String((init && init.method) || (isRequest ? input.method : 'GET')).toUpperCase();
        var at = null;
        try {
            var u = new URL(isRequest ? input.url : String(input), location.href);
            at = u.origin + u.pathname;
        } catch (e) { /* not a URL: the real fetch says so */ }
        // the first that names the method, else the first that names none
        var s = null;
        for (var i = 0; i < S.length; i++) {
            if (S[i].url !== at) continue;
            if (S[i].method === method) { s = S[i]; break; }
            if (S[i].method === null && s === null) s = S[i];
        }
        if (s !== null) {
            var signal = (init && init.signal) || (isRequest ? input.signal : null);
            return new Promise(function(resolve, reject) {
                // a request fetch would refuse (a GET with a body, a forbidden
                // method) is refused here too; built only once it matched, as
                // building it uses a Request's body up
                try { new Request(input, init); } catch (e) { return reject(e); }
                function stopped() {
                    reject(signal.reason !== undefined ? signal.reason : new DOMException('The operation was aborted.', 'AbortError'));
                }
                if (signal && signal.aborted) return stopped();
                if (signal) signal.addEventListener('abort', stopped, { once: true });
                // answered a moment later, as the network would be: a signal aborted meanwhile wins
                setTimeout(function() {
                    if (signal) signal.removeEventListener('abort', stopped);
                    if (signal && signal.aborted) return;
                    if (self.__agex_logs) self.__agex_logs.push({ level: 'info', message: '[stand-in] ' + method + ' ' + u.href + ' → ' + s.status });
                    // a response to HEAD has no body
                    var res = new Response(method === 'HEAD' ? null : s.body, { status: s.status, headers: s.headers });
                    Object.defineProperty(res, 'url', { value: u.href });
                    resolve(res);
                }, 0);
            });
        }
        return real.apply(this, arguments);
    };
})();`;
}

/**
 * Classic <script> for a test's page with stand-ins: its own requests
 * (`fetch`, and so `agex.fetch` without a secret) to a stand-in are
 * answered by it, each said in the console output. Runs after the
 * assets script, whose `fetch` it wraps.
 *
 * @param {StandIn[]} standIns
 * @returns {string}
 */
export function standInsScript(standIns) {
    if (standIns.length === 0) return "";
    return `
<script>
// test_app's stand-ins
${patchSource(standIns)}
<\/script>`;
}

/**
 * A test's worker sources (`app/*.worker.js`, bundled), each answering
 * its own requests from the stand-ins as the page does.
 *
 * @param {Record<string, string>} sources @param {StandIn[]} standIns
 * @returns {Record<string, string>}
 */
export function standInsWorkerSources(sources, standIns) {
    if (standIns.length === 0) return sources;
    const patch = `// test_app's stand-ins\n${patchSource(standIns)}\n`;
    return Object.fromEntries(Object.entries(sources).map(([name, src]) => [name, patch + src]));
}
