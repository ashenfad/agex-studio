/**
 * The toolbar's popup, for the tab in front and its site: submitting the
 * page as the person sees it for the site's agent (after a warning that
 * says where it goes); the filter the agent presented, previewed on the
 * page and accepted or turned down; and once there's one, the site's
 * filter turned on or off, its hidden things shown, extended with this
 * page, or removed. Opening the popup is the person's click on the
 * extension, which lets it read that one tab (`activeTab`); accepting is
 * the click Chrome asks for the site's permission on.
 *
 * `?tab=<id>` names the tab instead of the one in front (the tests').
 */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));
const button = (/** @type {string} */ id) => /** @type {HTMLButtonElement} */ ($(id));
const input = (/** @type {string} */ id) => /** @type {HTMLInputElement} */ ($(id));

/**
 * An op of the service worker's.
 * @param {string} op @param {Record<string, unknown>} [args]
 * @returns {Promise<any>}
 */
async function ask(op, args = {}) {
    const reply = await chrome.runtime.sendMessage({ op, ...args });
    if (reply?.error !== undefined) throw new Error(reply.error);
    return reply?.value;
}

/**
 * How the site's agent stands, in words: working (and for how long), or
 * how its last turn ended when it ended without a filter to preview.
 *
 * @param {{ state: string, at: number, text?: string, error?: string } | null} status
 * @param {boolean} candidate whether a filter it presented waits
 */
function statusText(status, candidate) {
    if (status === null) return "";
    if (status.state === "working") return `Its agent is working on this site (${since(status.at)}).`;
    if (status.state === "failed") return `Its agent stopped: ${status.error}`;
    if (candidate) return "";
    const words = (status.text ?? "").trim();
    return `Its agent finished without a filter${words === "" ? "." : `: “${words.length > 300 ? `${words.slice(0, 299)}…` : words}”`}`;
}

/** How long ago `at` was, roughly. @param {number} at */
function since(at) {
    const s = Math.max(0, Math.round((Date.now() - at) / 1000));
    return s < 60 ? `${s}s` : `${Math.round(s / 60)} min`;
}

/** Say `e` in the status line. @param {unknown} e */
function fail(e) {
    $("status").hidden = false;
    $("status").textContent = String(/** @type {Error} */ (e)?.message ?? e);
}

/** The tab the popup is about. */
async function tabOf() {
    const named = new URLSearchParams(location.search).get("tab");
    if (named !== null) return Number(named);
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.id;
}

/** Whether the candidate or the hidden things are outlined on the page now. */
let outlining = false;
/** The port held open to the worker while the popup is. @type {chrome.runtime.Port | null} */
let held = null;

/** A preview on tab `tabId` ended, if there is one. @param {number | undefined} tabId */
async function endPreview(tabId) {
    if (outlining) await ask("filterPreviewEnd", { tabId });
    outlining = false;
}

