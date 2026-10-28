import { beforeEach, describe, expect, it, vi } from "vitest";
import { STORAGE_KEY, Vault, VaultError, agentKeyOf, appKeyOf, checkFields, isOwnApp, sessionsOf } from "./vault.svelte.js";

/** @type {Map<string, string>} */
let items;
beforeEach(() => {
    items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

const STUDIO = { studioOrigins: ["https://apps.example.test", "http://localhost:4173"] };
const STRIPE = "https://api.stripe.com";
const FAKE = "sk_test_fake_0123456789";
const need = { name: "STRIPE_KEY", origins: [STRIPE] };

/** A vault with one Stripe key; the vault and the key's id. */
function withKey(origins = [STRIPE]) {
    const v = new Vault();
    const id = v.add({ label: "Stripe (personal)", value: FAKE, origins }, STUDIO);
    return { v, id };
}

/** What `fn` was refused for. @param {() => unknown} fn */
function refused(fn) {
    try {
        fn();
    } catch (e) {
        expect(e).toBeInstanceOf(VaultError);
        return /** @type {VaultError} */ (e).errors;
    }
    throw new Error("not refused");
}

describe("a vault entry's origins", () => {
    it("are normalized and listed once, blank lines skipped", () => {
        const out = checkFields({ label: " Stripe ", origins: ["https://API.Stripe.com:443/", "", "  https://api.stripe.com  ", "https://files.stripe.com"] }, STUDIO);
        expect(out).toEqual({ label: "Stripe", value: "", origins: [STRIPE, "https://files.stripe.com"], errors: [] });
        // an error names the line the origin is on
        expect(checkFields({ label: "k", origins: [STRIPE, "", "http://api.stripe.com"] }, STUDIO).errors).toEqual([
            'origin 3: "http://api.stripe.com" is http:; a key goes over https: only ("https://api.stripe.com")',
        ]);
    });

    it("are required, with a label", () => {
        expect(checkFields({ label: "  ", origins: ["", " "] }, STUDIO).errors).toEqual([
            'label: give the key a name, like "Stripe (personal)"',
            'origins: list where the key may go, one per line, like "https://api.stripe.com"',
        ]);
    });

    it("are https: origins alone, never the studio's, each error naming its place", () => {
        const { errors } = checkFields(
            {
                label: "k",
                origins: [
                    STRIPE,
                    "https://api.stripe.com/v1",
                    "http://api.stripe.com",
                    "api.stripe.com",
                    "https://*.stripe.com",
                    "https://user:pw@api.stripe.com",
                    "https://agex.studio",
                    "https://apps.example.test",
                    "ftp://files.example.com",
                ],
            },
            STUDIO,
        );
        expect(errors).toEqual([
            'origin 2: "https://api.stripe.com/v1" has a path; give the origin alone ("https://api.stripe.com")',
            'origin 3: "http://api.stripe.com" is http:; a key goes over https: only ("https://api.stripe.com")',
            'origin 4: "api.stripe.com" isn\'t an origin; give the scheme and host, like "https://api.stripe.com"',
            'origin 5: "https://*.stripe.com" has a wildcard; list each origin the key may go to, like "https://api.example.com"',
            'origin 6: "https://user:pw@api.stripe.com" has credentials; give the origin alone ("https://api.stripe.com") and the key in its own field',
            'origin 7: "https://agex.studio" is the studio\'s own; a key never goes to the studio or its apps',
            'origin 8: "https://apps.example.test" is the studio\'s own; a key never goes to the studio or its apps',
            'origin 9: "ftp://files.example.com" isn\'t an https: origin; give one like "https://api.example.com"',
        ]);
    });

    it("refuse an entry, saying everything wrong in the form's order, and never the key", () => {
        const v = new Vault();
        expect(refused(() => v.add({ label: "", value: " ", origins: [] }, STUDIO))).toEqual([
            'label: give the key a name, like "Stripe (personal)"',
            "key: paste the key",
            'origins: list where the key may go, one per line, like "https://api.stripe.com"',
        ]);
        const errors = refused(() => v.add({ label: "", value: FAKE, origins: ["http://api.stripe.com"] }, STUDIO));
        expect(errors).toHaveLength(2);
        expect(errors.join(" ")).not.toContain(FAKE);
        expect(refused(() => v.add({ label: "k", value: "  ", origins: [STRIPE] }, STUDIO))).toEqual(["key: paste the key"]);
        expect(v.entries).toEqual([]);
    });
});

describe("the vault", () => {
    it("keeps entries without their values on show", () => {
        const { v, id } = withKey();
        expect(id).toMatch(/^k-[0-9a-f]{18}$/);
        expect(v.entries).toEqual([{ id, label: "Stripe (personal)", origins: [STRIPE] }]);
        expect(JSON.stringify(v)).not.toContain(FAKE);
        expect(String(v)).toBe("Vault(1 keys)");
        // a second key needs a name of its own
        expect(refused(() => v.add({ label: "stripe (PERSONAL)", value: "sk_test_fake_2", origins: [STRIPE] }, STUDIO))[0]).toMatch(/another key is called/);
    });

    it("offers a need the entries whose origins cover all of the need's", () => {
        const { v, id: one } = withKey();
        const both = v.add({ label: "Stripe (both)", value: "sk_test_fake_b", origins: [STRIPE, "https://files.stripe.com"] }, STUDIO);
        v.add({ label: "Weather", value: "fake_weather", origins: ["https://api.weather.test"] }, STUDIO);
        expect(v.entriesCovering([STRIPE]).map((e) => e.id)).toEqual([one, both]);
        expect(v.entriesCovering([STRIPE, "https://files.stripe.com"]).map((e) => e.id)).toEqual([both]);
        expect(v.entriesCovering([])).toEqual([]);
    });

    it("grants an app an entry only when it covers the need's origins", () => {
        const { v, id } = withKey();
        const errors = refused(() => v.grant("session:s1", { name: "FILES_KEY", origins: [STRIPE, "https://files.stripe.com"] }, id));
        expect(errors).toEqual([`"Stripe (personal)" doesn't cover FILES_KEY's origins: it may go to ${STRIPE}, not https://files.stripe.com`]);
        expect(refused(() => v.grant("session:s1", need, "k-nope"))).toEqual(['no key "k-nope" in the vault']);
        expect(v.grantsOf("session:s1")).toEqual({});
        v.grant("session:s1", need, id);
        expect(v.grantsOf("session:s1")).toEqual({ STRIPE_KEY: id });
        expect(v.valueFor("session:s1", need)).toBe(FAKE);
        expect(v.valueFor("session:s2", need)).toBeNull();
        expect(v.valueFor("session:s1", { name: "OTHER", origins: [STRIPE] })).toBeNull();
    });

    it("gives no value once the entry's origins no longer cover the need, and again once they do", () => {
        const { v, id } = withKey([STRIPE, "https://files.stripe.com"]);
        v.grant("session:s1", need, id);
        v.update(id, { origins: ["https://files.stripe.com"] }, STUDIO);
        expect(v.valueFor("session:s1", need)).toBeNull();
        expect(v.usedBy(id)).toEqual([{ appKey: "session:s1", name: "STRIPE_KEY" }]);
        v.update(id, { origins: [STRIPE] }, STUDIO);
        expect(v.valueFor("session:s1", need)).toBe(FAKE);
        // a need asking more than it was granted for gets nothing
        expect(v.valueFor("session:s1", { name: "STRIPE_KEY", origins: [STRIPE, "https://evil.example"] })).toBeNull();
    });

    it("replaces a key for every app granted it, and refuses a bad change whole", () => {
        const { v, id } = withKey();
        v.grant("session:s1", need, id);
        v.grant("gist:ann/abc", need, id);
        v.update(id, { value: "sk_test_fake_new" });
        expect(v.valueFor("session:s1", need)).toBe("sk_test_fake_new");
        expect(v.valueFor("gist:ann/abc", need)).toBe("sk_test_fake_new");
        expect(refused(() => v.update(id, { label: "Renamed", origins: ["https://api.stripe.com/v1"] }, STUDIO))[0]).toMatch(/^origin 1: .* has a path/);
        expect(v.entries[0]?.label).toBe("Stripe (personal)");
        v.update(id, { label: "Stripe (work)" });
        expect(v.entries[0]).toMatchObject({ label: "Stripe (work)", origins: [STRIPE] });
    });

    it("gives no value once the entry is removed, and drops the grants to it", () => {
        const { v, id } = withKey();
        const other = v.add({ label: "Weather", value: "fake_weather", origins: ["https://api.weather.test"] }, STUDIO);
        const weather = { name: "WEATHER_KEY", origins: ["https://api.weather.test"] };
        v.grant("session:s1", need, id);
        v.grant("session:s1", weather, other);
        v.grant("session:s2", need, id);
        v.remove(id);
        expect(v.valueFor("session:s1", need)).toBeNull();
        expect(v.grantsOf("session:s1")).toEqual({ WEATHER_KEY: other });
        expect(v.grantsOf("session:s2")).toEqual({});
        expect(v.grants).toEqual({ "session:s1": { WEATHER_KEY: other } });
    });

    it("lists who uses an entry, and revokes one grant or all of an app's", () => {
        const { v, id } = withKey();
        v.grant("session:s1", need, id);
        v.grant("session:s1", { name: "STRIPE_ALT", origins: [STRIPE] }, id);
        v.grant("gist:ann/abc", need, id);
        expect(v.usedBy(id)).toEqual([
            { appKey: "session:s1", name: "STRIPE_KEY" },
            { appKey: "session:s1", name: "STRIPE_ALT" },
            { appKey: "gist:ann/abc", name: "STRIPE_KEY" },
        ]);
        v.revoke("session:s1", "STRIPE_ALT");
        expect(v.grantsOf("session:s1")).toEqual({ STRIPE_KEY: id });
        v.revoke("gist:ann/abc");
        expect(v.usedBy(id)).toEqual([{ appKey: "session:s1", name: "STRIPE_KEY" }]);
        v.revoke("session:s1", "STRIPE_KEY");
        expect(v.grants).toEqual({});
        v.revoke("session:nobody");
    });

    it("copies an app's grants to another, and forgets an app's", () => {
        const { v, id } = withKey();
        v.grant("gist:ann/abc", need, id);
        v.copyGrants("gist:ann/abc", "session:fork");
        expect(v.grantsOf("session:fork")).toEqual({ STRIPE_KEY: id });
        // a copy is its own: revoking one leaves the other
        v.revoke("session:fork");
        expect(v.grantsOf("gist:ann/abc")).toEqual({ STRIPE_KEY: id });
        v.copyGrants("session:none", "session:other");
        expect(v.grants).toEqual({ "gist:ann/abc": { STRIPE_KEY: id } });
        v.forgetApp("gist:ann/abc");
        expect(v.grants).toEqual({});
    });

    it("allows an app the model, kept, copied with its grants, revoked and forgotten", () => {
        const v = new Vault();
        expect(v.modelAllowed("gist:ann/abc")).toBe(false);
        v.allowModel("gist:ann/abc");
        expect(v.modelAllowed("gist:ann/abc")).toBe(true);
        expect(new Vault().modelAllowed("gist:ann/abc")).toBe(true);
        expect(v.toJSON().models).toEqual({ "gist:ann/abc": true });
        v.copyGrants("gist:ann/abc", "session:fork");
        expect(v.modelAllowed("session:fork")).toBe(true);
        v.revokeModel("session:fork");
        expect(new Vault().models).toEqual({ "gist:ann/abc": true });
        v.forgetApp("gist:ann/abc");
        expect(new Vault().models).toEqual({});
    });

    it("is kept under its own key, read back by a fresh vault", () => {
        const { v, id } = withKey();
        v.grant("bundle:abc123", need, id);
        expect([...items.keys()]).toEqual([STORAGE_KEY]);
        const again = new Vault();
        expect(again.entries).toEqual(v.entries);
        expect(again.grantsOf("bundle:abc123")).toEqual({ STRIPE_KEY: id });
        expect(again.valueFor("bundle:abc123", need)).toBe(FAKE);
    });

    it("works on what another tab kept since, not on what it read first", () => {
        const { v: here } = withKey();
        const there = new Vault();
        const weather = there.add({ label: "Weather", value: "fake_weather", origins: ["https://api.weather.test"] }, STUDIO);
        here.grant("session:s1", { name: "WEATHER_KEY", origins: ["https://api.weather.test"] }, weather);
        expect(new Vault().entries.map((e) => e.label)).toEqual(["Stripe (personal)", "Weather"]);
        expect(new Vault().grantsOf("session:s1")).toEqual({ WEATHER_KEY: weather });
    });

    it("drops what doesn't hold together when read", () => {
        items.set(
            STORAGE_KEY,
            JSON.stringify({
                entries: [
                    { id: "k-1", label: "Good", value: FAKE, origins: [STRIPE] },
                    { id: "k-2", label: "No value", value: "", origins: [STRIPE] },
                    { id: "k-3", label: "No origins", value: FAKE, origins: [] },
                    "junk",
                ],
                grants: { "session:s1": { A: "k-1", B: "k-2", C: 3 }, "session:s2": "junk" },
                models: { "gist:ann/abc": true, "bundle:h1": "yes" },
            }),
        );
        const v = new Vault();
        expect(v.entries.map((e) => e.id)).toEqual(["k-1"]);
        expect(v.grants).toEqual({ "session:s1": { A: "k-1" } });
        expect(v.models).toEqual({ "gist:ann/abc": true });
    });
});

describe("a session's agent's keys", () => {
    const FILES = "https://files.stripe.com";

    it("are the entries made available, by their names for agents, to their own origins", () => {
        const { v, id } = withKey([STRIPE, FILES]);
        expect(v.agentSecrets("s1")).toEqual({});
        v.setAgentName(id, "STRIPE_KEY");
        expect(v.entries[0].agentName).toBe("STRIPE_KEY");
        expect(v.agentSecrets("s1")).toEqual({ STRIPE_KEY: { value: FAKE, origins: [STRIPE, FILES] } });
        expect(v.agentSecrets("s2")).toEqual(v.agentSecrets("s1"));
        // an app has none of them
        expect(v.valueFor("session:s1", need)).toBeNull();
        v.setAgentName(id, null);
        expect(v.agentSecrets("s1")).toEqual({});
        expect(v.entries[0]).not.toHaveProperty("agentName");
    });

    it("refuse a name for agents that isn't one, or that another entry has", () => {
        const { v, id } = withKey();
        const other = v.add({ label: "Stripe (test)", value: "sk_test_fake_other", origins: [STRIPE] }, STUDIO);
        expect(refused(() => v.setAgentName(id, "stripe-key"))).toEqual(['name for agents: "stripe-key" must be upper-case letters, digits and _, starting with a letter, like "STRIPE_KEY"']);
        v.setAgentName(id, "STRIPE_KEY");
        expect(refused(() => v.setAgentName(other, "STRIPE_KEY"))).toEqual(['name for agents: "Stripe (personal)" is STRIPE_KEY to your agents; give this one its own name']);
        // its own name again is no clash
        v.setAgentName(id, "STRIPE_KEY");
    });

    it("are a session's grants, each to the origins approved, beating one made available", () => {
        const { v, id } = withKey([STRIPE, FILES]);
        const test = v.add({ label: "Stripe (test)", value: "sk_test_fake_other", origins: [STRIPE] }, STUDIO);
        v.setAgentName(id, "STRIPE_KEY");
        v.grantAgent("s1", { name: "STRIPE_KEY", origins: ["https://API.stripe.com"] }, test, STUDIO);
        expect(v.agentGrantsOf("s1")).toEqual({ STRIPE_KEY: { entry: test, origins: [STRIPE] } });
        expect(v.agentSecrets("s1")).toEqual({ STRIPE_KEY: { value: "sk_test_fake_other", origins: [STRIPE] } });
        expect(v.agentSecrets("s2")).toEqual({ STRIPE_KEY: { value: FAKE, origins: [STRIPE, FILES] } });
        // the entry's wider origins aren't the grant's
        v.grantAgent("s1", { name: "FILES_KEY", origins: [FILES] }, id, STUDIO);
        expect(v.agentSecrets("s1").FILES_KEY).toEqual({ value: FAKE, origins: [FILES] });
        // and an app of the same session has none of them
        expect(v.grantsOf("session:s1")).toEqual({});
    });

    it("are a delegate's top session's", () => {
        const { v, id } = withKey();
        expect(agentKeyOf("s1.helper.sub")).toBe("agent:s1");
        v.grantAgent("s1", need, id, STUDIO);
        expect(v.agentSecrets("s1.helper")).toEqual(v.agentSecrets("s1"));
        expect(Object.keys(v.agentGrants)).toEqual(["agent:s1"]);
    });

    it("refuse a grant with a bad name, bad origins, or origins the entry doesn't cover", () => {
        const { v, id } = withKey();
        expect(refused(() => v.grantAgent("s1", { name: "key", origins: [STRIPE] }, id, STUDIO))[0]).toMatch(/^name: "key" must be upper-case/);
        expect(refused(() => v.grantAgent("s1", { name: "K", origins: ["http://api.stripe.com"] }, id, STUDIO))).toEqual(['origin 1: "http://api.stripe.com" is http:; a key goes over https: only ("https://api.stripe.com")']);
        expect(refused(() => v.grantAgent("s1", { name: "K", origins: [] }, id, STUDIO))).toEqual(['origins: name where K may go, like "https://api.stripe.com"']);
        expect(refused(() => v.grantAgent("s1", { name: "K", origins: [STRIPE, FILES] }, id, STUDIO))).toEqual([`"Stripe (personal)" may go to ${STRIPE}, not ${FILES}`]);
        expect(refused(() => v.grantAgent("s1", { name: "K", origins: [STRIPE] }, "k-gone", STUDIO))).toEqual(['no key "k-gone" in the vault']);
        expect(v.agentGrants).toEqual({});
    });

    it("give nothing once the entry no longer covers a grant, or is gone, which drops the grant", () => {
        const { v, id } = withKey([STRIPE, FILES]);
        v.grantAgent("s1", { name: "FILES_KEY", origins: [FILES] }, id, STUDIO);
        v.update(id, { origins: [STRIPE] }, STUDIO);
        expect(v.agentSecrets("s1")).toEqual({});
        v.update(id, { origins: [STRIPE, FILES] }, STUDIO);
        expect(v.agentSecrets("s1")).toEqual({ FILES_KEY: { value: FAKE, origins: [FILES] } });
        v.remove(id);
        expect([v.agentSecrets("s1"), v.agentGrants]).toEqual([{}, {}]);
    });

    it("are listed by entry, revoked one or all, copied to a fork, and forgotten with the session", () => {
        const { v, id } = withKey();
        v.grantAgent("s1", need, id, STUDIO);
        v.grantAgent("s1", { name: "OTHER", origins: [STRIPE] }, id, STUDIO);
        v.grantAgent("s2", need, id, STUDIO);
        expect(v.agentsUsing(id)).toEqual([
            { session: "s1", name: "STRIPE_KEY" },
            { session: "s1", name: "OTHER" },
            { session: "s2", name: "STRIPE_KEY" },
        ]);
        v.revokeAgent("s1", "OTHER");
        v.copyAgentGrants("s1", "s3");
        expect(v.agentGrantsOf("s3")).toEqual({ STRIPE_KEY: { entry: id, origins: [STRIPE] } });
        v.revokeAgent("s2");
        // a delegate's removal leaves its top session's
        v.forgetAgent("s1.helper");
        expect(v.agentsUsing(id).map((u) => u.session)).toEqual(["s1", "s3"]);
        v.forgetAgent("s1");
        expect(v.agentsUsing(id).map((u) => u.session)).toEqual(["s3"]);
    });

    it("are kept, and what doesn't hold together is dropped when read", () => {
        const { v, id } = withKey();
        v.setAgentName(id, "STRIPE_KEY");
        v.grantAgent("s1", need, id, STUDIO);
        const again = new Vault();
        expect([again.entries, again.agentGrants]).toEqual([v.entries, v.agentGrants]);
        expect(again.toJSON().agentGrants).toEqual({ "agent:s1": { STRIPE_KEY: { entry: id, origins: [STRIPE] } } });
        items.set(
            STORAGE_KEY,
            JSON.stringify({
                entries: [
                    { id: "k-1", label: "A", value: FAKE, origins: [STRIPE], agentName: "A_KEY" },
                    { id: "k-2", label: "B", value: FAKE, origins: [STRIPE], agentName: "A_KEY" },
                    { id: "k-3", label: "C", value: FAKE, origins: [STRIPE], agentName: "bad name" },
                ],
                agentGrants: {
                    "agent:s1": { GOOD: { entry: "k-1", origins: [STRIPE] }, GONE: { entry: "k-9", origins: [STRIPE] }, NONE: { entry: "k-1", origins: [] }, bad: { entry: "k-1", origins: [STRIPE] } },
                    "session:s1": { X: { entry: "k-1", origins: [STRIPE] } },
                    "agent:s2": "junk",
                },
            }),
        );
        const read = new Vault();
        expect(read.entries.map((e) => e.agentName)).toEqual(["A_KEY", undefined, undefined]);
        expect(read.agentGrants).toEqual({ "agent:s1": { GOOD: { entry: "k-1", origins: [STRIPE] } } });
    });
});

describe("an app's key", () => {
    const gist = { owner: "ann", id: "abc123", slug: "prices", revision: "f".repeat(40), pinned: false };

    it("is its gist's for an app opened from one, its bundle's head for one from a bundle, else its session's", () => {
        expect(appKeyOf({ name: "s-1", source: { head: "h1", gist } })).toBe("gist:ann/abc123");
        expect(appKeyOf({ name: "s-2", source: { head: "h1" } })).toBe("bundle:h1");
        expect(appKeyOf({ name: "s-3" })).toBe("session:s-3");
        expect([isOwnApp("session:s-3"), isOwnApp("gist:ann/abc123"), isOwnApp("bundle:h1")]).toEqual([true, false, false]);
    });

    it("finds the sessions that are an app", () => {
        const sessions = [
            { name: "s-1", source: { head: "h1", gist } },
            { name: "s-2", source: { head: "h2", gist: { ...gist, revision: "e".repeat(40) } } },
            { name: "s-3" },
        ];
        expect(sessionsOf("gist:ann/abc123", sessions).map((s) => s.name)).toEqual(["s-1", "s-2"]);
        expect(sessionsOf("session:s-3", sessions).map((s) => s.name)).toEqual(["s-3"]);
        expect(sessionsOf("session:gone", sessions)).toEqual([]);
    });
});
