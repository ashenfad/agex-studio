import { describe, expect, it } from "vitest";
import { answerFetch, cancelFetch, cancelFetches, relayFetch } from "./app-fetch.js";

const KEY = "sk_test_fake_0123456789";

/** An app that declares one secret, for Stripe's API. @type {import("./app-needs.js").AppNeeds} */
const needs = {
    model: false,
    secrets: [
        { name: "STRIPE_KEY", origins: ["https://api.stripe.com"], header: "Authorization", why: "to look up prices" },
        { name: "MAPS_KEY", origins: ["https://maps.example.com"], header: "X-Api-Key", why: "to draw maps" },
    ],
};

/** The viewer's grants: STRIPE_KEY's, and none for MAPS_KEY. */
const grantFor = (/** @type {import("./app-needs.js").SecretNeed} */ need) => Promise.resolve(need.name === "STRIPE_KEY" ? KEY : null);

/** A fetch that records what it was asked, and answers with `respond`. */
function fakeFetch(respond = () => new Response("ok", { status: 200, headers: { "content-type": "text/plain" } })) {
    /** @type {{ url: string, init: RequestInit }[]} */
    const calls = [];
    /** @type {typeof globalThis.fetch} */
    const fetch = async (input, init = {}) => {
        calls.push({ url: String(input), init });
        return respond(String(input), init);
    };
    return { fetch, calls };
}

/** A request as the page posts it. @param {Record<string, unknown>} over */
const req = (over = {}) => ({
    type: "agex-fetch",
    id: "r1",
    url: "https://api.stripe.com/v1/prices",
    method: "GET",
    headers: [["authorization", "Bearer ${STRIPE_KEY}"]],
    body: null,
    ...over,
});

/** @param {Record<string, unknown>} data @param {Partial<import("./app-fetch.js").FetchContext>} [ctx] */
async function answer(data, ctx = {}) {
    const fake = fakeFetch();
    const reply = await answerFetch(data, { needs, grantFor, fetch: fake.fetch, ...ctx });
    return { reply, calls: fake.calls };
}

