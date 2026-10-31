/**
 * The toolbar's popup: shares the tab in front with agex.studio, which
 * then asks which session takes it, or stops a share. What it shows comes
 * from the worker (`popupState`), as do the share and its end.
 */

const head = /** @type {HTMLElement} */ (document.getElementById("head"));
const body = /** @type {HTMLElement} */ (document.getElementById("body"));
const act = /** @type {HTMLButtonElement} */ (document.getElementById("act"));

/** @param {string} op @param {number} tab */
async function ask(op, tab) {
    const reply = await chrome.runtime.sendMessage({ popup: op, tab });
    if (reply === undefined) throw new Error("The extension didn't answer: reload it in chrome://extensions.");
    if (reply.error) throw new Error(reply.error.message);
    return reply.value;
}

/** A second, quieter button, beside the first. @param {string} label @param {() => Promise<void>} run */
function toggle(label, run) {
    const b = document.createElement("button");
    b.className = "quiet";
    b.textContent = label;
    b.onclick = () => {
        b.disabled = true;
        run().then(
            () => window.close(),
            (e) => {
                b.disabled = false;
                body.textContent = e.message;
            },
        );
    };
    act.after(b);
}

/** @param {string} h @param {string} b @param {{ label: string, quiet?: boolean, run: () => Promise<void> }} [button] */
function show(h, b, button) {
    head.textContent = h;
    body.textContent = b;
    act.hidden = button === undefined;
    if (button === undefined) return;
    act.textContent = button.label;
    act.className = button.quiet ? "quiet" : "";
    act.onclick = () => {
        act.disabled = true;
        button.run().then(
            () => window.close(),
            (e) => {
                act.disabled = false;
                body.textContent = e.message;
            },
        );
    };
}

async function main() {
    const [front] = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = front?.id;
    if (tab === undefined) {
        show("Nothing to share", "There's no tab in front here.");
        return;
    }
    const s = await ask("state", tab);
    if (s.kind === "share") {
        show("Share this tab", `The agent in the session you pick in agex.studio can read this page while it's on ${s.domain}. It can't click or type here.`, {
            label: "Share",
            run: () => ask("share", tab),
        });
    } else if (s.kind === "waiting") {
        show("Waiting for agex.studio", "Pick the session that gets this tab in agex.studio.", { label: "Cancel", quiet: true, run: () => ask("stop", tab) });
    } else if (s.kind === "shared") {
        const what = s.acts ? "read this page and act in it (click, type, go on)" : "read this page";
        show(`Shared with ${s.name}`, `Its agent can ${what} while it's on ${s.domain}.`, { label: "Stop sharing", quiet: true, run: () => ask("stop", tab) });
        toggle(s.acts ? "Only let it read" : "Let it click and type too", () => ask(s.acts ? "reads" : "acts", tab));
    } else if (s.kind === "session") {
        show(`${s.name}'s tab`, "The agent opened this tab for that session, so it's the session's already.");
    } else if (s.kind === "studio") {
        show("This is agex.studio", "Share a tab of another site from here.");
    } else {
        show("Can't share this tab", "Only a web page (http or https) can be shared.");
    }
}

main().catch((e) => show("Something went wrong", e.message));
