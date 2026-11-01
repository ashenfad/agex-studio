import { describe, expect, it } from "vitest";
import { originMatcher, untrusted } from "./origins.js";
import { DEV_MATCHES, STUDIO_MATCHES } from "./protocol.js";

describe("originMatcher", () => {
    const allows = originMatcher(["https://agex.studio/*", "http://localhost/*"]);

    it("allows the studio's origin, and a local one on any port", () => {
        expect(allows("https://agex.studio")).toBe(true);
        expect(allows("http://localhost:5173")).toBe(true);
        expect(allows("http://localhost:4173")).toBe(true);
    });

    it("refuses another scheme, host or subdomain, and no origin", () => {
        expect(allows("http://agex.studio")).toBe(false);
        expect(allows("https://apps.agex.studio")).toBe(false);
        expect(allows("https://agex.studio.example")).toBe(false);
        expect(allows("https://localhost")).toBe(false);
        expect(allows(undefined)).toBe(false);
        expect(allows("not a url")).toBe(false);
    });

    it("refuses a pattern it can't read as one origin", () => {
        expect(() => originMatcher(["https://*.agex.studio/*"])).toThrow(/isn't scheme:\/\/host/);
        expect(() => originMatcher(["<all_urls>"])).toThrow(/isn't scheme:\/\/host/);
    });
});

describe("untrusted", () => {
    it("names a manifest's pattern the worker's list doesn't", () => {
        expect(untrusted(["https://agex.studio/*", "https://evil.example/*"], STUDIO_MATCHES)).toEqual(["https://evil.example/*"]);
    });

    it("passes the store's and the dev build's own patterns", () => {
        expect(untrusted([...STUDIO_MATCHES], STUDIO_MATCHES)).toEqual([]);
        expect(untrusted([...STUDIO_MATCHES, ...DEV_MATCHES], [...STUDIO_MATCHES, ...DEV_MATCHES])).toEqual([]);
        expect(untrusted([...DEV_MATCHES], STUDIO_MATCHES)).toEqual([...DEV_MATCHES]);
    });
});

