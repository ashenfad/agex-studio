import { describe, it, expect, vi, afterEach } from "vitest";

import { isOnScreen } from "./presence.js";

function setDoc(visibilityState, focused) {
    vi.stubGlobal("document", {
        visibilityState,
        hasFocus: () => focused,
    });
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("isOnScreen", () => {
    it("is true only when visible AND focused", () => {
        setDoc("visible", true);
        expect(isOnScreen()).toBe(true);
    });

    it("is false when the tab is hidden (tab switch)", () => {
        setDoc("hidden", true);
        expect(isOnScreen()).toBe(false);
    });

    it("is false when visible but unfocused (window/app switch)", () => {
        setDoc("visible", false);
        expect(isOnScreen()).toBe(false);
    });

    it("treats a missing hasFocus() as focused", () => {
        vi.stubGlobal("document", { visibilityState: "visible" });
        expect(isOnScreen()).toBe(true);
    });
});