describe("agex.fetch, in the studio", () => {
    it("fills the key into the declared header only, and sends no credentials and follows no redirect", async () => {
        const fake = fakeFetch();
        const reply = await answerFetch(
            req({ headers: [["Authorization", "Bearer ${STRIPE_KEY}"], ["x-note", "$HOME stays"], ["content-type", "text/plain"]], method: "POST", body: "price=1" }),
            { needs, grantFor, fetch: fake.fetch },
        );
        expect(reply.error).toBeNull();
        expect(fake.calls).toHaveLength(1);
        const { url, init } = /** @type {{ url: string, init: RequestInit }} */ (fake.calls[0]);
        expect(url).toBe("https://api.stripe.com/v1/prices");
        const headers = new Headers(init.headers);
        expect(headers.get("authorization")).toBe(`Bearer ${KEY}`);
        expect(headers.get("x-note")).toBe("$HOME stays");
        expect(init.credentials).toBe("omit");
        expect(init.redirect).toBe("manual");
        expect(init.method).toBe("POST");
        expect(init.body).toBe("price=1");
    });

    it("sends the response back: its status, headers and bytes", async () => {
        const fake = fakeFetch(() => new Response(new Uint8Array([1, 2, 255]), { status: 201, statusText: "Created", headers: { "x-id": "p_1" } }));
        const reply = await answerFetch(req(), { needs, grantFor, fetch: fake.fetch });
        expect(reply).toMatchObject({ type: "agex-fetch-result", id: "r1", status: 201, statusText: "Created", url: "https://api.stripe.com/v1/prices", error: null });
        expect(reply.headers).toContainEqual(["x-id", "p_1"]);
        expect(reply.body).toEqual(new Uint8Array([1, 2, 255]));
    });

    it("scrubs a key the response echoes, in its body and headers", async () => {
        const fake = fakeFetch((_, init) => {
            const auth = new Headers(init.headers).get("authorization");
            return new Response(JSON.stringify({ headers: { Authorization: auth } }), { headers: { "x-echo": String(auth) } });
        });
        const reply = await answerFetch(req(), { needs, grantFor, fetch: fake.fetch });
        const text = new TextDecoder().decode(/** @type {Uint8Array} */ (reply.body));
        expect(JSON.parse(text)).toEqual({ headers: { Authorization: "Bearer ${STRIPE_KEY}" } });
        expect(text).not.toContain(KEY);
        expect(reply.headers).toContainEqual(["x-echo", "Bearer ${STRIPE_KEY}"]);
    });

    it("refuses a reference in the URL, its query, or the body, sending nothing", async () => {
        const cases = [
            [{ url: "https://api.stripe.com/v1/${STRIPE_KEY}/prices" }, "agex.fetch: ${STRIPE_KEY} is in the URL; a secret goes in one request header only (the one app/agex.json declares for it), never a URL, query or body"],
            [{ url: "https://api.stripe.com/v1/prices?key=${STRIPE_KEY}" }, "agex.fetch: ${STRIPE_KEY} is in the query; a secret goes in one request header only (the one app/agex.json declares for it), never a URL, query or body"],
            // the forms the world would fill too: bare, and percent-encoded
            [{ url: "https://api.stripe.com/v1/prices?key=$STRIPE_KEY" }, "is in the query"],
            [{ url: "https://api.stripe.com/v1/%24%7BSTRIPE_KEY%7D" }, "is in the URL"],
            [{ url: "https://api.stripe.com/v1/$\tSTRIPE_KEY" }, "is in the URL"],
            [{ method: "POST", body: '{"key":"${STRIPE_KEY}"}' }, "agex.fetch: ${STRIPE_KEY} is in the body; a secret goes in one request header only (the one app/agex.json declares for it), never a URL, query or body"],
            [{ method: "POST", body: new TextEncoder().encode("key=%24%7BSTRIPE_KEY%7D") }, "is in the body"],
        ];
        for (const [over, message] of cases) {
            const { reply, calls } = await answer(req(/** @type {Record<string, unknown>} */ (over)));
            expect(reply.error).toContain(message);
            expect(calls).toEqual([]);
        }
    });

    it("refuses a reference in another header", async () => {
        const { reply, calls } = await answer(req({ headers: [["authorization", "Bearer ${STRIPE_KEY}"], ["x-debug", "${STRIPE_KEY}"]] }));
        expect(reply.error).toBe("agex.fetch: ${STRIPE_KEY} is in the x-debug header; it goes in its Authorization header only, as app/agex.json declares");
        expect(calls).toEqual([]);
        // bare, as the world would fill it
        const bare = await answer(req({ headers: [["authorization", "Bearer ${STRIPE_KEY}"], ["x-debug", "$STRIPE_KEY"]] }));
        expect(bare.reply.error).toContain("is in the x-debug header");
        expect(bare.calls).toEqual([]);
    });

    it("refuses a secret app/agex.json doesn't declare", async () => {
        const { reply, calls } = await answer(req({ headers: [["authorization", "Bearer ${OPENAI_KEY}"]] }));
        expect(reply.error).toBe("agex.fetch: ${OPENAI_KEY} isn't a secret app/agex.json declares; declare it under needs.secrets, with its origins and the header it goes in");
        expect(calls).toEqual([]);
    });

    it("refuses an origin the secret doesn't declare", async () => {
        const { reply, calls } = await answer(req({ url: "https://evil.example.com/collect" }));
        expect(reply.error).toBe("agex.fetch: STRIPE_KEY may go to https://api.stripe.com only, not https://evil.example.com (app/agex.json lists its origins)");
        expect(calls).toEqual([]);
    });

    it("refuses http:, the studio's origins, and a URL with credentials", async () => {
        const plain = await answer(req({ url: "http://api.stripe.com/v1/prices" }));
        expect(plain.reply.error).toBe("agex.fetch: http://api.stripe.com isn't https:; a request with a secret goes over https: only");
        // even where a declaration names them: the declaration's check is made again
        const studioNeeds = { model: false, secrets: [{ name: "STRIPE_KEY", origins: ["https://apps.agex.studio", "https://dev.local:4173"], header: "Authorization", why: "x" }] };
        const apps = await answer(req({ url: "https://apps.agex.studio/x" }), { needs: studioNeeds });
        expect(apps.reply.error).toBe(`agex.fetch: "https://apps.agex.studio" is the studio's own; a secret never goes to the studio or its apps`);
        const dev = await answer(req({ url: "https://dev.local:4173/x" }), { needs: studioNeeds, studioOrigins: ["https://dev.local:4173"] });
        expect(dev.reply.error).toContain("is the studio's own");
        const userinfo = await answer(req({ url: "https://user:pw@api.stripe.com/v1/prices" }));
        expect(userinfo.reply.error).toContain("the URL has credentials in it");
        for (const r of [plain, apps, dev, userinfo]) expect(r.calls).toEqual([]);
    });

    it("refuses a secret with no grant, and a relative URL", async () => {
        const none = await answer(req({ url: "https://maps.example.com/tiles", headers: [["X-API-KEY", "${MAPS_KEY}"]] }));
        expect(none.reply.error).toBe("agex.fetch: this app has no key for MAPS_KEY: the viewer hasn't granted one");
        expect(none.calls).toEqual([]);
        const relative = await answer(req({ url: "/v1/prices" }));
        expect(relative.reply.error).toContain(`"/v1/prices" isn't an absolute URL`);
    });

    it("asks for a grant only once the request is otherwise allowed", async () => {
        /** @type {string[]} */
        const asked = [];
        const fake = fakeFetch();
        const ctx = { needs, fetch: fake.fetch, grantFor: async (/** @type {any} */ need) => (asked.push(need.name), KEY) };
        await answerFetch(req({ url: "https://evil.example.com/" }), ctx);
        expect(asked).toEqual([]);
        await answerFetch(req(), ctx);
        expect(asked).toEqual(["STRIPE_KEY"]);
    });

    it("fails as the network did, never naming the key", async () => {
        const reply = await answerFetch(req(), { needs, grantFor, fetch: async () => { throw new TypeError(`Failed to fetch ${KEY}`); } });
        expect(reply.error).toMatch(/^agex\.fetch: /);
        expect(String(reply.error)).not.toContain(KEY);
    });
});

