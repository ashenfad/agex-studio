import { describe, expect, it } from "vitest";
import { checkDomains, covered, domainOf } from "./site-grants.js";

describe("domainOf", () => {
    it("reads a domain from a domain, a host or a URL, without www.", () => {
        expect(domainOf("marriott.com")).toBe("marriott.com");
        expect(domainOf(" Marriott.COM ")).toBe("marriott.com");
        expect(domainOf("www.marriott.com")).toBe("marriott.com");
        expect(domainOf("https://www.marriott.com/hotels/lisbon?x=1")).toBe("marriott.com");
        expect(domainOf("book.ihg.com:443/x")).toBe("book.ihg.com");
        expect(domainOf("http://localhost:4173/")).toBe("localhost");
        expect(domainOf("bücher.example")).toBe("xn--bcher-kva.example");
    });

    it("refuses what isn't one: a top-level domain alone, a wildcard, another scheme", () => {
        for (const d of ["com", "*.marriott.com", "ftp://marriott.com", "", "  ", "www.com", 42, null]) {
            // www.com is a domain itself: kept whole, not cut to "com"
            if (d === "www.com") expect(domainOf(d)).toBe("www.com");
            else expect(domainOf(d), String(d)).toBe(null);
        }
    });
});

describe("checkDomains", () => {
    it("drops duplicates, and a subdomain another in the list covers", () => {
        expect(checkDomains(["marriott.com", "https://www.marriott.com", "book.marriott.com", "hyatt.com"])).toEqual({ domains: ["marriott.com", "hyatt.com"], errors: [] });
    });

    it("says each thing that isn't a domain", () => {
        expect(checkDomains(["hyatt.com", "com"]).errors).toEqual(['domains: "com" isn\'t a domain; name one like "marriott.com"']);
    });

    it("refuses too many at once", () => {
        expect(checkDomains(Array.from({ length: 31 }, (_, i) => `site${i}.example`)).errors).toEqual(["domains: ask for 30 or fewer at once"]);
    });
});

describe("covered", () => {
    it("is the domain or a subdomain of one granted", () => {
        expect(covered(["marriott.com"], "book.marriott.com")).toBe(true);
        expect(covered(["marriott.com"], "marriott.com")).toBe(true);
        expect(covered(["marriott.com"], "evilmarriott.com")).toBe(false);
        expect(covered(["book.marriott.com"], "marriott.com")).toBe(false);
    });
});
