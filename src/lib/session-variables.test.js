import { Memory } from "@agex-ts/kvgit/backends/memory";
import { Store } from "@agex-ts/world";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatSession } from "./session.svelte.js";
import { PLANE } from "./store.js";
import { VARIABLES_KEY, forgetLiveVariables, liveVariables } from "./variables.js";
import { vault } from "./vault.svelte.js";

beforeEach(() => {
    const items = new Map();
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => items.get(k) ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => items.set(k, String(v)),
        removeItem: (/** @type {string} */ k) => items.delete(k),
    });
});

afterEach(() => {
    forgetLiveVariables("s1");
    vault.forgetAgent("s1");
});

/** Session s1, open on a fresh world, its app declaring a secret. */
async function openSession() {
    const store = await Store.open(new Memory());
    const ws = await store.open("s1", { profile: { variables: () => liveVariables("s1") } });
    await ws.files.write(
        "/workspace/app/agex.json",
        new TextEncoder().encode(
            JSON.stringify({ needs: { secrets: [{ name: "MAPS_KEY", origins: ["https://maps.test"], in: "header:X-Key", why: "to draw the map" }] } }),
        ),
    );
    await ws.autoCommit({ tool: "test" });
    const session = new ChatSession("s1", { current: null, opened: () => [] });
    await session.open(ws);
    const told = vi.fn();
    session.onMeta = told;
    return { ws, session, told };
}

describe("a session's variables", () => {
    it("are set on its plane, committed, and live for its world and its delegates", async () => {
        const { ws, session, told } = await openSession();
        const before = ws.head;
        expect(await session.setVariables({ API_URL: "https://a.test" })).toEqual([]);
        // the studio hears of it, so sync takes it
        expect(told).toHaveBeenCalledTimes(1);
        expect(session.variables).toEqual({ API_URL: "https://a.test" });
        expect(await ws.plane(PLANE).get(VARIABLES_KEY)).toEqual({ API_URL: "https://a.test" });
        expect(ws.head).not.toBe(before);
        expect(liveVariables("s1.d1")).toEqual({ API_URL: "https://a.test" });
        expect((await ws.terminal('echo "$API_URL"')).stdout).toBe("https://a.test\n");

        expect(await session.setVariables({ API_URL: null })).toEqual([]);
        expect(liveVariables("s1")).toEqual({});
        await session.close();
    });

    it("refuse a name the agent has as a key, or the app declares, changing nothing", async () => {
        const { session } = await openSession();
        const id = vault.add({ label: "Stripe", value: "sk_test_fake_0123456789", origins: ["https://api.stripe.com"] });
        vault.grantAgent("s1", { name: "STRIPE_KEY", origins: ["https://api.stripe.com"] }, id);
        expect(await session.setVariables({ STRIPE_KEY: "pk", MAPS_KEY: "x", OK: "1" })).toEqual([
            "STRIPE_KEY: one of this session's keys; a name is a key or a variable, not both",
            "MAPS_KEY: a secret app/agex.json declares; a name is a key or a variable, not both",
        ]);
        expect(session.variables).toEqual({});
        vault.remove(id);
        await session.close();
    });

    it("are read again when the session reloads, as after a checkout", async () => {
        const { ws, session } = await openSession();
        await session.setVariables({ API_URL: "https://a.test" });
        const at = ws.head;
        await session.setVariables({ API_URL: "https://b.test" });
        await ws.checkout(at);
        await session.reload();
        expect(session.variables).toEqual({ API_URL: "https://a.test" });
        expect(liveVariables("s1")).toEqual({ API_URL: "https://a.test" });
        await session.close();
    });
});
