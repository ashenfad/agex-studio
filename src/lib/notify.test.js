import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Each notification shown: its title, body and click handler.
 *  @type {{ title: string, body: string, onclick: (() => void) | null, closed: boolean }[]} */
let shown = [];

/** A Notification stand-in with `permission`, recording what's shown.
 *  @param {string} permission @param {string} [answer] what a request answers */
function stubNotification(permission, answer = permission) {
    const Fake = class {
        /** @param {string} title @param {{ body: string }} opts */
        constructor(title, opts) {
            this.title = title;
            this.body = opts.body;
            /** @type {(() => void) | null} */
            this.onclick = null;
            this.closed = false;
            shown.push(this);
        }
        close() {
            this.closed = true;
        }
        static permission = permission;
        static requestPermission = vi.fn(async () => {
            Fake.permission = answer;
            return answer;
        });
    };
    vi.stubGlobal("Notification", Fake);
    return Fake;
}

/** notify.js with `notifyOnFinish` as given, the settings fresh. */
async function load(notifyOnFinish = true) {
    const store = /** @type {Record<string, string>} */ ({});
    vi.stubGlobal("localStorage", {
        getItem: (/** @type {string} */ k) => store[k] ?? null,
        setItem: (/** @type {string} */ k, /** @type {string} */ v) => void (store[k] = v),
    });
    vi.stubGlobal("window", { focus: vi.fn() });
    const settings = await import("./settings.js");
    settings.updateSettings({ notifyOnFinish });
    return import("./notify.js");
}

const turn = { session: "s-1", title: "Plot the tides", status: "completed", reply: "Here's the chart.", error: null };

beforeEach(() => {
    shown = [];
    vi.resetModules();
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe("turnNotice", () => {
    it("says the session's title and the reply's first line", async () => {
        const { turnNotice } = await load();
        expect(turnNotice(turn)).toEqual({ title: "Plot the tides", body: "Here's the chart." });
        expect(turnNotice({ ...turn, title: "", reply: "" })).toEqual({ title: "agex studio", body: "Finished." });
    });

    it("says how a turn that went wrong ended", async () => {
        const { turnNotice } = await load();
        expect(turnNotice({ ...turn, status: "failed", error: "the turn ended failed: overloaded" }).body).toBe("The turn ended failed: overloaded");
        expect(turnNotice({ ...turn, status: "interrupted" }).body).toBe("The turn ended interrupted.");
        expect(turnNotice({ ...turn, status: "cancelled" }).body).toBe("Stopped.");
    });
});

describe("lastReply", () => {
    it("is the first line of the agent's last words", async () => {
        const { lastReply } = await load();
        const msg = (/** @type {string} */ role, /** @type {string} */ text) => ({ id: "m", role, parts: [{ kind: "text", text }] });
        const run = /** @type {any} */ ({ messages: [msg("user", "go"), msg("assistant", "\n Done: three files.\nMore."), msg("assistant", "  ")] });
        expect(lastReply(run)).toBe("Done: three files.");
        expect(lastReply(undefined)).toBe("");
    });
});

describe("notifyTurnEnded", () => {
    it("shows nothing unless the person turned it on", async () => {
        stubNotification("granted");
        const { notifyTurnEnded } = await load(false);
        expect(notifyTurnEnded(turn)).toBe(false);
        expect(shown).toHaveLength(0);
    });

    it("shows nothing without the browser's permission, and doesn't ask", async () => {
        const Fake = stubNotification("default");
        const { notifyTurnEnded } = await load();
        expect(notifyTurnEnded(turn)).toBe(false);
        expect(Fake.requestPermission).not.toHaveBeenCalled();
        stubNotification("denied");
        expect(notifyTurnEnded(turn)).toBe(false);
        expect(shown).toHaveLength(0);
    });

    it("shows nothing where there are no notifications", async () => {
        const { notifyTurnEnded, notificationPermission } = await load();
        expect(notificationPermission()).toBe("unsupported");
        expect(notifyTurnEnded(turn)).toBe(false);
    });

    it("shows the turn's notice; a click focuses the window and opens its session", async () => {
        stubNotification("granted");
        const { notifyTurnEnded, onNotificationClick } = await load();
        const opened = /** @type {string[]} */ ([]);
        onNotificationClick((name) => opened.push(name));
        expect(notifyTurnEnded(turn)).toBe(true);
        expect(shown).toMatchObject([{ title: "Plot the tides", body: "Here's the chart." }]);
        shown[0]?.onclick?.();
        expect(/** @type {any} */ (window).focus).toHaveBeenCalled();
        expect(opened).toEqual(["s-1"]);
        expect(shown[0]?.closed).toBe(true);
    });

    it("cuts a long title and body short", async () => {
        stubNotification("granted");
        const { notifyTurnEnded } = await load();
        notifyTurnEnded({ ...turn, title: "t".repeat(300), reply: "r".repeat(600) });
        expect(shown[0]?.title).toHaveLength(100);
        expect(shown[0]?.body).toHaveLength(250);
        expect(shown[0]?.body.endsWith("…")).toBe(true);
    });
});

describe("requestNotificationPermission", () => {
    it("says what the browser answered", async () => {
        stubNotification("default", "granted");
        const { requestNotificationPermission, notificationPermission } = await load();
        expect(await requestNotificationPermission()).toBe("granted");
        expect(notificationPermission()).toBe("granted");
    });
});

describe("appNotify", () => {
    const ask = { session: "s-1", title: "Timer", body: "Tea's ready" };

    it("shows only what the browser already allows, and says why not", async () => {
        const Fake = stubNotification("default");
        const { appNotify } = await load(false);
        const out = appNotify(ask);
        expect(out.shown).toBe(false);
        expect(out.reason).toMatch(/settings/);
        expect(Fake.requestPermission).not.toHaveBeenCalled();
        expect(shown).toHaveLength(0);
    });

    it("shows with permission, whatever the turn setting", async () => {
        stubNotification("granted");
        const { appNotify } = await load(false);
        expect(appNotify(ask)).toEqual({ shown: true, reason: null });
        expect(shown).toMatchObject([{ title: "Timer", body: "Tea's ready" }]);
        expect(appNotify({ ...ask, title: "" }).shown).toBe(true);
        expect(shown[1]?.title).toBe("agex studio");
    });

    it("caps each session's app at five a minute", async () => {
        stubNotification("granted");
        const { appNotify, APP_NOTIFY_MAX } = await load();
        const t0 = 1_000_000;
        for (let i = 0; i < APP_NOTIFY_MAX; i++) expect(appNotify(ask, t0 + i * 1000).shown).toBe(true);
        const capped = appNotify(ask, t0 + 10_000);
        expect(capped.shown).toBe(false);
        expect(capped.reason).toMatch(/a minute/);
        // another session's app has its own
        expect(appNotify({ ...ask, session: "s-2" }, t0 + 10_000).shown).toBe(true);
        // a minute after the first, one more
        expect(appNotify(ask, t0 + 60_000).shown).toBe(true);
        expect(appNotify(ask, t0 + 60_500).shown).toBe(false);
        expect(shown).toHaveLength(APP_NOTIFY_MAX + 2);
    });
});
