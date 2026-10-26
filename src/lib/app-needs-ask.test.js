import { beforeEach, describe, expect, it, vi } from "vitest";
import { HIDDEN, NOT_ALLOWED, NeedsAsk } from "./app-needs-ask.svelte.js";
import { noNeeds } from "./app-needs.js";
import { Vault, VaultError } from "./vault.svelte.js";

beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

const STUDIO = { studioOrigins: ["https://apps.example.test"] };
const STRIPE = "https://api.stripe.com";
const FAKE = "sk_test_fake_0123456789";
const stripe = { name: "STRIPE_KEY", origins: [STRIPE], header: "Authorization", why: "to look up prices" };
const weather = { name: "WEATHER_KEY", origins: ["https://api.weather.test"], header: "X-Api-Key", why: "for the forecast" };
/** @type {import("./app-needs.js").AppNeeds} */
const needs = { model: true, secrets: [stripe, weather] };
const settle = () => new Promise((r) => setTimeout(r, 0));

/** Asking, over a vault read from what is kept. */
function fresh() {
    const vault = new Vault();
    return { vault, ask: new NeedsAsk(vault) };
}

/** A vault entry that covers Stripe; its id. @param {Vault} vault */
const stripeKey = (vault) => vault.add({ label: "Stripe (personal)", value: FAKE, origins: [STRIPE] }, STUDIO);

describe("asking for the model", () => {
    it("asks an app from elsewhere once, then remembers, in a fresh page too", async () => {
        const { ask } = fresh();
        const first = ask.allowModel("s1", "gist:ann/abc", needs, { ask: true });
        await settle();
        expect(ask.asking.s1).toMatchObject({ appKey: "gist:ann/abc", needs, own: false, model: true });
        ask.answer("s1", {});
        await expect(first).resolves.toBeUndefined();
        expect(ask.asking.s1).toBeUndefined();
        await ask.allowModel("s1", "gist:ann/abc", needs, { ask: true, prompt: false });
        // another session of the same app, in a new page
        const again = fresh();
        await again.ask.allowModel("s2", "gist:ann/abc", needs, { ask: true, prompt: false });
        expect(again.vault.modelAllowed("gist:ann/abc")).toBe(true);
    });

    it("doesn't ask for the person's own app", async () => {
        const { ask, vault } = fresh();
        await ask.allowModel("s1", "session:s1", needs, { ask: false });
        expect(ask.asking.s1).toBeUndefined();
        expect(vault.modelAllowed("session:s1")).toBe(false);
    });

    it("asks an app that doesn't declare it all the same", async () => {
        const { ask } = fresh();
        const first = ask.allowModel("s1", "bundle:h1", noNeeds(), { ask: true });
        await settle();
        expect(ask.asking.s1).toMatchObject({ model: true, needs: { model: false, secrets: [] } });
        ask.answer("s1", {});
        await first;
    });

    it("refuses a hidden test rather than asking", async () => {
        const { ask } = fresh();
        await expect(ask.allowModel("s1", "bundle:h1", needs, { ask: true, prompt: false })).rejects.toThrow(HIDDEN);
        expect(ask.asking.s1).toBeUndefined();
    });

    it("refuses the calls waiting on Don't allow, and later ones this page, without asking", async () => {
        const { ask } = fresh();
        const one = ask.allowModel("s1", "bundle:h1", needs, { ask: true });
        const two = ask.allowModel("s1", "bundle:h1", needs, { ask: true });
        await settle();
        ask.answer("s1", null);
        await expect(one).rejects.toThrow(NOT_ALLOWED);
        await expect(two).rejects.toThrow(NOT_ALLOWED);
        await expect(ask.allowModel("s1", "bundle:h1", needs, { ask: true })).rejects.toThrow(NOT_ALLOWED);
        expect(ask.asking.s1).toBeUndefined();
        // a new page asks again: a no isn't kept
        const again = fresh();
        void again.ask.allowModel("s1", "bundle:h1", needs, { ask: true }).catch(() => {});
        await settle();
        expect(again.ask.asking.s1).toBeDefined();
    });

    it("stops waiting when a call aborts, the question taken back once none waits", async () => {
        const { ask, vault } = fresh();
        const a = new AbortController();
        const b = new AbortController();
        const one = ask.allowModel("s1", "bundle:h1", needs, { ask: true, signal: a.signal });
        const two = ask.allowModel("s1", "bundle:h1", needs, { ask: true, signal: b.signal });
        await settle();
        a.abort(new Error("gone one"));
        await expect(one).rejects.toThrow("gone one");
        expect(ask.asking.s1).toBeDefined();
        b.abort(new Error("gone two"));
        await expect(two).rejects.toThrow("gone two");
        expect(ask.asking.s1).toBeUndefined();
        expect(vault.modelAllowed("bundle:h1")).toBe(false);
        // nothing was said: the next call asks afresh
        const three = ask.allowModel("s1", "bundle:h1", needs, { ask: true });
        await settle();
        ask.answer("s1", {});
        await three;
    });

    it("refuses a call waiting when the session is forgotten", async () => {
        const { ask } = fresh();
        const waiting = ask.allowModel("s1", "bundle:h1", needs, { ask: true });
        const key = ask.secretFor("s1", "bundle:h1", needs, stripe);
        await settle();
        ask.forget("s1");
        await expect(waiting).rejects.toThrow("session was deleted");
        await expect(key).resolves.toBeNull();
        expect(ask.asking.s1).toBeUndefined();
    });
});

