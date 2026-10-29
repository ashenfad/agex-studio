// Spike: the extension half. A page on the studio's origin connects a
// port; each message is { id, op, ...args } and gets { id, value } or
// { id, error } back. Ops open, read, act in and close tabs, three ways
// each where Chrome offers more than one, so the spike can compare them.

const attached = new Set()

chrome.runtime.onConnectExternal.addListener((port) => {
    const windowId = port.sender?.tab?.windowId
    const senderTabId = port.sender?.tab?.id
    port.onMessage.addListener(async (msg) => {
        const t0 = performance.now()
        try {
            const value = await OPS[msg.op]({ ...msg, windowId, senderTabId })
            port.postMessage({ id: msg.id, value, ms: Math.round(performance.now() - t0) })
        } catch (e) {
            port.postMessage({ id: msg.id, error: String(e?.message ?? e), ms: Math.round(performance.now() - t0) })
        }
    })
})

const withTimeout = (p, ms, what) =>
    Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what}: no answer in ${ms}ms`)), ms))])

async function loaded(tabId, ms = 20000) {
    try {
        return await waitLoaded(tabId, ms)
    } catch (e) {
        const tab = await chrome.tabs.get(tabId)
        throw new Error(`${e.message} (status ${tab.status}, url ${tab.url || tab.pendingUrl}, discarded ${tab.discarded})`)
    }
}

async function waitLoaded(tabId, ms) {
    const until = Date.now() + ms
    while (Date.now() < until) {
        const tab = await chrome.tabs.get(tabId)
        if (tab.status === "complete" && tab.url && tab.url !== "about:blank") return tab
        await new Promise((r) => setTimeout(r, 100))
    }
    throw new Error(`load: no answer in ${ms}ms`)
}

async function cdp(tabId, method, params = {}) {
    if (!attached.has(tabId)) {
        await chrome.debugger.attach({ tabId }, "1.3")
        attached.add(tabId)
    }
    return chrome.debugger.sendCommand({ tabId }, method, params)
}
chrome.debugger.onDetach.addListener(({ tabId }) => attached.delete(tabId))

const run = async (tabId, func, args = []) =>
    (await chrome.scripting.executeScript({ target: { tabId }, func, args, world: "MAIN" }))[0]?.result

const OPS = {
    /** mode: "tab" (background tab in the studio's window), "window"
     *  (a window of its own, not focused), "minimized". */
    async open({ url, mode = "tab", group, windowId }) {
        let tab
        if (mode === "tab") {
            tab = await chrome.tabs.create({ url, active: false, windowId })
        } else {
            const win = await chrome.windows.create({
                url, focused: false, ...(mode === "minimized" ? { state: "minimized" } : { width: 900, height: 700, left: 40, top: 40 }),
            })
            tab = win.tabs[0]
            if (mode === "minimized") await chrome.windows.update(win.id, { state: "minimized" })
        }
        if (group) {
            const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } })
            await chrome.tabGroups.update(groupId, { title: group, color: "purple", collapsed: false })
        }
        await loaded(tab.id)
        return { tabId: tab.id, windowId: tab.windowId }
    },

    /** what the debugger does for a hidden tab, step by step:
     *  "attach" alone, "page" (+ Page.enable), "focus" (+ focus emulation) */
    async wake({ tabId, how = "focus" }) {
        await cdp(tabId, "Runtime.evaluate", { expression: "1" })
        if (how === "attach") return true
        await cdp(tabId, "Page.enable")
        if (how === "page") return true
        await cdp(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true })
        return true
    },

    async detach({ tabId }) {
        await chrome.debugger.detach({ tabId })
        return true
    },

    /** a normal window over the given one, to occlude it */
    async cover({ windowId: over }) {
        const w = await chrome.windows.get(over)
        const c = await chrome.windows.create({ url: "about:blank", focused: true, left: w.left, top: w.top, width: w.width, height: w.height })
        return { coverId: c.id, coverTabId: c.tabs[0].id }
    },

    async windowState({ tabId }) {
        const tab = await chrome.tabs.get(tabId)
        const w = await chrome.windows.get(tab.windowId)
        return { state: w.state, focused: w.focused }
    },

    async closeWindow({ id }) {
        await chrome.windows.remove(id)
        return true
    },

    async probe({ tabId }) {
        const tab = await chrome.tabs.get(tabId)
        const page = await run(tabId, () => ({
            ...window.__probe,
            visibility: document.visibilityState,
            focus: document.hasFocus(),
            elapsed: Math.round(performance.now() - window.__probe.t0),
        }))
        return { active: tab.active, discarded: tab.discarded, ...page }
    },

    async probeVisibility({ tabId }) {
        return run(tabId, () => ({ visibility: document.visibilityState, focus: document.hasFocus() }))
    },

    async outline({ tabId }) {
        return run(tabId, outlinePage)
    },

    async scrollTo({ tabId, selector }) {
        return run(tabId, (sel) => { document.querySelector(sel)?.scrollIntoView(); return true }, [selector])
    },

    /** via: "script" (el.click() in the page), "cdp" (a real mouse
     *  event through the debugger, at the element's centre). */
    async click({ tabId, ref, via = "script" }) {
        const sel = `[data-agex-ref="${ref}"]`
        if (via === "script") {
            return run(tabId, (s) => { const el = document.querySelector(s); if (!el) return false; el.click(); return true }, [sel])
        }
        const box = await run(tabId, (s) => {
            const el = document.querySelector(s); if (!el) return null
            el.scrollIntoView({ block: "center" })
            const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
        }, [sel])
        if (!box) return false
        for (const type of ["mousePressed", "mouseReleased"]) {
            await withTimeout(cdp(tabId, "Input.dispatchMouseEvent", { type, x: box.x, y: box.y, button: "left", clickCount: 1 }), 5000, "cdp click")
        }
        return true
    },

    async type({ tabId, ref, text, via = "script" }) {
        const sel = `[data-agex-ref="${ref}"]`
        if (via === "script") {
            return run(tabId, (s, t) => {
                const el = document.querySelector(s); if (!el) return false
                el.focus()
                const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set
                set.call(el, t)
                el.dispatchEvent(new Event("input", { bubbles: true }))
                el.dispatchEvent(new Event("change", { bubbles: true }))
                return true
            }, [sel, text])
        }
        await run(tabId, (s) => document.querySelector(s)?.focus(), [sel])
        await withTimeout(cdp(tabId, "Input.insertText", { text }), 5000, "cdp type")
        return true
    },

    async goto({ tabId, url }) {
        await chrome.tabs.update(tabId, { url })
        await new Promise((r) => setTimeout(r, 200))
        await loaded(tabId)
        return true
    },

    /** via: "visible" (captureVisibleTab: the window's active tab, which
     *  may not be this one), "cdp" (Page.captureScreenshot). */
    async screenshot({ tabId, via = "visible" }) {
        const tab = await chrome.tabs.get(tabId)
        if (via === "visible") {
            const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 60 })
            return { capturedActiveTab: tab.active, bytes: url.length }
        }
        const { data } = await withTimeout(cdp(tabId, "Page.captureScreenshot", { format: "jpeg", quality: 60 }), 8000, "cdp screenshot")
        return { bytes: data.length }
    },

    async activate({ tabId, senderTabId }) {
        await chrome.tabs.update(tabId ?? senderTabId, { active: true })
        return true
    },

    async close({ tabId }) {
        if (attached.has(tabId)) await chrome.debugger.detach({ tabId }).catch(() => {})
        await chrome.tabs.remove(tabId)
        return true
    },
}

/** Injected into the page: its text as an outline, with a numbered ref
 *  on each thing that can be clicked or typed into, and a blocker when
 *  the page is a bot check. Self-contained (it runs in the page). */
function outlinePage() {
    const BLOCKERS = [
        [/recaptcha|hcaptcha|challenges\.cloudflare|captcha-delivery|px-captcha|arkoselabs|funcaptcha/i, "captcha"],
    ]
    const TITLES = [/just a moment|access denied|attention required|pardon our interruption|are you a (human|robot)|verify you are human|request unsuccessful/i]
    let blocked = null
    for (const f of document.querySelectorAll("iframe, script[src]")) {
        for (const [re, why] of BLOCKERS) if (re.test(f.src || "")) blocked = why
    }
    if (TITLES.some((re) => re.test(document.title) || re.test(document.body?.innerText.slice(0, 400) ?? ""))) blocked ??= "bot-check"

    const INTERACTIVE = "a[href], button, input, select, textarea, [role=button], [role=link], [role=option], [role=tab], [role=checkbox], [onclick]"
    let n = 0
    const lines = []
    const seen = new Set()
    const label = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.placeholder || el.title || el.name || "").replace(/\s+/g, " ").trim().slice(0, 80)
    const visible = (el) => el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : true
    const walk = (node, depth) => {
        if (node.nodeType === Node.TEXT_NODE) {
            const t = node.textContent.replace(/\s+/g, " ").trim()
            if (t && !seen.has(node.parentElement)) lines.push(t)
            return
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return
        const el = /** @type {HTMLElement} */ (node)
        if (["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "TEMPLATE"].includes(el.tagName.toUpperCase())) return
        if (!visible(el)) return
        if (el.matches(INTERACTIVE)) {
            n += 1
            el.setAttribute("data-agex-ref", String(n))
            const kind = el.tagName === "A" ? "link" : el.tagName === "INPUT" ? `input:${el.type}` : el.getAttribute("role") || el.tagName.toLowerCase()
            const extra = el.tagName === "SELECT" ? ` = ${el.value}` : el.tagName === "INPUT" && el.value ? ` = ${el.value.slice(0, 40)}` : ""
            lines.push(`[${n}] ${kind} "${label(el)}"${extra}`)
            seen.add(el)
            for (const c of el.children) seen.add(c)
            if (el.tagName !== "SELECT") return
        }
        if (/^H[1-6]$/.test(el.tagName)) { lines.push(`${"#".repeat(+el.tagName[1])} ${label(el)}`); seen.add(el); return }
        for (const c of el.childNodes) walk(c, depth + 1)
    }
    walk(document.body, 0)
    const text = lines.join("\n")
    return { title: document.title, url: location.href, blocked, refs: n, chars: text.length, text }
}