/** A frame whose page records what the studio posts to it. */
function frame() {
    /** @type {any[]} */
    const posted = [];
    const iframe = /** @type {any} */ ({ contentWindow: { postMessage: (/** @type {any} */ msg) => posted.push(msg) } });
    return { iframe, posted };
}

/** An answer that waits for its signal, or `go`. */
function held() {
    let go = () => {};
    /** @type {import("./app-fetch.js").FetchAnswer} */
    const run = (data, signal) =>
        new Promise((resolve, reject) => {
            go = () => resolve({ type: "agex-fetch-result", id: data.id, status: 200, statusText: "", url: "", headers: [], body: new Uint8Array(), error: null });
            signal.addEventListener("abort", () => reject(new Error("interrupted")));
        });
    return { run, go: () => go() };
}

describe("an app's request with a secret, relayed", () => {
    it("posts the reply back", async () => {
        const { iframe, posted } = frame();
        const r = held();
        const done = relayFetch(iframe, { id: "a" }, r.run);
        r.go();
        await done;
        expect(posted).toMatchObject([{ type: "agex-fetch-result", id: "a", status: 200, error: null }]);
    });

    it("aborts a request its app cancels, or every request of a page that went", async () => {
        const { iframe, posted } = frame();
        const one = held();
        const cancelled = relayFetch(iframe, { id: "c1" }, one.run);
        cancelFetch(iframe, "c1");
        await cancelled;
        expect(posted.at(-1)).toEqual({ type: "agex-fetch-result", id: "c1", error: "agex.fetch: interrupted" });

        const both = Promise.all([relayFetch(iframe, { id: "c2" }, held().run), relayFetch(iframe, { id: "c3" }, held().run)]);
        cancelFetches(iframe);
        await both;
        expect(posted.map((m) => [m.id, m.error])).toEqual([
            ["c1", "agex.fetch: interrupted"],
            ["c2", "agex.fetch: interrupted"],
            ["c3", "agex.fetch: interrupted"],
        ]);
    });

    it("aborts the studio's request through answerFetch's signal", async () => {
        const { iframe, posted } = frame();
        /** @type {AbortSignal | undefined} */
        let seen;
        const fetch = /** @type {typeof globalThis.fetch} */ ((_, init) =>
            new Promise((_, reject) => {
                seen = init?.signal ?? undefined;
                seen?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
            }));
        const done = relayFetch(iframe, req({ id: "s" }), (data, signal) => answerFetch(data, { needs, grantFor, fetch, signal }));
        await new Promise((r) => setTimeout(r, 0));
        cancelFetches(iframe);
        await done;
        expect(seen?.aborted).toBe(true);
        expect(posted.at(-1)).toEqual({ type: "agex-fetch-result", id: "s", error: "agex.fetch: interrupted" });
    });

    it("says a request with a secret isn't answered where there is no answer", async () => {
        const { iframe, posted } = frame();
        await relayFetch(iframe, { id: "n" }, null);
        expect(posted).toEqual([{ type: "agex-fetch-result", id: "n", error: "agex.fetch: a request with a secret isn't available here" }]);
    });
});
