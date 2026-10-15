// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from "vitest";
import { APPS_ORIGIN } from "./apps-origin.js";
import { installControlBridge } from "./iframe-bridge.js";
import { CONTROL_TIMEOUT_MS, pageGone, pageLoaded, sendControl } from "./send-control.js";

afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
});

/** A message from `source` at `origin` (the apps origin unless said),
 *  dispatched on the studio's window. */
function reply(data, source, origin = APPS_ORIGIN) {
    window.dispatchEvent(new MessageEvent("message", { data, source, origin }));
}

/**
 * A mock iframe whose postMessage drives `responseFn`, which decides
 * what to dispatch back on `window`: each `{ data, source?, origin? }`
 * defaults to the frame's window at the apps origin.
 */
function makeMockIframe(responseFn) {
    const iframe = { contentWindow: { postMessage: null } };
    iframe.contentWindow.postMessage = vi.fn((msg, _origin) => {
        queueMicrotask(() => {
            const responses = responseFn(msg);
            const list = Array.isArray(responses) ? responses : [responses];
            for (const { data, source, origin } of list) {
                if (data === undefined) continue;
                reply(data, source || iframe.contentWindow, origin);
            }
        });
    });
    return iframe;
}

const result = (msg, data) => ({ data: { type: "agex-control-result", id: msg.id, data, error: null } });

describe("sendControl", () => {
    it("posts an agex-control message to the apps origin and resolves with the response's data", async () => {
        const iframe = makeMockIframe((msg) => result(msg, { ok: true, echo: msg.action }));
        const out = await sendControl(iframe, { click: "#x" });
        expect(iframe.contentWindow.postMessage).toHaveBeenCalledOnce();
        const [posted, origin] = iframe.contentWindow.postMessage.mock.calls[0];
        expect(origin).toBe(APPS_ORIGIN);
        expect(posted).toMatchObject({ type: "agex-control", action: { click: "#x" } });
        expect(posted.id).toMatch(/^ctrl-/);
        expect(out).toEqual({ ok: true, echo: { click: "#x" } });
    });

    it("rejects when the response has an error field", async () => {
        const iframe = makeMockIframe((msg) => ({ data: { type: "agex-control-result", id: msg.id, data: null, error: "boom" } }));
        await expect(sendControl(iframe, { click: "#x" })).rejects.toThrow("boom");
    });

    it("ignores responses with a mismatched id", async () => {
        const iframe = makeMockIframe((msg) => [
            { data: { type: "agex-control-result", id: "stale-id", data: "stale", error: null } },
            result(msg, "real"),
        ]);
        expect(await sendControl(iframe, { click: "#x" })).toBe("real");
    });

    it("ignores messages from other windows, or from the frame at another origin", async () => {
        const iframe = makeMockIframe((msg) => [
            { ...result(msg, "wrong-source"), source: { iAmNot: "the iframe" } },
            { ...result(msg, "wrong-origin"), origin: "https://evil.example" },
            result(msg, "correct"),
        ]);
        expect(await sendControl(iframe, { click: "#x" })).toBe("correct");
    });

    it("ignores non-result messages during the wait", async () => {
        const iframe = makeMockIframe((msg) => [{ data: { type: "agex-cache-get", id: "irrelevant" } }, result(msg, "done")]);
        expect(await sendControl(iframe, { click: "#x" })).toBe("done");
    });

    it("allows concurrent calls with independent id tracking", async () => {
        const iframe = makeMockIframe((msg) => result(msg, `result-for-${msg.action.tag}`));
        const [a, b] = await Promise.all([sendControl(iframe, { tag: "A" }), sendControl(iframe, { tag: "B" })]);
        expect(a).toBe("result-for-A");
        expect(b).toBe("result-for-B");
    });

    it("rejects at once when the frame is gone", async () => {
        await expect(sendControl({ contentWindow: null }, { click: "#x" })).rejects.toThrow(/frame is gone/);
    });

    it("gives up with a TimeoutError when the page never answers, and stops listening", async () => {
        vi.useFakeTimers();
        const removed = [];
        const iframe = {
            contentWindow: { postMessage: () => {} },
            addEventListener: () => {},
            removeEventListener: (type) => removed.push(type),
        };
        const p = sendControl(iframe, { eval: "new Promise(() => {})" });
        const settled = expect(p).rejects.toThrow(/^TimeoutError: .*within 30s/);
        vi.advanceTimersByTime(CONTROL_TIMEOUT_MS - 1);
        await Promise.resolve();
        vi.advanceTimersByTime(1);
        await settled;
        expect(removed).toContain("load");
    });

    it("takes a shorter timeout when asked", async () => {
        vi.useFakeTimers();
        const p = sendControl({ contentWindow: { postMessage: () => {} } }, { "get-logs": true }, { timeoutMs: 5000 });
        const settled = expect(p).rejects.toThrow(/^TimeoutError: .*within 5s/);
        vi.advanceTimersByTime(5000);
        await settled;
    });
});

