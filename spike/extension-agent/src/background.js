// The spike's service worker: makes the offscreen document on demand and
// passes a probe's name to it. The harness calls `spike(what)` here.

const OFFSCREEN = "offscreen.html";

async function ensureOffscreen() {
    const have = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
    if (have.length > 0) return;
    await chrome.offscreen.createDocument({
        url: OFFSCREEN,
        reasons: ["IFRAME_SCRIPTING", "WORKERS"],
        justification: "runs an agent in a sandboxed page, its code in a worker",
    });
}

globalThis.spike = async (what) => {
    if (what === "restart") {
        // the offscreen document closed, and with it the sandbox and its worker
        await chrome.offscreen.closeDocument().catch(() => {});
        return { contexts: (await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] })).length };
    }
    await ensureOffscreen();
    return chrome.runtime.sendMessage({ to: "offscreen", what });
};
