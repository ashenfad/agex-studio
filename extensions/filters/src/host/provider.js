/**
 * The model, across the sandbox's wall. The agent's loop runs in the
 * sandbox, but the person's key never goes there: the sandbox's provider
 * is a stand-in that forwards each request to the offscreen document,
 * which holds the settings, builds the real provider and streams its
 * events back. Whether a failure is worth resuming, and how to say it,
 * are decided where the real provider is, and travel with the error.
 *
 * The wire, one stream per id: `{ id, stream: { messages, tools, settings } }`
 * out, `{ id, event }` back for each event, then `{ id, end: true }` or
 * `{ id, error: { message, transient, described } }`; `{ id, abort: true }`
 * out stops it.
 */

/** An error from the real provider, as it crossed. */
export class RemoteModelError extends Error {
    /** @param {{ message: string, transient: boolean, described: string | null }} e */
    constructor({ message, transient, described }) {
        super(message);
        this.name = "RemoteModelError";
        this.transient = transient;
        this.described = described;
    }
}

/**
 * The sandbox's provider: `send` posts to the offscreen document, and
 * `listen(id, f)` hands `f` each message back for that stream, returning
 * a function that stops listening.
 *
 * @param {string} name the model's name, for the run record
 * @param {{ send: (msg: Record<string, unknown>) => void, listen: (id: string, f: (msg: any) => void) => () => void, nextId: () => string }} channel
 * @returns {import("agex-ts").Provider}
 */
export function remoteProvider(name, channel) {
    return {
        name,
        stream(messages, tools, settings, opts) {
            return {
                [Symbol.asyncIterator]() {
                    const id = channel.nextId();
                    /** @type {any[]} */
                    const queue = [];
                    /** @type {((v: void) => void) | null} */
                    let wake = null;
                    const stop = channel.listen(id, (msg) => {
                        queue.push(msg);
                        wake?.();
                    });
                    const abort = () => channel.send({ id, abort: true });
                    opts?.signal?.addEventListener("abort", abort, { once: true });
                    channel.send({ id, stream: { messages, tools, settings } });
                    const done = () => {
                        stop();
                        opts?.signal?.removeEventListener("abort", abort);
                    };
                    return {
                        async next() {
                            while (queue.length === 0) await new Promise((ok) => (wake = ok));
                            wake = null;
                            const msg = queue.shift();
                            if (msg.end) {
                                done();
                                return { done: true, value: undefined };
                            }
                            if (msg.error) {
                                done();
                                throw new RemoteModelError(msg.error);
                            }
                            return { done: false, value: msg.event };
                        },
                        async return() {
                            abort();
                            done();
                            return { done: true, value: undefined };
                        },
                    };
                },
            };
        },
        transient: (error) => error instanceof RemoteModelError && error.transient,
        describe: (error) => (error instanceof RemoteModelError ? error.described : null),
    };
}

/**
 * The offscreen document's side of one stream: run it on `provider`,
 * posting each event with `send`. Returns the function that aborts it.
 *
 * @param {import("agex-ts").Provider} provider
 * @param {{ id: string, stream: { messages: any, tools: any, settings: any } }} msg
 * @param {(msg: Record<string, unknown>) => void} send
 */
export function serveStream(provider, { id, stream }, send) {
    const controller = new AbortController();
    void (async () => {
        try {
            for await (const event of provider.stream(stream.messages, stream.tools, stream.settings, { signal: controller.signal })) {
                send({ id, event });
            }
            send({ id, end: true });
        } catch (e) {
            send({ id, error: { message: String(/** @type {Error} */ (e)?.message ?? e), transient: provider.transient(e), described: provider.describe?.(e) ?? null } });
        }
    })();
    return () => controller.abort();
}
