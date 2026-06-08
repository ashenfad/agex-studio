import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// settings.js reads localStorage at import; back it with a fresh object.
// Re-stubbed each test since afterEach unstubs every global.
const store = {};
function stubLocalStorage() {
    vi.stubGlobal("localStorage", {
        getItem: (k) => store[k] ?? null,
        setItem: (k, v) => {
            store[k] = v;
        },
        removeItem: (k) => {
            delete store[k];
        },
    });
}

// A minimal stand-in for the Notification constructor that records each
// instance so tests can assert on what was shown.
let shown = [];
function makeNotification(permission) {
    function Notification(title, options) {
        this.title = title;
        this.options = options;
        this.onclick = null;
        this.close = () => {};
        shown.push(this);
    }
    Notification.permission = permission;
    Notification.requestPermission = vi.fn(async () => Notification.permission);
    return Notification;
}

function setVisibility(state, focused = true) {
    vi.stubGlobal("document", {
        visibilityState: state,
        hasFocus: () => focused,
        addEventListener: () => {},
    });
}

beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    shown = [];
    stubLocalStorage();
    vi.stubGlobal("window", {});
    setVisibility("visible");
    vi.resetModules();
});

afterEach(() => {
    vi.unstubAllGlobals();
});

async function load(permission = "granted", { notifyOnFinish = true } = {}) {
    const Ctor = makeNotification(permission);
    vi.stubGlobal("Notification", Ctor);
    // `notificationsSupported` checks `"Notification" in window`, so the
    // stubbed constructor has to live on the window stub too.
    vi.stubGlobal("window", { Notification: Ctor, focus: () => {} });
    const settings = await import("./settings.js");
    settings.updateSettings({ notifyOnFinish });
    const notify = await import("./notify.js");
    return { ...notify, settings };
}

describe("notificationsSupported", () => {
    it("is false when the Notification API is absent", async () => {
        // window has no Notification
        const notify = await import("./notify.js");
        expect(notify.notificationsSupported()).toBe(false);
    });

    it("is true when Notification exists on window", async () => {
        const { notificationsSupported } = await load();
        expect(notificationsSupported()).toBe(true);
    });
});

describe("notifyTurnComplete", () => {
    it("does nothing when the opt-in flag is off", async () => {
        const { notifyTurnComplete } = await load("granted", {
            notifyOnFinish: false,
        });
        notifyTurnComplete({ branch: "b1", title: "T", foreground: false });
        expect(shown).toHaveLength(0);
    });

    it("does nothing without permission", async () => {
        const { notifyTurnComplete } = await load("default");
        notifyTurnComplete({ branch: "b1", title: "T", foreground: false });
        expect(shown).toHaveLength(0);
    });

    it("does nothing when on-screen (foreground + visible)", async () => {
        const { notifyTurnComplete } = await load();
        notifyTurnComplete({ branch: "b1", title: "T", foreground: true });
        expect(shown).toHaveLength(0);
    });

    it("notifies when foreground but the tab is hidden", async () => {
        setVisibility("hidden");
        const { notifyTurnComplete } = await load();
        notifyTurnComplete({ branch: "b1", title: "T", foreground: true });
        expect(shown).toHaveLength(1);
        expect(shown[0].options.body).toContain("T");
    });

    it("notifies when foreground + visible but the window is unfocused", async () => {
        // The window/app-switch case: the tab stays "visible" but the
        // studio window doesn't have focus. visibilityState alone misses
        // it; hasFocus() catches it.
        setVisibility("visible", false);
        const { notifyTurnComplete } = await load();
        notifyTurnComplete({ branch: "b1", title: "T", foreground: true });
        expect(shown).toHaveLength(1);
    });

    it("notifies when a background session finishes", async () => {
        const { notifyTurnComplete } = await load();
        notifyTurnComplete({ branch: "b2", title: "Side", foreground: false });
        expect(shown).toHaveLength(1);
        expect(shown[0].options.tag).toBe("agex-session-b2");
    });
});

describe("showAppNotification", () => {
    it("returns false without permission", async () => {
        const { showAppNotification } = await load("denied");
        expect(showAppNotification({ title: "Hi", branch: "b1" })).toBe(false);
        expect(shown).toHaveLength(0);
    });

    it("shows and returns true when granted, capping long fields", async () => {
        const { showAppNotification } = await load();
        const longTitle = "x".repeat(500);
        expect(
            showAppNotification({ title: longTitle, body: "go", branch: "b1" }),
        ).toBe(true);
        expect(shown).toHaveLength(1);
        expect(shown[0].title.length).toBeLessThanOrEqual(100);
        expect(shown[0].options.tag).toBe("agex-app-b1");
    });

    it("routes a click through the activate handler", async () => {
        const { showAppNotification, setNotificationActivateHandler } =
            await load();
        const activated = [];
        setNotificationActivateHandler((b) => activated.push(b));
        showAppNotification({ title: "Hi", branch: "b9" });
        shown[0].onclick();
        expect(activated).toEqual(["b9"]);
    });
});
