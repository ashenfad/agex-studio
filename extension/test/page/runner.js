// Plays the studio for the end-to-end tests: opens the port to the
// extension, runs each scenario named in `?scenarios=`, in order, and
// posts each one's report to the harness.

import { HEARTBEAT_MS, PROTOCOL } from "../../src/protocol.js";

const params = new URLSearchParams(location.search);
const ext = params.get("ext") ?? "";
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const post = (name, report) => fetch("/report", { method: "POST", body: JSON.stringify({ name, report }) });

/** A port with request/reply over it, and when it dropped. */
function connect() {
    const port = chrome.runtime.connect(ext);
    let next = 0;
    const waiting = new Map();
    const conn = { dropped: /** @type {number | null} */ (null), opened: performance.now(), events: /** @type {string[]} */ ([]) };
    port.onMessage.addListener((m) => {
        // what the extension sends unasked, kept for the scenario to look at
        if (m.event !== undefined && m.id === undefined) return void conn.events.push(m.event);
        waiting.get(m.id)?.(m);
        waiting.delete(m.id);
    });
    port.onDisconnect.addListener(() => {
        conn.dropped = performance.now();
        for (const done of waiting.values()) done({ error: { code: "disconnected" } });
        waiting.clear();
    });
    /** @param {string} op @param {Record<string, unknown>} [args] */
    const call = (op, args = {}) =>
        new Promise((ok) => {
            const id = ++next;
            waiting.set(id, ok);
            port.postMessage({ id, op, ...args });
        });
    return Object.assign(conn, { call, port });
}

