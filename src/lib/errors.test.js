import { describe, expect, it } from "vitest";
import { errorText } from "./errors.js";

describe("errorText", () => {
    it("is an error's message", () => {
        expect(errorText(new TypeError("no such file"))).toBe("no such file");
    });

    it("is anything else thrown, as a string", () => {
        expect(errorText("refused")).toBe("refused");
        expect(errorText(404)).toBe("404");
        expect(errorText(undefined)).toBe("undefined");
    });
});
