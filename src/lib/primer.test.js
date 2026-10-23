import { describe, expect, it } from "vitest";
import { primer } from "./primer.js";
import { DEFAULTS } from "./settings.js";

describe("primer", () => {
    it("offers web and media on an OpenRouter key, and pdf always", () => {
        const text = primer({ ...DEFAULTS, routerKey: "sk-test" });
        expect(text).toContain("await web.search(query)");
        expect(text).toContain("media.image({ prompt, path })");
        expect(text).toContain("await pdf.pages(path)");
        expect(text).not.toContain("no OpenRouter key");
        expect(text).not.toContain("takes no images");
    });

    it("tells the agent to link a file by its workspace path", () => {
        expect(primer(DEFAULTS)).toContain("[the plan](/workspace/notes/plan.md)");
    });

    it("points the agent at the delegation skill before it splits work", () => {
        expect(primer(DEFAULTS)).toContain("read the delegation skill");
    });

    it("tells the agent it can draw a diagram in a mermaid block", () => {
        expect(primer(DEFAULTS)).toContain("```mermaid block in your reply");
    });

    it("says web and media can't run without a key, and what to do without vision", () => {
        const text = primer({ ...DEFAULTS, accessMode: "custom", endpointKey: "k", vision: false });
        expect(text).not.toContain("await web.search");
        expect(text).toContain("the settings hold no OpenRouter key");
        expect(text).toContain("await pdf.pages(path)");
        expect(text).toContain("takes no images");
    });

    it("offers web and media beside a model of the person's own, given an OpenRouter key", () => {
        const text = primer({ ...DEFAULTS, accessMode: "custom", baseUrl: "http://localhost:3456", routerKey: "sk-or-k" });
        expect(text).toContain("await web.search");
        expect(text).not.toContain("the settings hold no OpenRouter key");
    });
});
