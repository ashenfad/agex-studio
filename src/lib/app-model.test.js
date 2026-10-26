import { describe, expect, it } from "vitest";
import { cancelModel, cancelModels, modelFailure, relayModel } from "./app-model.js";

/** A frame whose page records what the studio posts to it. */
function frame() {
    /** @type {any[]} */
    const posted = [];
    const iframe = /** @type {any} */ ({ contentWindow: { postMessage: (/** @type {any} */ msg) => posted.push(msg) } });
    return { iframe, posted };
}

/** A runner that streams a delta, then waits for its signal or `go`.
 *  @returns {{ run: import("./app-model.js").ModelRunner, go: () => void, calls: any[] }} */
function held() {
    let go = () => {};
    /** @type {any[]} */
    const calls = [];
    return {
        calls,
        go: () => go(),
        run: async (call, { signal, onEvent }) => {
            calls.push(call);
            onEvent({ kind: "TextDelta", text: "he" });
            await new Promise((resolve, reject) => {
                go = () => resolve(undefined);
                signal.addEventListener("abort", () => reject(Object.assign(new Error("the request was cancelled"), { name: "AbortError" })));
            });
            onEvent({ kind: "Reply", message: /** @type {any} */ ({ id: "r", role: "assistant", parts: [] }) });
        },
    };
}

describe("an app's model call, relayed", () => {
    it("posts each event, then the end", async () => {
        const { iframe, posted } = frame();
        const r = held();
        const done = relayModel(iframe, { id: "a", messages: [1], tools: [], settings: {} }, r.run);
        expect(r.calls).toEqual([{ messages: [1], tools: [], settings: {} }]);
        r.go();
        await done;
        expect(posted.map((m) => [m.type, m.id, m.event?.kind ?? null])).toEqual([
            ["agex-model-event", "a", "TextDelta"],
            ["agex-model-event", "a", "Reply"],
            ["agex-model-end", "a", null],
        ]);
        expect(posted.at(-1).error).toBeNull();
    });

    it("stops a call its app cancels, or every call of a page that went", async () => {
        const { iframe, posted } = frame();
        const one = held();
        const cancelled = relayModel(iframe, { id: "c1" }, one.run);
        cancelModel(iframe, "c1");
        await cancelled;
        expect(posted.at(-1)).toEqual({ type: "agex-model-end", id: "c1", error: { name: "AbortError", message: "the request was cancelled", transient: false, describe: null } });

        const two = held();
        const three = held();
        const both = Promise.all([relayModel(iframe, { id: "c2" }, two.run), relayModel(iframe, { id: "c3" }, three.run)]);
        cancelModels(iframe);
        await both;
        expect(posted.filter((m) => m.type === "agex-model-end").map((m) => [m.id, m.error?.name])).toEqual([
            ["c1", "AbortError"],
            ["c2", "AbortError"],
            ["c3", "AbortError"],
        ]);
    });

    it("ends with the failure as data, the provider's judgment with it, or says there is no model here", async () => {
        const { iframe, posted } = frame();
        const failure = Object.assign(new Error("overloaded"), { transient: true, description: "the model provider failed (529): overloaded" });
        await relayModel(iframe, { id: "f" }, async () => {
            throw failure;
        });
        expect(posted.at(-1).error).toEqual({ name: "Error", message: "overloaded", transient: true, describe: "the model provider failed (529): overloaded" });
        await relayModel(iframe, { id: "n" }, null);
        expect(posted.at(-1)).toEqual({ type: "agex-model-end", id: "n", error: { name: "Error", message: "agex.model isn't available here", transient: false, describe: null } });
        expect(modelFailure("plain")).toEqual({ name: "Error", message: "plain", transient: false, describe: null });
    });
});
