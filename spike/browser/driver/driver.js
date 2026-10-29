// Spike: the studio half. Connects to the extension, runs each scenario
// against the fixture site (another origin), and posts what it measured
// to the spike's server.

const EXT = new URLSearchParams(location.search).get("ext")
const SITE = new URLSearchParams(location.search).get("site") ?? "http://localhost:4174"
const only = new URLSearchParams(location.search).get("only")
const log = (line) => {
    document.getElementById("log").textContent += line + "\n"
    fetch("/results", { method: "POST", body: JSON.stringify({ log: line }) }).catch(() => {})
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const port = chrome.runtime.connect(EXT)
let next = 0
const waiting = new Map()
port.onMessage.addListener((m) => { const w = waiting.get(m.id); waiting.delete(m.id); m.error ? w.no(Object.assign(new Error(m.error), { ms: m.ms })) : w.yes(m) })
port.onDisconnect.addListener(() => { log("port disconnected"); for (const w of waiting.values()) w.no(new Error("port disconnected")); waiting.clear() })
const call = (op, args = {}) => new Promise((yes, no) => {
    const id = ++next
    const timer = setTimeout(() => { waiting.delete(id); no(new Error(`${op}: no reply in 20s`)) }, 20000)
    waiting.set(id, { yes: (m) => { clearTimeout(timer); yes(m) }, no: (e) => { clearTimeout(timer); no(e) } })
    log(`  > ${op}`)
    port.postMessage({ id, op, ...args })
})
const val = async (op, args) => (await call(op, args)).value
/** a call whose failure is a finding, not a crash */
const attempt = async (op, args) => { try { const r = await call(op, args); return { ok: true, ms: r.ms, value: r.value } } catch (e) { return { ok: false, ms: e.ms, error: e.message } } }

async function post(name, data) {
    await fetch("/results", { method: "POST", body: JSON.stringify({ name, data }) })
}

/** One way of hosting the agent's tabs: open three at once, let them
 *  sit, then read, act and screenshot in each way Chrome offers. */
async function scenario(name, mode, { wake = null, cover = false, settle = 6000 } = {}) {
    log(`== ${name}`)
    const url = `${SITE}/lazy.html`
    const out = { mode, wake, cover, settleMs: settle, studioVisibility: document.visibilityState }
    const opened = await Promise.all([1, 2, 3].map(() => val("open", { url, mode, group: "agex: spike" })))
    if (wake) for (const t of opened) await val("wake", { tabId: t.tabId, how: wake })
    const covers = cover ? await Promise.all(opened.map((t) => val("cover", { windowId: t.windowId }))) : []
    await sleep(settle)
    const tabId = opened[0].tabId
    out.window = await val("windowState", { tabId })
    out.probes = await Promise.all(opened.map((t) => val("probe", { tabId: t.tabId })))
    const outline = await val("outline", { tabId })
    out.outline = { chars: outline.chars, refs: outline.refs, blocked: outline.blocked }
    out.outlineText = outline.text
    const ref = (label) => outline.text.split("\n").find((l) => l.includes(label))?.match(/^\[(\d+)\]/)?.[1]
    const button = ref('"Check availability"'), dest = ref("input:text")

    out.scriptType = await attempt("type", { tabId, ref: dest, text: "Lisbon", via: "script" })
    out.scriptClick = await attempt("click", { tabId, ref: button, via: "script" })
    out.cdpType = await attempt("type", { tabId, ref: dest, text: " Porto", via: "cdp" })
    out.cdpClick = await attempt("click", { tabId, ref: button, via: "cdp" })
    out.afterInput = await val("probe", { tabId })

    out.shotVisible = await attempt("screenshot", { tabId, via: "visible" })
    out.shotCdp = await attempt("screenshot", { tabId, via: "cdp" })

    await val("scrollTo", { tabId, selector: "#more" })
    await sleep(1500)
    const after = await val("probe", { tabId })
    out.lazyAfterScroll = after.lazy
    out.framedAfterScroll = after.framed

    if (wake) {
        // and once the debugger lets go?
        await val("detach", { tabId: opened[1].tabId })
        await sleep(3000)
        const d = await val("probe", { tabId: opened[1].tabId })
        out.afterDetach = { visibility: d.visibility, rafs: d.rafs }
    }
    await post(name, out)
    for (const c of covers) await attempt("close", { tabId: c.coverTabId })
    for (const t of opened) await attempt("close", { tabId: t.tabId })
    const p = out.probes[0]
    log(`  visibility=${p.visibility} intervals=${p.intervals} chain=${p.chain} rafs=${p.rafs} fetched=${p.fetched} framed=${p.framed} lazy(after scroll)=${after.lazy}`)
    log(`  clicks=${JSON.stringify(out.afterInput.clicks)} inputs=${JSON.stringify(out.afterInput.inputs)}`)
    log(`  shotVisible=${JSON.stringify(out.shotVisible)} shotCdp=${out.shotCdp.ok ? "ok " + out.shotCdp.ms + "ms" : out.shotCdp.error}`)
}

/** The studio's own tab hidden while one of the agent's is in front:
 *  do its timers and the port keep going? */
async function studioHidden() {
    log("== studio-hidden")
    const before = document.visibilityState
    const t = await val("open", { url: `${SITE}/lazy.html`, mode: "tab" })
    let ticks = 0
    const timer = setInterval(() => ticks++, 100)
    await val("activate", { tabId: t.tabId })
    const hiddenAt = document.visibilityState
    const t0 = performance.now()
    await sleep(6000)
    const elapsed = performance.now() - t0
    const portRoundTrip = await attempt("probe", { tabId: t.tabId })
    clearInterval(timer)
    await val("activate", {})
    await val("close", { tabId: t.tabId })
    const out = { visibilityBefore: before, visibilityWhileAway: hiddenAt, ticksIn6s: ticks, sleepElapsedMs: Math.round(elapsed), portRoundTrip }
    await post("studio-hidden", out)
    log(`  visibility=${hiddenAt} ticks=${ticks} (60 if unthrottled) sleep=${Math.round(elapsed)}ms agentTab=${portRoundTrip.value?.visibility}`)
}

const SCENARIOS = {
    "bg-tab": () => scenario("bg-tab", "tab"),
    "bg-tab-attach": () => scenario("bg-tab-attach", "tab", { wake: "attach" }),
    "bg-tab-page": () => scenario("bg-tab-page", "tab", { wake: "page" }),
    "bg-tab-focus": () => scenario("bg-tab-focus", "tab", { wake: "focus" }),
    "window": () => scenario("window", "window"),
    "window-covered": () => scenario("window-covered", "window", { cover: true }),
    "window-covered-attach": () => scenario("window-covered-attach", "window", { cover: true, wake: "attach" }),
    "minimized": () => scenario("minimized", "minimized"),
    "minimized-focus": () => scenario("minimized-focus", "minimized", { wake: "focus" }),
    "window-covered-focus": () => scenario("window-covered-focus", "window", { cover: true, wake: "focus" }),
    "studio-hidden": studioHidden,
}

;(async () => {
    try {
        for (const [name, run] of Object.entries(SCENARIOS)) {
            if (only && !only.split(",").includes(name)) continue
            try { await run() } catch (e) { log(`  FAILED: ${e.message}`); await post(name, { failed: e.message }) }
        }
    } finally {
        await post("done", { at: new Date().toISOString(), ua: navigator.userAgent })
        log("done")
    }
})()
