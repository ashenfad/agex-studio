/**
 * One port from the studio, served: its origin checked, `hello` first,
 * then each request dispatched to its op and answered once.
 */

import { PROTOCOL, ProtocolError, checkRequest } from "./protocol.js";

/**
 * @typedef {(args: import("./protocol.js").Request, port: chrome.runtime.Port) => unknown} Op
 *   An op's handler: its value is the reply's (awaited), what it throws
 *   the reply's error.
 */

/**
 * Serve `port`, or disconnect it at once if its sender's origin isn't
 * one the extension answers.
 *
 * @param {chrome.runtime.Port} port
 * @param {{ allows: (origin: string | undefined) => boolean, ops: Record<string, Op>, version: string }} opts
 * @returns {boolean} whether the port is served
 */
export function servePort(port, { allows, ops, version }) {
    if (!allows(port.sender?.origin)) {
        port.disconnect();
        return false;
    }
    let greeted = false;
    port.onMessage.addListener(async (/** @type {unknown} */ msg) => {
        const id = typeof msg === "object" && msg !== null && Number.isInteger(/** @type {{ id?: unknown }} */ (msg).id)
            ? /** @type {{ id: number }} */ (msg).id
            : null;
        try {
            const req = checkRequest(msg);
            let value;
            if (req.op === "hello") {
                if (req.protocol !== PROTOCOL) {
                    reply(port, { id, error: { code: "protocol", message: `the extension speaks protocol ${PROTOCOL}, the studio ${String(req.protocol)}: update the older one` } });
                    port.disconnect();
                    return;
                }
                greeted = true;
                value = /** @type {import("./protocol.js").Hello} */ ({ protocol: PROTOCOL, version });
            } else if (!greeted) {
                throw new ProtocolError("hello-first", "say hello first, with the protocol's version");
            } else if (Object.hasOwn(ops, req.op)) {
                value = await ops[req.op](req, port);
            } else {
                throw new ProtocolError("unknown-op", `no op "${req.op}"`);
            }
            reply(port, { id: req.id, value: value ?? null });
        } catch (e) {
            const code = e instanceof ProtocolError ? e.code : "failed";
            reply(port, { id, error: { code, message: e instanceof Error ? e.message : String(e) } });
        }
    });
    return true;
}

/** A reply posted, unless the studio has gone meanwhile.
 *  @param {chrome.runtime.Port} port @param {{ id: number | null, value?: unknown, error?: import("./protocol.js").ReplyError }} msg */
function reply(port, msg) {
    try {
        port.postMessage(msg);
    } catch {
        // the port closed while the op ran: nobody to answer
    }
}
