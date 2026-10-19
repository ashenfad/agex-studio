import { describe, expect, it, vi } from "vitest";
import { checkRouterKey, dollarLabel, keyUsageLine, keyUsageMore } from "./openrouter-api.js";

const KEY = "sk-or-v1-test";
const answer = (status, body) => vi.fn(async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
const keyData = (over = {}) => ({
    data: {
        label: "sk-or-v1-tes...est",
        usage: 41.5,
        usage_daily: 0.42,
        usage_weekly: 3.2,
        usage_monthly: 7.3,
        byok_usage: 6,
        byok_usage_daily: 0,
        byok_usage_weekly: 1.5,
        byok_usage_monthly: 2.25,
        limit: null,
        limit_remaining: null,
        limit_reset: null,
        is_free_tier: false,
        ...over,
    },
});

describe("checking an OpenRouter key", () => {
    it("asks OpenRouter's /key with the key as a bearer token", async () => {
        const fetchImpl = answer(200, keyData());
        await checkRouterKey(` ${KEY} `, { fetchImpl });
        const [url, init] = fetchImpl.mock.calls[0];
        expect(url).toBe("https://openrouter.ai/api/v1/key");
        expect(init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
    });

    it("reads an accepted key's spending, without a limit", async () => {
        expect(await checkRouterKey(KEY, { fetchImpl: answer(200, keyData()) })).toEqual({
            ok: true,
            usage: { today: 0.42, week: 3.2, month: 7.3, total: 41.5 },
            byok: { today: 0, week: 1.5, month: 2.25, total: 6 },
            limit: null,
            remaining: null,
            freeTier: false,
        });
    });

    it("reads a limit, what's left of it, and the free tier", async () => {
        const fetchImpl = answer(200, keyData({ limit: 20, limit_remaining: 8, is_free_tier: true }));
        expect(await checkRouterKey(KEY, { fetchImpl })).toMatchObject({ ok: true, limit: 20, remaining: 8, freeTier: true });
    });

    it("leaves out figures OpenRouter didn't give", async () => {
        const fetchImpl = answer(200, { data: { usage: 2 } });
        expect(await checkRouterKey(KEY, { fetchImpl })).toEqual({
            ok: true,
            usage: { today: null, week: null, month: null, total: 2 },
            byok: { today: null, week: null, month: null, total: null },
            limit: null,
            remaining: null,
            freeTier: false,
        });
    });

    it("calls a 401 or a 403 rejected", async () => {
        expect(await checkRouterKey(KEY, { fetchImpl: answer(401, { error: { message: "No auth credentials found", code: 401 } }) })).toEqual({ ok: false, reason: "rejected" });
        expect(await checkRouterKey(KEY, { fetchImpl: answer(403, "forbidden") })).toEqual({ ok: false, reason: "rejected" });
    });

    it("calls a network failure, another status or a body that isn't JSON unreachable, never naming the key", async () => {
        const failing = vi.fn(async () => {
            throw new TypeError("Failed to fetch");
        });
        const outs = [
            await checkRouterKey(KEY, { fetchImpl: failing }),
            await checkRouterKey(KEY, { fetchImpl: answer(500, "upstream down") }),
            await checkRouterKey(KEY, { fetchImpl: answer(200, "<html>") }),
            await checkRouterKey(KEY, { fetchImpl: answer(200, { data: null }) }),
        ];
        expect(outs.map((o) => o.ok === false && o.reason)).toEqual(["unreachable", "unreachable", "unreachable", "unreachable"]);
        expect(outs[0]).toMatchObject({ detail: "network error: Failed to fetch" });
        expect(outs[1]).toMatchObject({ detail: "HTTP 500" });
        expect(JSON.stringify(outs)).not.toContain(KEY);
    });

    it("calls no answer in time unreachable", async () => {
        const hanging = vi.fn(
            (_url, init) =>
                new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))),
        );
        expect(await checkRouterKey(KEY, { fetchImpl: hanging, timeout: 0.01 })).toEqual({ ok: false, reason: "unreachable", detail: "no answer within 0.01s" });
    });
});

describe("the key's line", () => {
    it("formats dollars to the cent, and less than a cent as <$0.01", () => {
        expect(dollarLabel(0)).toBe("$0.00");
        expect(dollarLabel(0.004)).toBe("<$0.01");
        expect(dollarLabel(0.0099)).toBe("<$0.01");
        expect(dollarLabel(0.01)).toBe("$0.01");
        expect(dollarLabel(0.155)).toBe("$0.16");
        expect(dollarLabel(7.3)).toBe("$7.30");
        expect(dollarLabel(20)).toBe("$20.00");
        expect(dollarLabel(1250)).toBe("$1,250.00");
    });

    const accepted = (over = {}) => ({
        ok: /** @type {const} */ (true),
        usage: { today: 0.42, week: 3.2, month: 7.3, total: 41.5 },
        byok: { today: 0, week: 0, month: 0, total: 0 },
        limit: null,
        remaining: null,
        freeTier: false,
        ...over,
    });

    it("says what was spent today and this month", () => {
        expect(keyUsageLine(accepted())).toBe("$0.42 today · $7.30 this month");
        // the rest is kept for the tooltip
        expect(keyUsageLine(accepted({ limit: 20, remaining: 8, freeTier: true, byok: { today: 1, week: 1, month: 1, total: 1 } }))).toBe(
            "$0.42 today · $7.30 this month",
        );
    });

    it("tells the rest: own provider keys, a limit, the free tier", () => {
        expect(keyUsageMore(accepted())).toBe("");
        const byok = { today: 1.25, week: 4, month: 9.5, total: 20 };
        expect(keyUsageMore(accepted({ byok }))).toBe("Plus $1.25 today, $9.50 this month through your own provider keys");
        expect(keyUsageMore(accepted({ limit: 20, remaining: 8 }))).toBe("$8.00 left of a $20.00 limit");
        expect(keyUsageMore(accepted({ limit: 20, remaining: null, freeTier: true }))).toBe("A $20.00 limit. Free tier");
    });

    it("leaves out what OpenRouter didn't say", () => {
        expect(keyUsageLine(accepted({ usage: { today: null, week: null, month: null, total: 1 } }))).toBe("");
    });
});
