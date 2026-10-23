import { describe, expect, it } from "vitest";
import { SKILLS, readmeFiles, skillsFrom } from "./index.js";

describe("the studio's skills", () => {
    it("are one per directory, with the files beside SKILL.md", () => {
        const skills = skillsFrom({
            "./video/SKILL.md": "---\nname: video\n---",
            "./video/references/scene.js": "export default 1",
            "./media/SKILL.md": "m",
        });
        expect(skills).toEqual([
            { name: "media", files: { "SKILL.md": "m" } },
            { name: "video", files: { "SKILL.md": "---\nname: video\n---", "references/scene.js": "export default 1" } },
        ]);
    });

    it("are found in this directory, each with its SKILL.md", () => {
        expect(SKILLS.map((s) => s.name)).toEqual(["agex-ecosystem", "delegation", "interactive-app", "making-videos", "media", "pixel-art"]);
        for (const skill of SKILLS) expect(skill.files["SKILL.md"]).toMatch(new RegExp(`^---\\nname: ${skill.name}\\n`));
    });

    it("carry the studio's and each package's README in agex-ecosystem, versioned", () => {
        expect(readmeFiles({ "@agex-ts/world": { version: "1.2.3", readme: "# world" } })).toEqual({
            "./agex-ecosystem/references/world.md": "<!-- @agex-ts/world 1.2.3 -->\n# world",
        });
        const files = /** @type {Record<string, string>} */ (SKILLS.find((s) => s.name === "agex-ecosystem")?.files);
        expect(Object.keys(files).sort()).toEqual([
            "SKILL.md",
            "references/agex-studio.md",
            "references/agex-ts.md",
            "references/kvgit.md",
            "references/kvsql.md",
            "references/termish.md",
            "references/world.md",
        ]);
        expect(files["references/kvgit.md"]).toMatch(/^<!-- @agex-ts\/kvgit \d+\.\d+\.\d+ -->\n/);
    });
});
