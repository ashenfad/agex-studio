import { describe, expect, it } from "vitest";
import { SKILLS, skillsFrom } from "./index.js";

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
        expect(SKILLS.map((s) => s.name)).toEqual(["interactive-app", "media"]);
        for (const skill of SKILLS) expect(skill.files["SKILL.md"]).toMatch(new RegExp(`^---\\nname: ${skill.name}\\n`));
    });
});
