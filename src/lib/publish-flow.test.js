/**
 * State-machine tests for the publish flow. The pure gist-target rules
 * are covered in bundle-format.test.js; these pin the *transitions* —
 * py vs ts entry, the no-PAT guard, the success path's setSessionGistInfo
 * write + done shape, and that close() refuses mid-flight stages — using
 * vi.mock doubles for the bundle/gist/settings dependencies.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { writable } from "svelte/store";

let exportBundleImpl;
let profileSizesImpl;
let priorGist;
let publishImpl;
const setSessionGistInfo = vi.fn();

vi.mock("./sessions.js", () => ({
    exportBundle: (...args) => exportBundleImpl(...args),
    profilePublishSizes: (...args) => profileSizesImpl(...args),
    getSessionGistInfo: () => priorGist,
    setSessionGistInfo: (...args) => setSessionGistInfo(...args),
}));

class GistPublishError extends Error {}
vi.mock("./gist-publish.js", () => ({
    publishGistBundle: (...args) => publishImpl(...args),
    GistPublishError,
}));

const settingsStore = writable({ githubPat: "tok", publishShape: "flat" });
const updateSettings = vi.fn((patch) =>
    settingsStore.update((s) => ({ ...s, ...patch })),
);
vi.mock("./settings.js", () => ({ settingsStore, updateSettings }));

const { createPublishFlow } = await import("./publish-flow.svelte.js");

beforeEach(() => {
    exportBundleImpl = async () => ({
        bytes: new Uint8Array([1, 2, 3]),
        manifest: { stats: { commits: 2 } },
    });
    profileSizesImpl = async () => ({ estimates: { full: 100, flat: 50 } });
    priorGist = null;
    publishImpl = async () => ({
        gistId: "new1",
        slug: "slug",
        runtimeUrl: "https://app/x",
        gistHtmlUrl: "https://gist/x",
    });
    setSessionGistInfo.mockClear();
    updateSettings.mockClear();
    settingsStore.set({ githubPat: "tok", publishShape: "flat" });
});

describe("entry stages", () => {
    it("ts sessions land on the options stage seeded from settings", async () => {
        const flow = createPublishFlow();
        await flow.start({ branch: "b", kernel: "ts" });
        expect(flow.state.stage).toBe("options");
        expect(flow.state.shape).toBe("flat"); // from settingsStore.publishShape
        expect(flow.state.estimates).toEqual({ full: 100, flat: 50 });
    });

    it("py sessions skip options and bundle straight to preview", async () => {
        const flow = createPublishFlow();
        await flow.start({ branch: "b", kernel: "py" });
        expect(flow.state.stage).toBe("preview");
        expect(flow.state.target).toBe("new"); // no prior gist
        expect(flow.state.ack).toBe(false);
    });

    it("defaults the target to 'existing' when an owned prior gist exists", async () => {
        priorGist = { gistId: "old", slug: "s", inherited: false };
        const flow = createPublishFlow();
        await flow.start({ branch: "b", kernel: "py" });
        expect(flow.state.target).toBe("existing");
        expect(flow.state.priorGist).toBe(priorGist);
    });

    it("start() is a no-op while a flow is already open", async () => {
        const flow = createPublishFlow();
        await flow.start({ branch: "b", kernel: "py" });
        const snapshot = flow.state;
        await flow.start({ branch: "other", kernel: "py" });
        expect(flow.state).toBe(snapshot);
    });
});

describe("confirm", () => {
    async function toPreview(session = { branch: "b", kernel: "py" }) {
        const flow = createPublishFlow();
        await flow.start(session);
        return flow;
    }

    it("does nothing until the ack box is checked", async () => {
        const flow = await toPreview();
        await flow.confirm();
        expect(flow.state.stage).toBe("preview"); // unchanged
        expect(setSessionGistInfo).not.toHaveBeenCalled();
    });

    it("errors out (no upload) when no PAT is configured", async () => {
        settingsStore.set({ githubPat: "", publishShape: "flat" });
        const flow = await toPreview();
        flow.state.ack = true;
        await flow.confirm();
        expect(flow.state.stage).toBe("error");
        expect(flow.state.message).toMatch(/Personal Access Token/);
        expect(setSessionGistInfo).not.toHaveBeenCalled();
    });

    it("publishes, records the mapping, and lands on done", async () => {
        const flow = await toPreview();
        flow.state.ack = true;
        await flow.confirm();
        expect(flow.state.stage).toBe("done");
        expect(flow.state.result.gistId).toBe("new1");
        expect(flow.state.fallbackFromGistId).toBe(""); // no prior gist
        expect(setSessionGistInfo).toHaveBeenCalledWith(
            "b",
            expect.objectContaining({ gistId: "new1", slug: "slug" }),
        );
    });

    it("flags a 404-fallback when an update lands on a different gist", async () => {
        priorGist = { gistId: "old", slug: "s", inherited: false };
        publishImpl = async () => ({
            gistId: "fresh",
            slug: "slug2",
            runtimeUrl: "https://app/y",
            gistHtmlUrl: "https://gist/y",
        });
        const flow = await toPreview();
        // prior gist present → default target 'existing'
        flow.state.ack = true;
        await flow.confirm();
        expect(flow.state.stage).toBe("done");
        expect(flow.state.fallbackFromGistId).toBe("old");
    });

    it("surfaces a GistPublishError message verbatim", async () => {
        publishImpl = async () => {
            throw new GistPublishError("rate limited");
        };
        const flow = await toPreview();
        flow.state.ack = true;
        await flow.confirm();
        expect(flow.state.stage).toBe("error");
        expect(flow.state.message).toBe("rate limited");
    });
});

describe("close", () => {
    it("refuses to close mid-upload, allows it once done", async () => {
        const flow = createPublishFlow();
        await flow.start({ branch: "b", kernel: "py" });
        flow.state.ack = true;
        // Hold the upload open so we can observe the 'uploading' stage.
        let release;
        publishImpl = () => new Promise((r) => { release = r; });
        const pending = flow.confirm();
        expect(flow.state.stage).toBe("uploading");
        flow.close();
        expect(flow.state.stage).toBe("uploading"); // close refused
        release({ gistId: "g", slug: "s", runtimeUrl: "u", gistHtmlUrl: "h" });
        await pending;
        expect(flow.state.stage).toBe("done");
        flow.close();
        expect(flow.state).toBeNull();
    });
});
