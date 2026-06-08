// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from "vitest";

const BASE_SVG =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="#7c6fe0"><path d="M1 1"/></svg>';

function linkHref() {
    return document.querySelector('link[rel~="icon"]')?.getAttribute("href");
}

beforeEach(() => {
    // Fresh module state (cached base-svg promise / original href) per test.
    vi.resetModules();
    document.head.innerHTML =
        '<link rel="icon" type="image/svg+xml" href="/favicon.svg">';
    vi.stubGlobal(
        "fetch",
        vi.fn(() =>
            Promise.resolve({ ok: true, text: () => Promise.resolve(BASE_SVG) }),
        ),
    );
});

async function load() {
    return await import("./favicon.js");
}

describe("setFaviconStatus", () => {
    it("badges the icon with the red working color", async () => {
        const { setFaviconStatus } = await load();
        await setFaviconStatus("working");
        const href = linkHref();
        expect(href.startsWith("data:image/svg+xml,")).toBe(true);
        // #e94560 → %23e94560 once URL-encoded.
        expect(href).toContain("%23e94560");
        expect(decodeURIComponent(href)).toContain("<circle");
    });

    it("badges the icon with the green unseen color", async () => {
        const { setFaviconStatus } = await load();
        await setFaviconStatus("unseen");
        expect(linkHref()).toContain("%234caf50");
    });

    it("restores the original href when cleared", async () => {
        const { setFaviconStatus } = await load();
        await setFaviconStatus("working");
        expect(linkHref()).not.toBe("/favicon.svg");
        await setFaviconStatus(null);
        expect(linkHref()).toBe("/favicon.svg");
    });

    it("is idempotent — repeated same-status calls don't refetch", async () => {
        const { setFaviconStatus } = await load();
        await setFaviconStatus("working");
        await setFaviconStatus("working");
        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("leaves the icon untouched when the base SVG can't be fetched", async () => {
        vi.stubGlobal("fetch", () => Promise.resolve({ ok: false }));
        const { setFaviconStatus } = await load();
        await setFaviconStatus("working");
        // Fetch failed → no data URL written; the shipped icon stays.
        expect(linkHref()).toBe("/favicon.svg");
    });
});
