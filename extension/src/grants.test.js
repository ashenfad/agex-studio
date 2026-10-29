import { describe, expect, it } from "vitest";
import { granted, isOrigin, originOf, pageRules } from "./grants.js";

describe("isOrigin", () => {
    it("takes an http or https origin in its normal form", () => {
        expect(isOrigin("https://www.marriott.com")).toBe(true);
        expect(isOrigin("http://localhost:8080")).toBe(true);
    });

    it("refuses anything else", () => {
        for (const o of [
            "https://www.marriott.com/",
            "https://www.marriott.com/hotels",
            "https://WWW.marriott.com",
            "https://www.marriott.com:443",
            "www.marriott.com",
            "ftp://example.com",
            "*://example.com",
            "",
            42,
        ]) {
            expect(isOrigin(o), String(o)).toBe(false);
        }
    });
});

describe("granted", () => {
    const origins = ["https://www.hyatt.com", "http://localhost:4173"];

    it("allows a URL on a granted origin", () => {
        expect(granted("https://www.hyatt.com/search?location=Lisbon", origins)).toBe(true);
        expect(granted("http://localhost:4173/", origins)).toBe(true);
    });

    it("refuses another scheme, host, subdomain or port", () => {
        expect(granted("http://www.hyatt.com/", origins)).toBe(false);
        expect(granted("https://hyatt.com/", origins)).toBe(false);
        expect(granted("https://www.hyatt.com.evil.example/", origins)).toBe(false);
        expect(granted("https://www.hyatt.com@evil.example/", origins)).toBe(false);
        expect(granted("http://localhost:5173/", origins)).toBe(false);
    });

    it("allows a URL that loads from no site", () => {
        expect(originOf("about:blank")).toBe(null);
        expect(granted("about:blank", [])).toBe(true);
    });
});

describe("pageRules", () => {
    it("blocks the tab's page loads, and lets each origin's through above that", () => {
        const rules = pageRules(7, ["https://www.hyatt.com", "https://www.ihg.com"], 10);
        expect(rules.map((r) => r.id)).toEqual([10, 11, 12]);
        expect(rules[0]).toMatchObject({ priority: 1, action: { type: "block" }, condition: { tabIds: [7], resourceTypes: ["main_frame"] } });
        expect(rules[1]).toMatchObject({ priority: 2, action: { type: "allow" }, condition: { tabIds: [7], urlFilter: "|https://www.hyatt.com/" } });
        expect(rules[2].condition.urlFilter).toBe("|https://www.ihg.com/");
        expect(rules[0].condition).not.toHaveProperty("urlFilter");
    });

    it("blocks every load when no origin is granted", () => {
        expect(pageRules(7, [], 1)).toHaveLength(1);
    });
});
