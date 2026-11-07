import { describe, expect, it } from "vitest";
import { rejectedPrompt, submittedPrompt } from "./prompts.js";

describe("what the agent is told", () => {
    const page = { site: "reddit.com", page: "pages/3", url: "https://www.reddit.com/", title: "Home", shot: true };

    it("names the page submitted, and its screenshot when there is one", () => {
        const prompt = submittedPrompt(page);
        expect(prompt).toContain("pages/3.json");
        expect(prompt).toContain("pages/3.jpg");
        expect(submittedPrompt({ ...page, shot: false })).not.toContain(".jpg");
    });

    it("carries the person's own words when they ask for a change", () => {
        expect(submittedPrompt(page)).not.toContain("they ask");
        expect(submittedPrompt({ ...page, request: "also hide the sidebar" })).toContain('they ask: "also hide the sidebar"');
    });

    it("carries a rejection's reason", () => {
        expect(rejectedPrompt({ site: "reddit.com", reason: "it hid the comments" })).toContain('"it hid the comments"');
    });
});
