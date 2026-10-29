import { describe, expect, it } from "vitest";
import { granted, hostOf, isDomain, pageRules } from "./grants.js";

describe("isDomain", () => {
    it("takes a host name in its normal form", () => {
        for (const d of ["marriott.com", "www.marriott.com", "book.ihg.co.uk", "localhost", "127.0.0.1", "xn--bcher-kva.example"]) {
            expect(isDomain(d), d).toBe(true);
        }
    });

    it("refuses a URL, a port, a wildcard, upper case, a top-level domain, or anything not a string", () => {
        for (const d of ["https://marriott.com", "marriott.com/", "marriott.com:443", "*.marriott.com", ".marriott.com", "marriott.com.", "Marriott.com", "com", "", "bücher.example", 42]) {
            expect(isDomain(d), String(d)).toBe(false);
        }
    });
});

describe("granted", () => {
    const domains = ["hyatt.com", "localhost"];

    it("allows the domain and its subdomains, over http or https, on any port", () => {
        expect(granted("https://hyatt.com/", domains)).toBe(true);
        expect(granted("https://www.hyatt.com/search?location=Lisbon", domains)).toBe(true);
        expect(granted("http://book.www.hyatt.com:8443/", domains)).toBe(true);
        expect(granted("http://localhost:4173/", domains)).toBe(true);
        expect(granted("http://hotels.localhost:4173/", domains)).toBe(true);
    });

    it("refuses look-alikes: another domain ending the same, or one hiding a granted name", () => {
        expect(granted("https://evilhyatt.com/", domains)).toBe(false);
        expect(granted("https://hyatt.com.evil.example/", domains)).toBe(false);
        expect(granted("https://hyatt.com@evil.example/", domains)).toBe(false);
        expect(granted("https://ihg.com/", domains)).toBe(false);
    });

    it("allows a URL that loads from no site", () => {
        expect(hostOf("about:blank")).toBe(null);
        expect(granted("about:blank", [])).toBe(true);
    });
});

describe("pageRules", () => {
    it("blocks the tab's page loads, and lets the domains' through above that", () => {
        const rules = pageRules(7, ["hyatt.com", "ihg.com"], 10);
        expect(rules.map((r) => r.id)).toEqual([10, 11]);
        expect(rules[0]).toMatchObject({ priority: 1, action: { type: "block" }, condition: { tabIds: [7], resourceTypes: ["main_frame"] } });
        expect(rules[1]).toMatchObject({ priority: 2, action: { type: "allow" }, condition: { tabIds: [7], resourceTypes: ["main_frame"], requestDomains: ["hyatt.com", "ihg.com"] } });
    });

    it("blocks every load when no domain is granted", () => {
        expect(pageRules(7, [], 1)).toHaveLength(1);
    });
});