describe("sendControl — navigation", () => {
    /** A frame double whose `load` listener the test can fire. */
    function frame() {
        const f = {
            load: /** @type {(() => void) | null} */ (null),
            contentWindow: { postMessage: () => {} },
            addEventListener: (type, fn) => {
                if (type === "load") f.load = fn;
            },
            removeEventListener: () => {},
        };
        return f;
    }

    it("rejects with NavigationError when the iframe (re)loads mid-action, and later calls at once", async () => {
        const iframe = frame();
        const p = sendControl(iframe, { eval: "location.reload()" });
        iframe.load();
        await expect(p).rejects.toThrow(/^NavigationError:/);
        await expect(sendControl(iframe, { "get-logs": true })).rejects.toThrow(/^NavigationError: the app already navigated/);
    });

    it("rejects at once when the page went between actions", async () => {
        const iframe = frame();
        let sent = 0;
        iframe.contentWindow.postMessage = () => void sent++;
        pageGone(iframe);
        await expect(sendControl(iframe, { eval: "1 + 1" })).rejects.toThrow(/^NavigationError: the app already navigated/);
        expect(sent).toBe(0);
    });

    it("takes actions again once the frame has a page again", async () => {
        const iframe = frame();
        const p = sendControl(iframe, { eval: "location.reload()" });
        iframe.load();
        await expect(p).rejects.toThrow(/^NavigationError:/);

        pageLoaded(iframe);
        iframe.contentWindow.postMessage = (msg) => queueMicrotask(() => reply(result(msg, "back").data, iframe.contentWindow));
        expect(await sendControl(iframe, { read: "#x" })).toBe("back");
    });
});

describe("sendControl + installControlBridge round-trip", () => {
    /** A frame whose window runs the real bridge, its parent the studio
     *  at `parentOrigin` (unset: the bootloader never said). */
    function bridgedFrame(parentOrigin) {
        let bridgeHandler = null;
        const iframeWin = {
            document,
            __AGEX_PARENT_ORIGIN: parentOrigin,
            addEventListener: (type, fn) => {
                if (type === "message") bridgeHandler = fn;
            },
        };
        installControlBridge(iframeWin);
        const iframe = {
            contentWindow: {
                postMessage: (msg, targetOrigin) => {
                    // the bridge's answer goes back to the studio, from the apps origin
                    const parent = {
                        postMessage: (response, origin) => {
                            if (origin === parentOrigin) reply(response, iframe.contentWindow);
                        },
                    };
                    if (targetOrigin === APPS_ORIGIN) bridgeHandler({ data: msg, source: parent, origin: window.location.origin });
                },
            },
        };
        return iframe;
    }

    it("completes a read action end-to-end", async () => {
        document.body.innerHTML = '<span id="s">answer</span>';
        const iframe = bridgedFrame(window.location.origin);
        expect(await sendControl(iframe, { read: "#s" })).toEqual({ type: "read", selector: "#s", value: "answer" });
    });

    it("completes a click action end-to-end (null result payload)", async () => {
        document.body.innerHTML = '<button id="b">b</button>';
        const clickSpy = vi.spyOn(document.getElementById("b"), "click");
        const iframe = bridgedFrame(window.location.origin);
        expect(await sendControl(iframe, { click: "#b" })).toBeNull();
        expect(clickSpy).toHaveBeenCalledOnce();
    });

    it("gets no answer from a page that doesn't know its parent's origin", async () => {
        vi.useFakeTimers();
        document.body.innerHTML = '<button id="b">b</button>';
        const clickSpy = vi.spyOn(document.getElementById("b"), "click");
        const iframe = bridgedFrame(undefined);
        const p = sendControl(iframe, { click: "#b" }, { timeoutMs: 1000 });
        const settled = expect(p).rejects.toThrow(/^TimeoutError:/);
        await vi.advanceTimersByTimeAsync(1000);
        await settled;
        expect(clickSpy).not.toHaveBeenCalled();
    });
});
