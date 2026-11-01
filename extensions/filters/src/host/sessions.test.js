import { describe, expect, it } from "vitest";
import { sessionOf, siteOf } from "./sessions.js";

describe("a session per site", () => {
    it("names a site's session with its dots as underscores, and maps it back", () => {
        expect(sessionOf("reddit.com")).toBe("site-reddit_com");
        expect(sessionOf("bbc.co.uk")).toBe("site-bbc_co_uk");
        expect(siteOf("site-bbc_co_uk")).toBe("bbc.co.uk");
    });

    it("keeps apart domains whose names differ only by a dot or a hyphen", () => {
        expect(sessionOf("a-b.com")).not.toBe(sessionOf("a.b-com"));
    });

    it("refuses what isn't a domain, and isn't fooled by a session that isn't a site's", () => {
        for (const bad of ["", "localhost", "Reddit.com", "-a.com", "a..com", "a.com.", "a_b.com"]) expect(() => sessionOf(bad), bad).toThrow();
        expect(siteOf("s-123")).toBeNull();
        expect(siteOf("site-")).toBeNull();
        expect(siteOf("site-nodots")).toBeNull();
    });
});
