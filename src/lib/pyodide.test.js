import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock Worker
class MockWorker {
    constructor(url) {
        MockWorker.instances.push(this);
        this.url = url;
        this.posted = [];
        this.onmessage = null;
        this.onerror = null;
    }
    postMessage(msg) {
        this.posted.push(msg);
    }
    _receive(data) {
        this.onmessage?.({ data });
    }
}
MockWorker.instances = [];

vi.stubGlobal("Worker", MockWorker);
vi.stubGlobal("window", {
    location: { href: "http://localhost:5173/" },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
});

beforeEach(() => {
    MockWorker.instances = [];
    vi.resetModules();
});

async function loadPyodide() {
    return await import("./pyodide.js");
}

describe("pyodideStore", () => {
    it("starts in idle state", async () => {
        const { pyodideStore } = await loadPyodide();
        let state;
        const unsub = pyodideStore.subscribe((s) => {
            state = s;
        });
        expect(state.status).toBe("idle");
        unsub();
    });
});

describe("startWorker", () => {
    it("transitions to loading and sends init message", async () => {
        const { pyodideStore, startWorker } = await loadPyodide();
        const states = [];
        pyodideStore.subscribe((s) => states.push({ ...s }));

        startWorker();

        expect(states.at(-1).status).toBe("loading");
        expect(MockWorker.instances).toHaveLength(1);
        const w = MockWorker.instances[0];
        expect(w.posted).toHaveLength(1);
        expect(w.posted[0].type).toBe("init");
    });

    it("transitions to ready on ready message", async () => {
        const { pyodideStore, startWorker } = await loadPyodide();
        let state;
        pyodideStore.subscribe((s) => {
            state = s;
        });

        startWorker();
        MockWorker.instances[0]._receive({ type: "ready" });

        expect(state.status).toBe("ready");
        expect(state.progress).toBe(1);
    });

    it("transitions to error on init-error message", async () => {
        const { pyodideStore, startWorker } = await loadPyodide();
        let state;
        pyodideStore.subscribe((s) => {
            state = s;
        });

        startWorker();
        MockWorker.instances[0]._receive({
            type: "init-error",
            message: "boom",
        });

        expect(state.status).toBe("error");
        expect(state.message).toContain("boom");
    });

    it("is a no-op if already loading", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        startWorker();
        expect(MockWorker.instances).toHaveLength(1);
    });
});

describe("runPython", () => {
    it("rejects when not ready", async () => {
        const { runPython } = await loadPyodide();
        await expect(runPython("1+1")).rejects.toThrow("Pyodide not ready");
    });

    it("sends code and resolves on result", async () => {
        const { startWorker, runPython } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const promise = runPython("1+1");
        const runMsg = w.posted.find((m) => m.type === "run");
        expect(runMsg).toBeDefined();
        expect(runMsg.code).toBe("1+1");

        w._receive({ type: "result", id: runMsg.id, value: "2" });
        const result = await promise;
        expect(result).toBe("2");
    });

    it("rejects on run-error", async () => {
        const { startWorker, runPython } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const promise = runPython("bad code");
        const runMsg = w.posted.find((m) => m.type === "run");
        w._receive({
            type: "run-error",
            id: runMsg.id,
            message: "SyntaxError",
        });

        await expect(promise).rejects.toThrow("SyntaxError");
    });
});

