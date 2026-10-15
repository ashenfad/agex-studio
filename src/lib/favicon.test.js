// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from "vitest";

const BASE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#7c6fe0"><path d="M1 1"/></svg>';

const href = () => document.querySelector('link[rel~="icon"]')?.getAttribute("href");

beforeEach(() => {
    // the module remembers the shipped href and the fetched icon
    vi.resetModules();
    document.head.innerHTML = '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
    vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, text: async () => BASE })),
    );
});

const load = () => import("./favicon.js");

describe("badged", () => {
    it("splices a dot of the status's color in before the end of the icon", async () => {
        const { badged, STATUS_COLORS } = await load();
        const out = badged(BASE, "attention");
        expect(out.startsWith(BASE.slice(0, -"</svg>".length))).toBe(true);
        expect(out).toMatch(/<circle [^>]*fill="#d9a441"[^>]*\/><\/svg>$/);
        expect(STATUS_COLORS).toEqual({ working: "#e94560", attention: "#d9a441", unseen: "#4caf50" });
    });
});

describe("setFaviconStatus", () => {
    it.each([
        ["working", "%23e94560"],
        ["attention", "%23d9a441"],
        ["unseen", "%234caf50"],
    ])("badges the icon for %s", async (status, color) => {
        const { setFaviconStatus } = await load();
        await setFaviconStatus(/** @type {any} */ (status));
        expect(href()?.startsWith("data:image/svg+xml,")).toBe(true);
        expect(href()).toContain(color);
        expect(decodeURIComponent(href() ?? "")).toContain('<path d="M1 1"/><circle');
    });

    it("puts the shipped href back when there's nothing to say", async () => {
        const { setFaviconStatus } = await load();
        await setFaviconStatus("working");
        await setFaviconStatus(null);
        expect(href()).toBe("/favicon.svg");
    });

    it("fetches the icon once, and does nothing for the status already shown", async () => {
        const { setFaviconStatus } = await load();
        await setFaviconStatus("working");
        await setFaviconStatus("working");
        await setFaviconStatus("unseen");
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(href()).toContain("%234caf50");
    });

    it("lets the latest status win over one still waiting for the icon", async () => {
        const { setFaviconStatus } = await load();
        const first = setFaviconStatus("working");
        await setFaviconStatus(null);
        await first;
        expect(href()).toBe("/favicon.svg");
    });

    it("leaves the icon plain when it can't be fetched, and tries again", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false })));
        const { setFaviconStatus } = await load();
        await setFaviconStatus("working");
        expect(href()).toBe("/favicon.svg");
        vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => BASE })));
        await setFaviconStatus("working");
        expect(href()).toContain("%23e94560");
    });
});