describe("asking for a key", () => {
    it("gives the granted key without asking", async () => {
        const { ask, vault } = fresh();
        vault.grant("session:s1", stripe, stripeKey(vault));
        await expect(ask.secretFor("s1", "session:s1", needs, stripe, { prompt: false })).resolves.toBe(FAKE);
        expect(ask.asking.s1).toBeUndefined();
    });

    it("asks when there is no grant, and gives the key the person chose, kept for next time", async () => {
        const { ask, vault } = fresh();
        const id = stripeKey(vault);
        const key = ask.secretFor("s1", "session:s1", needs, stripe);
        await settle();
        // the person's own app: the model is theirs already
        expect(ask.asking.s1).toMatchObject({ own: true, appKey: "session:s1" });
        ask.answer("s1", { STRIPE_KEY: id });
        await expect(key).resolves.toBe(FAKE);
        expect(vault.modelAllowed("session:s1")).toBe(false);
        await expect(fresh().ask.secretFor("s1", "session:s1", needs, stripe, { prompt: false })).resolves.toBe(FAKE);
    });

    it("gives null when the person doesn't allow, or leaves the key without one, and doesn't ask again this page", async () => {
        const { ask, vault } = fresh();
        const id = stripeKey(vault);
        const both = [ask.secretFor("s1", "bundle:h1", needs, stripe), ask.secretFor("s1", "bundle:h1", needs, weather)];
        await settle();
        ask.answer("s1", null);
        await expect(Promise.all(both)).resolves.toEqual([null, null]);
        await expect(ask.secretFor("s1", "bundle:h1", needs, stripe)).resolves.toBeNull();
        expect(ask.asking.s1).toBeUndefined();

        // Allow, with Stripe's key and none for the weather
        const key = ask.secretFor("s2", "bundle:h2", needs, stripe);
        await settle();
        ask.answer("s2", { STRIPE_KEY: id });
        await expect(key).resolves.toBe(FAKE);
        expect(vault.modelAllowed("bundle:h2")).toBe(true);
        await expect(ask.secretFor("s2", "bundle:h2", needs, weather)).resolves.toBeNull();
        expect(ask.asking.s2).toBeUndefined();
    });

    it("gives null without asking when nobody is looking, or the app doesn't declare the key", async () => {
        const { ask } = fresh();
        await expect(ask.secretFor("s1", "session:s1", needs, stripe, { prompt: false })).resolves.toBeNull();
        await expect(ask.secretFor("s1", "session:s1", noNeeds(), stripe)).resolves.toBeNull();
        expect(ask.asking.s1).toBeUndefined();
    });

    it("shares one question with the calls waiting, the model asked for once one needs it", async () => {
        const { ask, vault } = fresh();
        const id = stripeKey(vault);
        const declared = { model: false, secrets: [stripe] };
        const key = ask.secretFor("s1", "bundle:h1", declared, stripe);
        await settle();
        expect(ask.asking.s1?.model).toBe(false);
        const model = ask.allowModel("s1", "bundle:h1", declared, { ask: true });
        const again = ask.secretFor("s1", "bundle:h1", declared, stripe);
        await settle();
        expect(ask.asking.s1?.model).toBe(true);
        ask.answer("s1", { STRIPE_KEY: id });
        await expect(Promise.all([key, model, again])).resolves.toEqual([FAKE, undefined, FAKE]);
    });

    it("keeps the question open when a grant is refused", async () => {
        const { ask, vault } = fresh();
        const other = vault.add({ label: "Weather", value: "fake_weather", origins: ["https://api.weather.test"] }, STUDIO);
        const key = ask.secretFor("s1", "session:s1", needs, stripe);
        await settle();
        expect(() => ask.answer("s1", { STRIPE_KEY: other })).toThrow(VaultError);
        expect(ask.asking.s1).toBeDefined();
        ask.answer("s1", null);
        await expect(key).resolves.toBeNull();
    });
});
