import { describe, expect, it } from "vitest";
import { PROTOCOL } from "./protocol.js";
import { servePort } from "./port.js";

/** A port double: what the studio sends goes to its listener, and what
 *  the extension posts is kept. */
function fakePort(origin = "https://agex.studio") {
    /** @type {((msg: unknown) => unknown)[]} */
    const listeners = [];
    const port = {
        sender: { origin },
        posted: /** @type {any[]} */ ([]),
        disconnected: false,
        onMessage: { addListener: (/** @type {any} */ f) => listeners.push(f) },
        postMessage(/** @type {unknown} */ m) {
            if (this.disconnected) throw new Error("Attempting to use a disconnected port object");
            this.posted.push(m);
        },
        disconnect() {
            this.disconnected = true;
        },
        /** the studio sends; resolves once the extension has answered */
        async send(/** @type {unknown} */ msg) {
            await Promise.all(listeners.map((f) => f(msg)));
            return this.posted.at(-1);
        },
    };
    return port;
}

const serve = (port, ops = {}) =>
    servePort(/** @type {any} */ (port), { allows: (o) => o === "https://agex.studio", ops, version: "1.2.3" });

describe("servePort", () => {
    it("disconnects a port from an origin it doesn't answer", () => {
        const port = fakePort("https://evil.example");
        expect(serve(port)).toBe(false);
        expect(port.disconnected).toBe(true);
    });

    it("answers hello with its protocol and version", async () => {
        const port = fakePort();
        serve(port);
        expect(await port.send({ id: 1, op: "hello", protocol: PROTOCOL })).toEqual({ id: 1, value: { protocol: PROTOCOL, version: "1.2.3" } });
    });

    it("refuses another protocol's hello, and closes the port", async () => {
        const port = fakePort();
        serve(port);
        const reply = await port.send({ id: 1, op: "hello", protocol: PROTOCOL + 1 });
        expect(reply.error.code).toBe("protocol");
        expect(port.disconnected).toBe(true);
    });

    it("refuses an op before hello", async () => {
        const port = fakePort();
        serve(port, { ping: () => "pong" });
        expect((await port.send({ id: 1, op: "ping" })).error.code).toBe("hello-first");
    });

    it("dispatches to an op after hello, its value the reply's", async () => {
        const port = fakePort();
        serve(port, { echo: async (req) => req.text });
        await port.send({ id: 1, op: "hello", protocol: PROTOCOL });
        expect(await port.send({ id: 2, op: "echo", text: "hi" })).toEqual({ id: 2, value: "hi" });
    });

    it("says an op it doesn't have, or one inherited from Object, is unknown", async () => {
        const port = fakePort();
        serve(port);
        await port.send({ id: 1, op: "hello", protocol: PROTOCOL });
        expect((await port.send({ id: 2, op: "nope" })).error.code).toBe("unknown-op");
        expect((await port.send({ id: 3, op: "toString" })).error.code).toBe("unknown-op");
    });

    it("answers an op that throws with its message", async () => {
        const port = fakePort();
        serve(port, {
            boom: () => {
                throw new Error("no such tab");
            },
        });
        await port.send({ id: 1, op: "hello", protocol: PROTOCOL });
        expect(await port.send({ id: 2, op: "boom" })).toEqual({ id: 2, error: { code: "failed", message: "no such tab" } });
    });

    it("refuses a malformed request, with its id when it has one", async () => {
        const port = fakePort();
        serve(port);
        expect((await port.send({ id: 4 })).error.code).toBe("bad-request");
        expect((await port.send({ id: 4 })).id).toBe(4);
        expect((await port.send("hello")).id).toBe(null);
    });

    it("drops a reply when the port closed while the op ran", async () => {
        const port = fakePort();
        serve(port, {
            slow: async () => {
                port.disconnect();
                return 1;
            },
        });
        await port.send({ id: 1, op: "hello", protocol: PROTOCOL });
        await expect(port.send({ id: 2, op: "slow" })).resolves.toBeDefined();
    });
});
