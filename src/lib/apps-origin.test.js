import { describe, expect, it, vi } from "vitest";
import { APPS_ORIGIN, APP_ORIGINS, TEST_APPS_ORIGIN, frameOrigin, isFromAppFrame, replyToApp, setFrameOrigin } from "./apps-origin.js";

/** An iframe as far as these read it: its window. */
const frame = () => /** @type {any} */ ({ contentWindow: { postMessage: vi.fn() } });

describe("an app frame's origin", () => {
    it("is the apps origin unless set", () => {
        const iframe = frame();
        expect(frameOrigin(iframe)).toBe(APPS_ORIGIN);
        expect(isFromAppFrame(/** @type {any} */ ({ source: iframe.contentWindow, origin: APPS_ORIGIN }), iframe)).toBe(true);
    });

    it("takes messages from the origin it was set to, and only from it", () => {
        const iframe = frame();
        setFrameOrigin(iframe, "https://tests.example");
        const from = (/** @type {string} */ origin) => /** @type {any} */ ({ source: iframe.contentWindow, origin });
        expect(isFromAppFrame(from("https://tests.example"), iframe)).toBe(true);
        expect(isFromAppFrame(from(APPS_ORIGIN), iframe)).toBe(false);
    });

    it("is replied to at the origin it was set to", () => {
        const iframe = frame();
        setFrameOrigin(iframe, "https://tests.example");
        replyToApp(iframe, { type: "x" });
        expect(iframe.contentWindow.postMessage).toHaveBeenCalledWith({ type: "x" }, "https://tests.example");
    });

    it("lists the tests' origin among the apps' origins", () => {
        expect(APP_ORIGINS).toContain(APPS_ORIGIN);
        expect(APP_ORIGINS).toContain(TEST_APPS_ORIGIN);
    });
});
