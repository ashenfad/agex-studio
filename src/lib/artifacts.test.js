import { describe, expect, it } from "vitest";
import { artifactsOf, splice, unembedded } from "./artifacts.js";

describe("splice", () => {
    it("splits a reply at its embeds", () => {
        expect(splice("Revenue:\n\n![revenue](/workspace/ui/revenue.plotly.json)\n\nUp 8%.")).toEqual([
            { md: "Revenue:\n\n" },
            { name: "revenue", path: "/workspace/ui/revenue.plotly.json" },
            { md: "\n\nUp 8%." },
        ]);
    });

    it("leaves plain text, links and relative images alone", () => {
        const text = "See [the docs](https://x.test) and ![logo](logo.png).";
        expect(splice(text)).toEqual([{ md: text }]);
    });

    it("leaves embeds in code as written", () => {
        const text = "Use `![x](/workspace/ui/x.png)` like so:\n\n```md\n![y](/workspace/ui/y.png)\n```\n![z](/workspace/ui/z.png)";
        const parts = splice(text);
        expect(parts.filter((p) => "path" in p)).toEqual([{ name: "z", path: "/workspace/ui/z.png" }]);
        expect(parts.map((p) => ("md" in p ? p.md : `<${p.name}>`)).join("")).toBe(text.replace("![z](/workspace/ui/z.png)", "<z>"));
    });

    it("treats an unclosed fence as code to the end", () => {
        expect(splice("```\n![x](/workspace/ui/x.png)")).toEqual([{ md: "```\n![x](/workspace/ui/x.png)" }]);
    });
});

describe("artifactsOf and unembedded", () => {
    const results = [
        { content: "hi\n[ui artifacts: a -> /workspace/ui/a.plotly.json, b -> /workspace/ui/b.table.json]" },
        { content: "no note here" },
        { content: "[ui artifacts: a -> /workspace/ui/a.plotly.json, c -> /workspace/ui/c.cards.json]\n[ui note: x]" },
    ];

    it("reads the artifacts the results name, each path once, latest last", () => {
        expect(artifactsOf(results)).toEqual([
            { name: "b", path: "/workspace/ui/b.table.json" },
            { name: "a", path: "/workspace/ui/a.plotly.json" },
            { name: "c", path: "/workspace/ui/c.cards.json" },
        ]);
    });

    it("keeps the ones the reply doesn't embed", () => {
        const texts = ["Here: ![a](/workspace/ui/a.plotly.json)", "and `![c](/workspace/ui/c.cards.json)` in code"];
        expect(unembedded(artifactsOf(results), texts).map((a) => a.name)).toEqual(["b", "c"]);
    });
});