describe("runPythonStreaming", () => {
    it("rejects when not ready", async () => {
        const { runPythonStreaming } = await loadPyodide();
        await expect(runPythonStreaming("1+1", () => {})).rejects.toThrow(
            "Pyodide not ready"
        );
    });

    it("injects _run_id and resolves on result", async () => {
        const { startWorker, runPythonStreaming } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const promise = runPythonStreaming("print(_run_id)", () => {});
        const runMsg = w.posted.find((m) => m.type === "run");
        expect(runMsg.code).toContain("_run_id = ");
        expect(runMsg.code).toContain("print(_run_id)");

        w._receive({ type: "result", id: runMsg.id, value: "ok" });
        expect(await promise).toBe("ok");
    });

    it("calls onToken for streamed tokens", async () => {
        const { startWorker, runPythonStreaming } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const tokens = [];
        const promise = runPythonStreaming("code", (t) => tokens.push(t));
        const runMsg = w.posted.find((m) => m.type === "run");

        w._receive({
            type: "token",
            id: runMsg.id,
            json: JSON.stringify({ text: "hello" }),
        });
        w._receive({
            type: "token",
            id: runMsg.id,
            json: JSON.stringify({ text: "world" }),
        });
        w._receive({ type: "result", id: runMsg.id, value: "done" });

        expect(await promise).toBe("done");
        expect(tokens).toEqual([{ text: "hello" }, { text: "world" }]);
    });
});

describe("terminateWorker", () => {
    it("is a no-op when no worker exists", async () => {
        const { terminateWorker } = await loadPyodide();
        expect(() => terminateWorker()).not.toThrow();
    });

    it("terminates worker and rejects pending tasks", async () => {
        const { startWorker, runPython, terminateWorker, pyodideStore } =
            await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w.terminate = vi.fn();
        w._receive({ type: "ready" });

        const promise = runPython("slow()");
        terminateWorker();

        expect(w.terminate).toHaveBeenCalled();
        await expect(promise).rejects.toThrow("Cancelled");

        let state;
        pyodideStore.subscribe((s) => {
            state = s;
        });
        expect(state.status).toBe("idle");
    });
});

describe("setGoogleToken", () => {
    it("does nothing when worker is not ready", async () => {
        const { setGoogleToken } = await loadPyodide();
        expect(() => setGoogleToken("tok")).not.toThrow();
    });

    it("sends token to worker when ready", async () => {
        const { startWorker, setGoogleToken } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        setGoogleToken("my-token");
        const msg = w.posted.find((m) => m.type === "set-google-token");
        expect(msg).toBeDefined();
        expect(msg.token).toBe("my-token");
    });

    it("sends null token for revocation", async () => {
        const { startWorker, setGoogleToken } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        setGoogleToken(null);
        const msg = w.posted.find((m) => m.type === "set-google-token");
        expect(msg.token).toBeNull();
    });
});

describe("setQueryHandler", () => {
    it("exports setQueryHandler", async () => {
        const mod = await loadPyodide();
        expect(typeof mod.setQueryHandler).toBe("function");
    });
});

describe("setLiveIframe", () => {
    it("exports setLiveIframe", async () => {
        const mod = await loadPyodide();
        expect(typeof mod.setLiveIframe).toBe("function");
    });
});

describe("test-app message routing", () => {
    it("forwards test-app messages from worker", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        // The worker sends a test-app message — main thread should handle it.
        // We can't fully test the iframe lifecycle in unit tests, but we can
        // verify the message handler doesn't throw on test-app messages.
        expect(() => {
            w._receive({
                type: "test-app",
                id: 1,
                appFilesJson: JSON.stringify({ "app/index.html": "<html></html>" }),
                actionsJson: null,
            });
        }).not.toThrow();
    });

    it("forwards test-app messages with actions", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        const actions = [
            { click: "#btn" },
            { type: "#input", value: "hello" },
            { select: "#dropdown", value: "opt1" },
            { read: "#output" },
            { eval: "1+1" },
            { wait: 100 },
        ];

        expect(() => {
            w._receive({
                type: "test-app",
                id: 2,
                appFilesJson: JSON.stringify({ "app/index.html": "<html></html>" }),
                actionsJson: JSON.stringify(actions),
            });
        }).not.toThrow();
    });

    it("forwards live-app messages", async () => {
        const { startWorker } = await loadPyodide();
        startWorker();
        const w = MockWorker.instances[0];
        w._receive({ type: "ready" });

        expect(() => {
            w._receive({
                type: "live-app",
                id: 1,
                actionsJson: JSON.stringify([{ read: "#date-input", prop: "value" }]),
            });
        }).not.toThrow();
    });
});