const SCENARIOS = {
    /** whether this page can reach any extension at all */
    async reachable() {
        return { connect: typeof globalThis.chrome?.runtime?.connect === "function" };
    },

    /** hello, then a ping */
    async hello() {
        const c = connect();
        const hello = await c.call("hello", { protocol: PROTOCOL });
        const ping = await c.call("ping");
        c.port.disconnect();
        return { hello, ping };
    },

    /** an op before hello, an unknown op, and another protocol's hello */
    async refusals() {
        const c = connect();
        const early = await c.call("ping");
        await c.call("hello", { protocol: PROTOCOL });
        const unknown = await c.call("teleport");
        c.port.disconnect();
        const d = connect();
        const wrong = await d.call("hello", { protocol: PROTOCOL + 1 });
        await sleep(200);
        return { early, unknown, wrong, wrongClosed: d.dropped !== null };
    },

    /** a port left quiet drops when the worker stops; a new one works */
    async idle() {
        const c = connect();
        await c.call("hello", { protocol: PROTOCOL });
        const limit = 90_000;
        while (c.dropped === null && performance.now() - c.opened < limit) await sleep(500);
        const again = connect();
        const hello = await again.call("hello", { protocol: PROTOCOL });
        again.port.disconnect();
        return { droppedAfterMs: c.dropped === null ? null : Math.round(c.dropped - c.opened), reconnected: hello };
    },

    /** a port pinged every HEARTBEAT_MS stays up past the idle limit */
    async heartbeat() {
        const c = connect();
        await c.call("hello", { protocol: PROTOCOL });
        const span = Number(params.get("heartbeatSpan") ?? 65_000);
        let pings = 0;
        while (c.dropped === null && performance.now() - c.opened < span) {
            await sleep(HEARTBEAT_MS);
            if (c.dropped === null && (await c.call("ping")).value) pings++;
        }
        const up = c.dropped === null;
        c.port.disconnect();
        return { up, pings, spanMs: span };
    },

    /** open, list and close a session's tabs, and the refusals on the way */
    async tabs() {
        const c = await greeted();
        const session = await c.call("session", { session: "s1", name: "Hotels", domains: [GRANTED_DOMAIN] });
        const opened = await c.call("open", { session: "s1", url: site("open") });
        const ungranted = await c.call("open", { session: "s1", url: `${OTHER}/test/page/site.html?id=refused` });
        const unknown = await c.call("open", { session: "nobody", url: site("refused") });
        const loaded = await tabWhere(c, "s1", (t) => t.title === "site open");
        await c.call("session", { session: "s2", name: "Other", domains: [GRANTED_DOMAIN] });
        const elsewhere = await c.call("close", { session: "s2", tab: opened.value?.tab });
        const closed = await c.call("close", { session: "s1", tab: opened.value?.tab });
        const after = await c.call("tabs", { session: "s1" });
        c.port.disconnect();
        return { session, opened, ungranted, unknown, loaded, elsewhere, closed, after };
    },

    /** a page's own navigation, and a redirect, to an origin without a grant */
    async held() {
        const c = await greeted();
        await c.call("session", { session: "held", name: "Held", domains: [GRANTED_DOMAIN] });
        const go = await c.call("open", { session: "held", url: site("go", { go: `${OTHER}/test/page/site.html?id=leak-go` }) });
        const redirect = await c.call("open", { session: "held", url: `${GRANTED}/redirect?to=${encodeURIComponent(`${OTHER}/test/page/site.html?id=leak-redirect`)}` });
        const wentBlocked = await tabWhere(c, "held", (t) => t.id === go.value?.tab && t.blocked);
        const redirectBlocked = await tabWhere(c, "held", (t) => t.id === redirect.value?.tab && t.blocked);
        c.port.disconnect();
        return { wentBlocked, redirectBlocked };
    },

    /** tabs a page opens: to a granted origin the session's, elsewhere closed */
    async opened() {
        const c = await greeted();
        await c.call("session", { session: "opener", name: "Opener", domains: [GRANTED_DOMAIN] });
        const refused = await c.call("open", { session: "opener", url: site("opener-refused", { open: `${OTHER}/test/page/site.html?id=leak-open` }) });
        const allowed = await c.call("open", { session: "opener", url: site("opener-allowed", { open: site("opened", { go: `${OTHER}/test/page/site.html?id=leak-opened`, after: "500" }) }) });
        // sent on at once by a redirect, before its rules can be in place
        const raced = await c.call("open", { session: "opener", url: site("opener-raced", { open: `${GRANTED}/redirect?to=${encodeURIComponent(`${OTHER}/test/page/site.html?id=leak-raced`)}` }) });
        const source = await tabWhere(c, "opener", (t) => t.id === refused.value?.tab && t.blocked);
        const child = await tabWhere(c, "opener", (t) => t.blocked?.url.includes("id=leak-opened"));
        const racedSource = await tabWhere(c, "opener", (t) => t.id === raced.value?.tab && t.blocked);
        await sleep(1000);
        const list = await c.call("tabs", { session: "opener" });
        c.port.disconnect();
        // this page is the person's tab in front: the opened one went behind it
        const shown = document.visibilityState;
        return { refused, allowed, raced, source, child, racedSource, tabs: list.value, shown };
    },

    /** a tab of the person's shared with a session: listed for the picker,
     *  read on its site and nowhere else, never acted in, and never held */
    async shared() {
        const c = await greeted();
        // the session holds a grant for the other domain only: reading what the person shared needs none
        await c.call("session", { session: "sharing", name: "Sharing", domains: [OTHER_DOMAIN] });
        const own = await c.call("open", { session: "sharing", url: `${OTHER}/test/page/site.html?id=own` });
        await tabWhere(c, "sharing", (t) => t.title === "site own");
        // the person's own tab, which this page opens as the person would
        const person = window.open(site("person"), "_blank");
        const offered = await until(async () => (await c.call("browsable")).value?.find((t) => t.title === "site person"));
        const browsable = (await c.call("browsable")).value ?? [];
        const tab = offered?.id;
        const refusedOwn = await c.call("share", { session: "sharing", tab: own.value?.tab });
        const shared = await c.call("share", { session: "sharing", tab });
        const twice = await c.call("share", { session: "sharing", tab });
        const listed = (await c.call("tabs", { session: "sharing" })).value?.find((t) => t.id === tab);
        const read = await c.call("read", { session: "sharing", tab });
        const at = { session: "sharing", tab, version: read.value?.version };
        const refused = {
            click: await c.call("click", { ...at, ref: 1 }),
            type: await c.call("type", { ...at, ref: 1, text: "x" }),
            press: await c.call("press", { ...at, ref: 1, key: "Enter" }),
            goto: await c.call("goto", { session: "sharing", tab, url: `${OTHER}/test/page/site.html?id=sent` }),
            close: await c.call("close", { session: "sharing", tab }),
            show: await c.call("show", { session: "sharing", tab }),
        };
        const waited = await c.call("waitFor", { session: "sharing", tab, text: "A page for the tab tests" });
        const scrolled = await c.call("scroll", { session: "sharing", tab });
        const shot = await c.call("screenshot", { session: "sharing", tab });
        // a new grant for the session holds its own tabs, not the person's
        await c.call("session", { session: "sharing", name: "Sharing", domains: [] });
        // the person goes on to another page of the site: not held, and read
        person.location.href = site("person-next");
        const next = await tabWhere(c, "sharing", (t) => t.id === tab && t.title === "site person-next");
        const readNext = await c.call("read", { session: "sharing", tab });
        // and on to another site, where a page opens a tab: neither stopped, and not read there
        person.location.href = `${OTHER}/test/page/site.html?${new URLSearchParams({ id: "person-away", open: site("person-opened") })}`;
        const away = await tabWhere(c, "sharing", (t) => t.id === tab && t.title === "site person-away");
        const opened = await until(async () => (await c.call("browsable")).value?.find((t) => t.title === "site person-opened"));
        const moved = {
            read: await c.call("read", { session: "sharing", tab }),
            waitFor: await c.call("waitFor", { session: "sharing", tab, text: "A page" }),
            screenshot: await c.call("screenshot", { session: "sharing", tab }),
        };
        // back on the site, it reads again
        person.location.href = site("person-back");
        await tabWhere(c, "sharing", (t) => t.id === tab && t.title === "site person-back");
        const back = await c.call("read", { session: "sharing", tab });
        const unshared = await c.call("unshare", { session: "sharing", tab });
        const after = await c.call("read", { session: "sharing", tab });
        const stillOpen = (await c.call("browsable")).value?.some((t) => t.id === tab);
        const ownTabs = (await c.call("tabs", { session: "sharing" })).value?.map((t) => t.id);
        person.close();
        c.port.disconnect();
        return {
            own: own.value?.tab, offered, browsable, refusedOwn, shared, twice, listed, read, refused, waited, scrolled,
            shot: typeof shot.value?.data, next, readNext, away, opened, moved, back, unshared, after, stillOpen, ownTabs,
        };
    },

    /** a tab of the person's shared to act in: clicked and sent on within
     *  its site and the session's grants while the agent acts, its loads
     *  the person's again once that work rests */
    async sharedActing() {
        const c = await greeted();
        await c.call("session", { session: "acting", name: "Acting", domains: [] });
        const away = `${OTHER}/test/page/site.html?id=act-away`;
        const later = `${OTHER}/test/page/site.html?id=act-later`;
        const person = window.open(site("act-person", { next: site("act-next", { away, later }), away }), "_blank");
        const tab = (await until(async () => (await c.call("browsable")).value?.find((t) => t.title === "site act-person")))?.id;
        const shared = await c.call("share", { session: "acting", tab, acts: true });
        const listed = (await c.call("tabs", { session: "acting" })).value?.find((t) => t.id === tab);
        const at = { session: "acting", tab };
        let page = (await c.call("read", at)).value;
        const next = await c.call("click", { ...at, version: page.version, ref: refOf(page.text, "Next page") });
        page = (await c.call("read", at)).value;
        const awayClick = await c.call("click", { ...at, version: page.version, ref: refOf(page.text, "Somewhere else") });
        // granted while the agent acts there: its hold follows at once
        await c.call("session", { session: "acting", name: "Acting", domains: [OTHER_DOMAIN] });
        page = (await c.call("read", at)).value;
        const laterClick = await c.call("click", { ...at, version: page.version, ref: refOf(page.text, "Granted later") });
        await c.call("session", { session: "acting", name: "Acting", domains: [] });
        person.location.href = site("act-next", { away });
        await tabWhere(c, "acting", (t) => t.id === tab && t.title === "site act-next" && !t.url.includes("later"));
        const gotoSite = await c.call("goto", { ...at, url: site("act-goto") });
        const gotoAway = await c.call("goto", { ...at, url: away });
        const close = await c.call("close", at);
        // a handoff rests the agent's work: the person browses anywhere again
        const shown = await c.call("show", at);
        person.location.href = `${OTHER}/test/page/site.html?id=act-free`;
        const free = await tabWhere(c, "acting", (t) => t.id === tab && t.title === "site act-free");
        person.location.href = site("act-back");
        await tabWhere(c, "acting", (t) => t.id === tab && t.title === "site act-back");
        // only to read, again
        const toRead = await c.call("shareMode", { ...at, acts: false });
        page = (await c.call("read", at)).value;
        const readOnly = await c.call("click", { ...at, version: page.version, ref: 1 });
        const listedAfter = (await c.call("tabs", { session: "acting" })).value?.find((t) => t.id === tab);
        person.close();
        // a first step that fails before it acts (a stale outline) leaves no hold behind, once the share is read only
        const second = window.open(site("act-second"), "_blank");
        const tab2 = (await until(async () => (await c.call("browsable")).value?.find((t) => t.title === "site act-second")))?.id;
        await c.call("share", { session: "acting", tab: tab2, acts: true });
        const staleFirst = await c.call("click", { session: "acting", tab: tab2, version: 99, ref: 1 });
        await c.call("shareMode", { session: "acting", tab: tab2, acts: false });
        second.location.href = `${OTHER}/test/page/site.html?id=act-second-free`;
        const secondFree = await tabWhere(c, "acting", (t) => t.id === tab2 && t.title === "site act-second-free");
        second.close();
        c.port.disconnect();
        return { shared, listed, next, awayClick, laterClick, gotoSite, gotoAway, close, shown, free, toRead, readOnly, listedAfter, staleFirst, secondFree };
    },

    /** a tab shared from the toolbar: kept until the studio takes it,
     *  the studio brought to the front to ask, and turned down or taken */
    async toolbar() {
        const c = await greeted();
        await c.call("session", { session: "toolbar", name: "Toolbar", domains: [] });
        const person = window.open(site("toolbar-person"), "_blank");
        const tab = (await until(async () => (await c.call("browsable")).value?.find((t) => t.title === "site toolbar-person")))?.id;
        await until(async () => document.visibilityState === "hidden");
        const hidden = document.visibilityState;
        // the popup's Share, as the dev build stands in for it
        const offered = await c.call("offer", { tab });
        const told = await until(async () => c.events.includes("shares"));
        const front = await until(async () => document.visibilityState === "visible");
        const waiting = (await c.call("shares")).value;
        const offeredOwn = await c.call("offer", { tab: (await c.call("open", { session: "toolbar", url: site("toolbar-own") })).value?.tab });
        const dropped = await c.call("drop", { tab });
        const afterDrop = (await c.call("shares")).value;
        await c.call("offer", { tab });
        const taken = await c.call("take", { session: "toolbar", tab });
        const takenTwice = await c.call("take", { session: "toolbar", tab });
        const afterTake = (await c.call("shares")).value;
        const listed = (await c.call("tabs", { session: "toolbar" })).value?.find((t) => t.id === tab);
        const read = await c.call("read", { session: "toolbar", tab });
        // a share waiting for a tab since closed isn't listed
        const gone = window.open(site("toolbar-gone"), "_blank");
        const goneTab = (await until(async () => (await c.call("browsable")).value?.find((t) => t.title === "site toolbar-gone")))?.id;
        await c.call("offer", { tab: goneTab });
        gone.close();
        const afterClose = await until(async () => {
            const w = (await c.call("shares")).value;
            return w && !w.some((s) => s.tab === goneTab) ? w : null;
        });
        person.close();
        c.port.disconnect();
        return { tab, hidden, offered, told, front, waiting, offeredOwn, dropped, afterDrop, taken, takenTwice, afterTake, listed, read: read.value?.title ?? read.error, afterClose };
    },

    /** a popup window a page opens, which takes no tab group */
    async popup() {
        const c = await greeted();
        await c.call("session", { session: "popup", name: "Popup", domains: [GRANTED_DOMAIN] });
        await c.call("open", { session: "popup", url: site("popup-opener", { open: site("popup"), popup: "1" }) });
        const popup = await tabWhere(c, "popup", (t) => t.title === "site popup");
        c.port.disconnect();
        return { popup };
    },

    /** a session's grants replaced, and its open tabs held to the new ones */
    async regrant() {
        const c = await greeted();
        await c.call("session", { session: "narrow", name: "Narrow", domains: [GRANTED_DOMAIN] });
        await c.call("session", { session: "wide", name: "Wide", domains: [GRANTED_DOMAIN] });
        const narrow = await c.call("open", { session: "narrow", url: site("narrow", { go: site("after-narrow"), after: "4000" }) });
        const wide = await c.call("open", { session: "wide", url: site("wide", { go: `${OTHER}/test/page/site.html?id=after-wide`, after: "4000" }) });
        await tabWhere(c, "narrow", (t) => t.title === "site narrow");
        await tabWhere(c, "wide", (t) => t.title === "site wide");
        await c.call("session", { session: "narrow", name: "Narrow", domains: [] });
        await c.call("session", { session: "wide", name: "Wide", domains: [GRANTED_DOMAIN, OTHER_DOMAIN] });
        const narrowed = await tabWhere(c, "narrow", (t) => t.id === narrow.value?.tab && t.blocked);
        const widened = await tabWhere(c, "wide", (t) => t.id === wide.value?.tab && t.title === "site after-wide");
        c.port.disconnect();
        return { narrowed, widened };
    },

    /** the registry and the rules outlive the worker's idle stop */
    async restart() {
        const c = await greeted();
        await c.call("session", { session: "kept", name: "Kept", domains: [GRANTED_DOMAIN] });
        const opened = await c.call("open", { session: "kept", url: site("kept", { go: `${OTHER}/test/page/site.html?id=leak-kept`, after: "45000" }) });
        while (c.dropped === null && performance.now() - c.opened < 90_000) await sleep(500);
        const stoppedAfterMs = c.dropped === null ? null : Math.round(c.dropped - c.opened);
        const again = await greeted();
        const listed = (await again.call("tabs", { session: "kept" })).value?.map((t) => t.id);
        const blocked = await tabWhere(again, "kept", (t) => t.id === opened.value?.tab && t.blocked, 40_000);
        again.port.disconnect();
        return { tab: opened.value?.tab, stoppedAfterMs, listed, blocked };
    },

    /** a page read, waited on, sent on and shot */
    async pages() {
        const c = await greeted();
        await c.call("turn", { running: true });
        await c.call("session", { session: "pages", name: "Pages", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await c.call("open", { session: "pages", url: `${GRANTED}/test/page/hotel.html` });
        const at = { session: "pages", tab };
        // two calls at once in a tab not yet worked in
        const [first, together] = await Promise.all([c.call("read", at), c.call("screenshot", at)]);
        const second = await c.call("read", { ...at, maxChars: 200 });
        const working = (await c.call("tabs", { session: "pages" })).value?.[0]?.working;
        const rates = await c.call("waitFor", { ...at, text: "Rates loaded" });
        const never = await c.call("waitFor", { ...at, selector: "#nope", timeout: 500 });
        const badSelector = await c.call("waitFor", { ...at, selector: "[[" });
        const shot = await c.call("screenshot", at);
        const went = await c.call("goto", { ...at, url: site("went") });
        const ungranted = await c.call("goto", { ...at, url: `${OTHER}/test/page/site.html?id=leak-goto` });
        const redirected = await c.call("goto", { ...at, url: `${GRANTED}/redirect?to=${encodeURIComponent(`${OTHER}/test/page/site.html?id=leak-goto-redirect`)}` });
        const afterBlock = await c.call("read", at);
        await c.call("turn", { running: false });
        const rested = (await c.call("tabs", { session: "pages" })).value?.[0]?.working;
        const other = await c.call("read", { session: "nobody", tab });
        c.port.disconnect();
        return {
            first, together: together.error ?? together.value?.mime, second, working, rates, never, badSelector, went, ungranted, redirected, afterBlock, rested, other,
            shot: shot.error ?? { mime: shot.value?.mime, bytes: shot.value?.data?.length },
        };
    },

    /** clicks, typing and choices, by the refs of an outline */
    async actions() {
        const c = await greeted();
        await c.call("turn", { running: true });
        await c.call("session", { session: "act", name: "Act", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await c.call("open", { session: "act", url: `${GRANTED}/test/page/form.html` });
        const at = { session: "act", tab };
        const first = (await c.call("read", at)).value;
        const on = (outline, label) => ({ ...at, version: outline.version, ref: refOf(outline.text, label) });
        const r = {
            photos: await c.call("click", on(first, "Show photos")),
            reserve: await c.call("click", on(first, "Reserve")),
            reserveConfirmed: await c.call("click", { ...on(first, "Reserve"), confirmed: true }),
            pay: await c.call("type", { ...on(first, "Card name"), text: "A. Person", submit: true }),
            notes: await c.call("type", { ...on(first, "Notes"), text: "hello" }),
            notesMore: await c.call("type", { ...on(first, "Notes"), text: " there", clear: false }),
            notesCleared: await c.call("type", { ...on(first, "Notes"), text: "" }),
            guests: await c.call("select", { ...on(first, "Guests"), value: "2" }),
            noOption: await c.call("select", { ...on(first, "Guests"), value: "9" }),
            disabledOption: await c.call("select", { ...on(first, "Guests"), value: "3" }),
            disabledGroup: await c.call("select", { ...on(first, "Guests"), value: "10" }),
            iconDelete: await c.call("click", on(first, "Delete")),
            labelledDelete: await c.call("click", on(first, "Delete booking")),
            nights: await c.call("type", { ...on(first, "Nights"), text: "4", clear: false }),
            arrive: await c.call("type", { ...on(first, "Arrive"), text: "2026-12-03" }),
            arriveBad: await c.call("type", { ...on(first, "Arrive"), text: "Dec 3" }),
            departReadOnly: await c.call("type", { ...on(first, "Depart"), text: "2026-12-07" }),
            colourBad: await c.call("type", { ...on(first, "Colour"), text: "red" }),
            covered: await c.call("click", on(first, "Under the banner")),
            half: await c.call("click", on(first, "Half covered")),
            rowClick: await c.call("click", on(first, "From 583 to Lisbon")),
            rowKey: await c.call("press", { ...on(first, "From 583 to Lisbon"), key: "Enter" }),
            rowCovered: await c.call("click", on(first, "From 706 to Lisbon")),
            pressReserve: await c.call("press", { ...on(first, "Reserve"), key: "Enter" }),
            pressPay: await c.call("press", { ...on(first, "Card name"), key: "Enter" }),
            pressBadKey: await c.call("press", { ...on(first, "Tag"), key: "F5" }),
            pressTag: await c.call("press", { ...on(first, "Tag"), key: "Enter" }),
            bookTab: await c.call("click", on(first, "Book hotel")),
            publishSwitch: await c.call("click", on(first, "Publish")),
            day23: await c.call("click", on(first, "23")),
            day24: await c.call("click", on(first, "24")),
            // a field inside it focused already: the key would reach that (submitting by "Book now"), not the ref
            innerFocused: await c.call("click", on(first, "Focus inside")),
            pressWrapper: await c.call("press", { ...on(first, "Wrapped"), key: "Enter" }),
            comboType: await c.call("type", { ...on(first, "Course search"), text: "Corvallis" }),
            comboEmpty: await c.call("type", { ...on(first, "Empty picker"), text: "Albany" }),
            refresh: await c.call("click", on(first, "Refresh list")),
            refreshAgain: await c.call("click", on(first, "Refresh list")),
        };
        r.kinds = Object.fromEntries(["Arrive", "From 583 to Lisbon", "Reserve", "Guests"].map((name) => [name, first.refs.find((x) => x.name === name)?.kind]));
        r.refsListed = first.refs.every((x, i) => x.ref === i + 1);
        const second = (await c.call("read", at)).value;
        r.out = /Out: (.*)$/m.exec(second.text)?.[1];
        r.comboValue = second.text.split("\n").filter((l) => /Course search|Type a place|Corvallis/.test(l)).join(" / ");
        // what the refused values left in their fields
        r.fields = /\[\d+\] date field "Arrive"[^\n]*/.exec(second.text)?.[0] + " | " + /\[\d+\] color field "Colour"[^\n]*/.exec(second.text)?.[0];
        r.olderOutline = await c.call("click", on(first, "Show photos"));
        r.search = await c.call("type", { ...on(second, "Where"), text: "Lisbon", submit: true });
        r.otherPage = await c.call("click", on(second, "Show photos"));
        const third = (await c.call("read", at)).value;
        r.away = await c.call("click", on(third, "Elsewhere"));
        await c.call("turn", { running: false });
        c.port.disconnect();
        return r;
    },

    /** two studio tabs' turns at once: one ending rests nothing the other works in */
    async twoTurns() {
        const a = await greeted();
        const b = await greeted();
        await a.call("turn", { running: true });
        await b.call("turn", { running: true });
        await b.call("session", { session: "two", name: "Two", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await b.call("open", { session: "two", url: site("two") });
        await b.call("read", { session: "two", tab });
        await a.call("turn", { running: false });
        const afterOne = (await b.call("tabs", { session: "two" })).value?.[0]?.working;
        // a studio tab closed mid-turn has ended its turn
        await a.call("turn", { running: true });
        b.port.disconnect();
        await sleep(200);
        const c = await greeted();
        const stillOne = (await c.call("tabs", { session: "two" })).value?.[0]?.working;
        await a.call("turn", { running: false });
        const afterAll = (await c.call("tabs", { session: "two" })).value?.[0]?.working;
        a.port.disconnect();
        c.port.disconnect();
        return { afterOne, stillOne, afterAll };
    },

    /** a list that loads as it is scrolled, and a page that draws its results late */
    async loading() {
        const c = await greeted();
        await c.call("session", { session: "loading", name: "Loading", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await c.call("open", { session: "loading", url: `${GRANTED}/test/page/lazy.html` });
        const at = { session: "loading", tab };
        const first = (await c.call("read", at)).value;
        const down = (await c.call("scroll", { ...at, to: "down" })).value;
        const bottom = (await c.call("scroll", { ...at, to: "bottom" })).value;
        const all = (await c.call("read", at)).value;
        const badTo = await c.call("scroll", { ...at, to: "sideways" });
        const swallow = (await c.call("open", { session: "loading", url: `${GRANTED}/test/page/swallow.html` })).value.tab;
        await tabWhere(c, "loading", (t) => t.id === swallow && t.title === "A long page");
        const swallowed = await c.call("scroll", { session: "loading", tab: swallow, to: "bottom" });
        const slow = (await c.call("open", { session: "loading", url: `${GRANTED}/test/page/slow.html` })).value.tab;
        const early = (await c.call("read", { session: "loading", tab: slow })).value;
        const late = (await c.call("read", { session: "loading", tab: slow, settle: true })).value;
        await c.call("turn", { running: false });
        c.port.disconnect();
        const hotels = (/** @type {string} */ t) => (t.match(/Hotel \d+/g) ?? []).length;
        return {
            first: { hotels: hotels(first.text), below: first.below },
            down, bottom,
            all: { hotels: hotels(all.text), below: all.below ?? 0 },
            badTo,
            swallowed,
            early: /Searching|loading rates/.test(early.text),
            late: { text: /Hotel Avenida €124/.test(late.text), settled: late.settled ?? true },
        };
    },

    /** pages that are a CAPTCHA or a bot check */
    async blockers() {
        const c = await greeted();
        await c.call("session", { session: "blockers", name: "Blockers", domains: [GRANTED_DOMAIN] });
        const read = async (page) => {
            const { value } = await c.call("open", { session: "blockers", url: `${GRANTED}/test/page/${page}` });
            return (await c.call("read", { session: "blockers", tab: value.tab })).value?.blocker;
        };
        const report = {
            captcha: await read("captcha.html"), checking: await read("checking.html"), hotel: await read("hotel.html"),
            badge: await read("badge.html"), resort: await read("resort.html"),
            overlay: await read("overlay.html"), wall: await read("wall.html"),
        };
        // a consent notice, read after the page's own text
        const { value: { tab: consent } } = await c.call("open", { session: "blockers", url: `${GRANTED}/test/page/consent.html` });
        const short = (await c.call("read", { session: "blockers", tab: consent, maxChars: 150 })).value;
        const whole = (await c.call("read", { session: "blockers", tab: consent })).value;
        report.notice = { short: short.text, whole: whole.text, accept: whole.refs.find((x) => x.name === "Accept all")?.kind };
        await c.call("turn", { running: false });
        c.port.disconnect();
        return report;
    },

    /** a grant for a domain covers its subdomains, and only them */
    async subdomains() {
        const c = await greeted();
        const sub = `http://hotels.localhost:${location.port}/test/page/site.html?id=sub`;
        await c.call("session", { session: "wide-domain", name: "Domain", domains: ["localhost"] });
        await c.call("session", { session: "narrow-domain", name: "IP", domains: [GRANTED_DOMAIN] });
        const opened = await c.call("open", { session: "wide-domain", url: sub });
        const loaded = await tabWhere(c, "wide-domain", (t) => t.title === "site sub");
        const refused = await c.call("open", { session: "narrow-domain", url: sub.replace("id=sub", "id=sub-refused") });
        const notDomain = await c.call("session", { session: "x", name: "X", domains: ["https://marriott.com"] });
        const topLevel = await c.call("session", { session: "x", name: "X", domains: ["com"] });
        const known = (await c.call("sessions")).value?.find((s) => s.session === "wide-domain");
        c.port.disconnect();
        return { opened, loaded, refused, notDomain, topLevel, known };
    },

    /** a tab brought to the front for the person's hands */
    async show() {
        const c = await greeted();
        await c.call("session", { session: "shown", name: "Shown", domains: [GRANTED_DOMAIN] });
        const { value: { tab } } = await c.call("open", { session: "shown", url: site("shown") });
        const { value: { version } } = await c.call("read", { session: "shown", tab });
        const before = document.visibilityState;
        const shown = await c.call("show", { session: "shown", tab });
        await sleep(300);
        // this page, the studio's, went behind it
        const after = document.visibilityState;
        const working = (await c.call("tabs", { session: "shown" })).value?.[0]?.working;
        const elsewhere = await c.call("show", { session: "nobody", tab });
        // the person had the page: what was read before it is stale
        const afterHands = await c.call("click", { session: "shown", tab, version, ref: 1 });
        c.port.disconnect();
        return { before, shown, after, working, elsewhere, afterHands };
    },

    /** the studio's tab kept from discarding while a turn runs */
    async turn() {
        const c = await greeted();
        const running = await c.call("turn", { running: true });
        const done = await c.call("turn", { running: false });
        c.port.disconnect();
        return { running, done };
    },
};

// Two domains on the harness's one server: the tab tests grant the first.
const GRANTED_DOMAIN = "127.0.0.1";
const OTHER_DOMAIN = "localhost";
const GRANTED = `http://${GRANTED_DOMAIN}:${location.port}`;
const OTHER = `http://${OTHER_DOMAIN}:${location.port}`;

/** The fixture site on the granted origin. @param {string} id @param {Record<string, string>} [more] */
const site = (id, more = {}) => `${GRANTED}/test/page/site.html?${new URLSearchParams({ id, ...more })}`;

/** The ref an outline gives the control labelled `label`. */
function refOf(text, label) {
    const m = new RegExp(`\\[(\\d+)\\] [^\\n\\[]*?"${label}"`).exec(text);
    return m ? Number(m[1]) : -1;
}

async function greeted() {
    const c = connect();
    await c.call("hello", { protocol: PROTOCOL });
    return c;
}

/** What `get` resolves to once it's something, polled for up to 15 s, or null. */
async function until(get, ms = 15_000) {
    const end = performance.now() + ms;
    while (performance.now() < end) {
        const found = await get();
        if (found) return found;
        await sleep(100);
    }
    return null;
}

/** The first of a session's tabs that `test` takes, polled for up to 15 s, or null. */
async function tabWhere(c, session, test, ms = 15_000) {
    const until = performance.now() + ms;
    while (performance.now() < until) {
        const found = (await c.call("tabs", { session })).value?.find(test);
        if (found) return found;
        await sleep(100);
    }
    return null;
}

const names = (params.get("scenarios") ?? "").split(",").filter(Boolean);
for (const name of names) {
    let report;
    try {
        report = await SCENARIOS[name]();
    } catch (e) {
        report = { failed: String(e?.message ?? e) };
    }
    await post(name, report);
}
