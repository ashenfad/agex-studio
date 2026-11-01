/**
 * The toolbar's popup, for the tab in front: its site, and submitting the
 * page as the person sees it for the site's agent to filter, after a
 * warning that says where it goes. Opening the popup is the person's
 * click on the extension, which lets it read that one tab (`activeTab`).
 */

const $ = (/** @type {string} */ id) => /** @type {HTMLElement} */ (document.getElementById(id));

/**
 * An op of the service worker's.
 * @param {string} op @param {Record<string, unknown>} [args]
 */
async function ask(op, args = {}) {
    const reply = await chrome.runtime.sendMessage({ op, ...args });
    if (reply?.error !== undefined) throw new Error(reply.error);
    return reply?.value;
}

/** The agent's state for a site, in words. @param {{ state: string, error?: string } | null} status */
function statusText(status) {
    if (status === null) return "";
    if (status.state === "working") return "Its agent is working on this site.";
    if (status.state === "failed") return `Its agent stopped: ${status.error}`;
    return "Its agent has finished.";
}

async function show() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const page = tab?.id === undefined ? { site: null } : await ask("page", { tabId: tab.id });
    if (page.site === null) {
        $("site").textContent = "Not a site's page";
        return;
    }
    $("site").textContent = page.site;
    const status = statusText(page.status);
    $("status").hidden = status === "";
    $("status").textContent = status;
    $("warning").hidden = false;
    $("warning").textContent = `The page as it is now goes to your model's service, and stays on this device as one of ${page.site}'s pages.`;
    if (page.password) {
        $("warning").className = "warn";
        $("warning").textContent += " It has a password field: submit it only if nothing on it is private.";
    }
    const submit = /** @type {HTMLButtonElement} */ ($("submit"));
    submit.hidden = false;
    submit.disabled = page.status?.state === "working";
    submit.onclick = async () => {
        submit.disabled = true;
        try {
            await ask("submit", { tabId: tab.id });
            $("status").hidden = false;
            $("status").textContent = statusText({ state: "working" });
        } catch (e) {
            $("status").hidden = false;
            $("status").textContent = String(/** @type {Error} */ (e)?.message ?? e);
            submit.disabled = false;
        }
    };
}

$("settings").onclick = (e) => {
    e.preventDefault();
    void chrome.runtime.openOptionsPage();
};

void show();
