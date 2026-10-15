import { describe, expect, it } from "vitest";
import { looking, onScreen, overall, statusOf } from "./status.js";

/** @param {string} visibilityState @param {boolean} focused */
const doc = (visibilityState, focused) => /** @type {any} */ ({ visibilityState, hasFocus: () => focused });

const idle = { busy: false, folding: false, attention: false, unseen: false };

describe("onScreen and looking", () => {
    it("is on screen only when the tab is visible and its window focused", () => {
        expect(onScreen(doc("visible", true))).toBe(true);
        expect(onScreen(doc("visible", false))).toBe(false);
        expect(onScreen(doc("hidden", false))).toBe(false);
        expect(onScreen(doc("hidden", true))).toBe(false);
    });

    it("looks at a session only when it's the one shown and the page is on screen", () => {
        expect(looking(true, doc("visible", true))).toBe(true);
        expect(looking(false, doc("visible", true))).toBe(false);
        expect(looking(true, doc("hidden", false))).toBe(false);
        expect(looking(true, doc("visible", false))).toBe(false);
    });
});

describe("statusOf", () => {
    it("says nothing for an idle session", () => {
        expect(statusOf(idle)).toBe(null);
    });

    it("puts working first, then attention, then unseen", () => {
        expect(statusOf({ ...idle, busy: true, attention: true, unseen: true })).toBe("working");
        expect(statusOf({ ...idle, folding: true, unseen: true })).toBe("working");
        expect(statusOf({ ...idle, attention: true, unseen: true })).toBe("attention");
        expect(statusOf({ ...idle, unseen: true })).toBe("unseen");
    });
});

describe("overall", () => {
    it("is the most pressing of the sessions'", () => {
        expect(overall([])).toBe(null);
        expect(overall([idle, idle])).toBe(null);
        expect(overall([{ ...idle, unseen: true }, idle])).toBe("unseen");
        expect(overall([{ ...idle, unseen: true }, { ...idle, attention: true, unseen: true }])).toBe("attention");
        expect(overall([{ ...idle, attention: true }, { ...idle, unseen: true }])).toBe("attention");
        expect(overall([{ ...idle, attention: true }, { ...idle, busy: true }])).toBe("working");
    });
});
