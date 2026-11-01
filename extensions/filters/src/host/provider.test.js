import { describe, expect, it } from "vitest";
import { RemoteModelError, remoteProvider, serveStream } from "./provider.js";

/** Both sides of the wall in one place: what the stand-in sends is served
 *  at once by `real`, and what comes back is handed to the stream's listener. */
function wall(real) {
    /** @type {Map<string, (msg: any) => void>} */
    const listeners = new Map();
    /** @type {Map<string, () => void>} */
    const aborts = new Map();
    let n = 0;
    const back = (/** @type {any} */ msg) => queueMicrotask(() => listeners.get(msg.id)?.(msg));
    const channel = {
        send: (/** @type {any} */ msg) => {
            if (msg.abort) aborts.get(msg.id)?.();
            else aborts.set(msg.id, serveStream(real, msg, back));
        },
        listen: (/** @type {string} */ id, /** @type {(msg: any) => void} */ f) => {
            listeners.set(id, f);
            return () => void listeners.delete(id);
        },
        nextId: () => `m${++n}`,
    };
    return remoteProvider("test-model", channel);
}

const collect = async (/** @type {AsyncIterable<any>} */ it) => {
    const out = [];
    for await (const x of it) out.push(x);
    return out;
};

describe("the model across the sandbox's wall", () => {
    it("streams the real provider's events in order", async () => {
        const real = {
            name: "real",
            async *stream() {
                yield { kind: "TextDelta", text: "he" };
                yield { kind: "TextDelta", text: "llo" };
            },
            transient: () => false,
        };
        const stand = wall(/** @type {any} */ (real));
        expect(stand.name).toBe("test-model");
        expect(await collect(stand.stream([], [], {}))).toEqual([{ kind: "TextDelta", text: "he" }, { kind: "TextDelta", text: "llo" }]);
    });

    it("brings a failure back with whether it's worth resuming, and its words", async () => {
        const real = {
            name: "real",
            // eslint-disable-next-line require-yield
            async *stream() {
                throw new Error("overloaded");
            },
            transient: () => true,
            describe: () => "The provider is overloaded.",
        };
        const stand = wall(/** @type {any} */ (real));
        const err = await collect(stand.stream([], [], {})).catch((e) => e);
        expect(err).toBeInstanceOf(RemoteModelError);
        expect(stand.transient(err)).toBe(true);
        expect(stand.describe?.(err)).toBe("The provider is overloaded.");
        expect(stand.transient(new Error("other"))).toBe(false);
    });

    it("stops the real stream when the turn aborts", async () => {
        let stopped = false;
        const real = {
            name: "real",
            async *stream(/** @type {any} */ _m, /** @type {any} */ _t, /** @type {any} */ _s, /** @type {any} */ opts) {
                yield { kind: "TextDelta", text: "a" };
                await new Promise((ok) => opts.signal.addEventListener("abort", ok));
                stopped = true;
            },
            transient: () => false,
        };
        const controller = new AbortController();
        const it = wall(/** @type {any} */ (real)).stream([], [], {}, { signal: controller.signal })[Symbol.asyncIterator]();
        expect((await it.next()).value).toEqual({ kind: "TextDelta", text: "a" });
        controller.abort();
        await new Promise((ok) => setTimeout(ok, 0));
        expect(stopped).toBe(true);
    });
});
