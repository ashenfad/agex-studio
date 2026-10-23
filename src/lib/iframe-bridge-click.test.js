// @vitest-environment jsdom

/**
 * A `click` action dispatches a mouse's events rather than calling
 * `el.click()`; a dispatched click still does what a click does. jsdom
 * runs the activation behavior a browser does (a submit button's form,
 * a checkbox, a label's control, a link) and knows a disabled fieldset,
 * which happy-dom doesn't, so these run here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { dispatchAction } from "./iframe-bridge.js";

beforeEach(() => {
    document.body.innerHTML = "";
});

describe("a click action, as a click", () => {
    it("submits a button's form", async () => {
        document.body.innerHTML = '<form id="f"><input name="q" value="x"><button id="send">Send</button></form>';
        const submitted = vi.fn((e) => e.preventDefault());
        document.getElementById("f").addEventListener("submit", submitted);
        await dispatchAction(document, { click: "#send" });
        expect(submitted).toHaveBeenCalledOnce();
    });

    it("toggles a checkbox, and a label clicks its control", async () => {
        document.body.innerHTML = '<input type="checkbox" id="c"><label for="c" id="l">Agree</label>';
        const box = /** @type {HTMLInputElement} */ (document.getElementById("c"));
        const changes = vi.fn();
        box.addEventListener("change", changes);
        await dispatchAction(document, { click: "#c" });
        expect(box.checked).toBe(true);
        await dispatchAction(document, { click: "#l" });
        expect(box.checked).toBe(false);
        expect(changes).toHaveBeenCalledTimes(2);
    });

    it("follows a link, and a cancelled click doesn't", async () => {
        document.body.innerHTML = '<a id="a" href="#section">go</a><a id="b" href="#other">stay</a>';
        document.getElementById("b").addEventListener("click", (e) => e.preventDefault());
        const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
        await dispatchAction(document, { click: "#a" });
        await settle();
        expect(location.hash).toBe("#section");
        await dispatchAction(document, { click: "#b" });
        await settle();
        expect(location.hash).toBe("#section");
    });

    it("runs a button's handler, once", async () => {
        document.body.innerHTML = '<button id="inc">0</button>';
        const button = document.getElementById("inc");
        button.addEventListener("click", () => (button.textContent = String(Number(button.textContent) + 1)));
        await dispatchAction(document, { click: "#inc" });
        await dispatchAction(document, { click: "#inc" });
        expect(button.textContent).toBe("2");
    });

    it("fails on a control in a disabled fieldset", async () => {
        document.body.innerHTML = '<form><fieldset disabled><button id="launch">Launch</button></fieldset></form>';
        const clicked = vi.fn();
        document.getElementById("launch").addEventListener("click", clicked);
        await expect(dispatchAction(document, { click: "#launch" })).rejects.toThrow(
            /^ActionError: click "#launch": the element is disabled/,
        );
        expect(clicked).not.toHaveBeenCalled();
    });
});