async function show() {
    const tabId = await tabOf();
    // held while the popup is open: the worker ends a preview here when it closes
    if (tabId !== undefined && held === null) held = chrome.runtime.connect({ name: `popup:${tabId}` });
    const page = tabId === undefined ? { site: null, paused: false } : await ask("page", { tabId });
    for (const id of ["candidate", "applied", "submit-section", "forget"]) $(id).hidden = true;
    input("pause").checked = page.paused === true;
    if (page.site === null) {
        $("site").textContent = "Not a site's page";
        return;
    }
    const site = page.site;
    $("site").textContent = site;
    // the popup shows how the last turn ended: the site's amber dot goes
    void ask("seen", { site }).catch(() => {});
    const status = statusText(page.status, page.candidate !== null);
    $("status").hidden = status === "";
    $("status").textContent = status;
    $("forget").hidden = page.candidate === null && page.applied === null && page.status === null;
    const working = page.status?.state === "working";

    if (page.candidate !== null) {
        const hidden = page.candidate.pages.reduce((/** @type {number} */ n, /** @type {{ hidden: number }} */ p) => n + p.hidden, 0);
        $("candidate").hidden = false;
        $("candidate-text").textContent = `A filter is ready: it hides ${hidden} ${hidden === 1 ? "thing" : "things"} on the pages you sent. Preview it here, then accept it or say what's wrong.`;
        button("preview").textContent = outlining ? "End preview" : "Preview";
    } else if (page.applied !== null) {
        $("applied").hidden = false;
        input("on").checked = page.applied.on;
        const count = await ask("filterCount", { tabId });
        $("count").textContent = page.paused ? "All filters are paused." : !page.applied.on ? "Off for this site." : `${count} hidden on this page.`;
        $("hint").hidden = !(page.applied.on && !page.paused && count === 0);
        button("show").textContent = outlining ? "Hide them again" : "Show hidden";
        $("changes-note").className = page.password ? "warn" : "muted";
        $("changes-note").textContent = "Changes go to the agent with this page, and come back as a new filter to preview." +
            (page.password ? " This page has a password field: send it only if nothing on it is private." : "");
        button("ask-changes").disabled = working;
        button("extend").disabled = working;
    }
    if (page.candidate === null && page.applied === null) {
        // a site's first page
        $("submit-section").hidden = false;
        button("submit").disabled = working;
        $("warning").className = page.password ? "warn" : "muted";
        $("warning").textContent = `The page as it is now goes to your model's service, and stays on this device as one of ${site}'s pages.` +
            (page.password ? " It has a password field: submit it only if nothing on it is private." : "");
    }

    button("submit").onclick = () => act(async () => ask("submit", { tabId }));
    button("preview").onclick = () =>
        act(async () => {
            if (outlining) await ask("filterPreviewEnd", { tabId });
            else await ask("filterPreview", { tabId, site, filter: page.candidate.filter });
            outlining = !outlining;
        });
    button("accept").onclick = () =>
        act(async () => {
            // the site's permission, asked of Chrome from this click
            const granted = await chrome.permissions.request({ origins: [`*://${site}/*`, `*://*.${site}/*`] });
            if (!granted) throw new Error(`Without permission for ${site}, the filter can't apply there.`);
            await endPreview(tabId);
            await ask("accept", { site });
        });
    button("reject").onclick = () =>
        act(async () => {
            await endPreview(tabId);
            await ask("reject", { site, reason: input("reason").value });
        });
    input("on").onchange = () => act(async () => ask("filterSetOn", { site, on: input("on").checked }));
    button("show").onclick = () =>
        act(async () => {
            if (outlining) await ask("filterPreviewEnd", { tabId });
            else await ask("filterPreview", { tabId, site, filter: page.applied.filter });
            outlining = !outlining;
        });
    // the page goes with either, so the agent sees what's meant
    button("ask-changes").onclick = () =>
        act(async () => {
            const request = input("request").value.trim();
            if (request === "") throw new Error("Say what should change, or extend the filter with this page.");
            await endPreview(tabId);
            await ask("submit", { tabId, request });
        });
    button("extend").onclick = () =>
        act(async () => {
            await endPreview(tabId);
            await ask("submit", { tabId });
        });
    button("remove").onclick = () =>
        act(async () => {
            await endPreview(tabId);
            await ask("filterRemove", { site });
        });
    $("forget").onclick = (e) => {
        e.preventDefault();
        void act(async () => {
            await endPreview(tabId);
            await ask("forget", { site });
        });
    };
}

/** Do `change`, then show the popup again as things now stand. @param {() => Promise<unknown>} change */
async function act(change) {
    for (const b of document.querySelectorAll("button")) b.disabled = true;
    try {
        await change();
    } catch (e) {
        fail(e);
        return;
    } finally {
        for (const b of document.querySelectorAll("button")) b.disabled = false;
    }
    await show().catch(fail);
}

input("pause").onchange = () => act(async () => ask("filterPause", { paused: input("pause").checked }));
$("settings").onclick = (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
};

void show().catch(fail);

// a module, so its names are its own
export {};
