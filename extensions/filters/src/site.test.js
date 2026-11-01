import { describe, expect, it } from "vitest";
import { siteOfHost } from "./site.js";

describe("the site of a page", () => {
    it("is its registrable domain", () => {
        expect(siteOfHost("old.reddit.com")).toBe("reddit.com");
        expect(siteOfHost("news.bbc.co.uk")).toBe("bbc.co.uk");
        expect(siteOfHost("reddit.com")).toBe("reddit.com");
    });

    it("keeps apart sites under one platform's domain", () => {
        expect(siteOfHost("foo.github.io")).toBe("foo.github.io");
        expect(siteOfHost("bar.github.io")).toBe("bar.github.io");
    });

    it("is none for a host that isn't a site's", () => {
        expect(siteOfHost("127.0.0.1")).toBeNull();
        expect(siteOfHost("localhost")).toBeNull();
    });
});
