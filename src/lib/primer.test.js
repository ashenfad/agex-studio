import { describe, expect, it } from "vitest";
import { primer } from "./primer.js";
import { DEFAULTS } from "./settings.js";

describe("primer", () => {
    it("offers web and media on an OpenRouter key, and pdf always", () => {
        const text = primer({ ...DEFAULTS, apiKey: "sk-test" });
        expect(text).toContain("await web.search(query)");
        expect(text).toContain("media.image({ prompt, path })");
        expect(text).toContain("await pdf.pages(path)");
        expect(text).not.toContain("no OpenRouter key");
        expect(text).not.toContain("takes no images");
    });

    it("says web and media can't run without a key, and what to do without vision", () => {
        const text = primer({ ...DEFAULTS, accessMode: "custom", apiKey: "k", vision: false });
        expect(text).not.toContain("await web.search");
        expect(text).toContain("the settings hold no OpenRouter key");
        expect(text).toContain("await pdf.pages(path)");
        expect(text).toContain("takes no images");
    });
});
