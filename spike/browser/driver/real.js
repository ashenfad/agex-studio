// Spike: the real-site run, in the person's own Chrome. One background
// tab per site from a deep link, read as a content script sees it, then
// again with the debugger's focus emulation on; nothing is clicked.

const SITES = [
    { name: "marriott", url: "https://www.marriott.com/search/findHotels.mi?destinationAddress.destination=Lisbon%2C%20Portugal&fromDate=12%2F03%2F2026&toDate=12%2F06%2F2026&roomCount=1&numAdultsPerRoom=2" },
    { name: "hilton", url: "https://www.hilton.com/en/search/?query=Lisbon%2C%20Portugal&arrivalDate=2026-12-03&departureDate=2026-12-06&flexibleDates=false&numRooms=1&numAdults=2" },
    { name: "hyatt", url: "https://www.hyatt.com/search/hotels/en-US/Lisbon%2C%20Portugal?checkinDate=2026-12-03&checkoutDate=2026-12-06&rooms=1&adults=2&kids=0" },
    { name: "ihg", url: "https://www.ihg.com/hotels/us/en/find-hotels/hotel-search?qDest=Lisbon%2C%20Portugal&qCiD=3&qCiMy=112026&qCoD=6&qCoMy=112026&qAdlt=2&qChld=0&qRms=1" },
    { name: "booking", url: "https://www.booking.com/searchresults.html?ss=Lisbon&checkin=2026-12-03&checkout=2026-12-06&group_adults=2&no_rooms=1&group_children=0" },
]
// what says the deep link's dates took
const DATES = /\b(dec(ember)?\.?\s*0?3|0?3\s*dec|12\/0?3\/(20)?26|2026-12-03|thu,?\s*dec\s*3)\b/i
const PRICE = /(?:[$€£]\s?\d[\d,.]*|\d[\d,.]*\s?(?:€|EUR|USD))/g

const summary = (o) => ({
    title: o.title, url: o.url, blocked: o.blocked, refs: o.refs, chars: o.chars,
    tokensApprox: Math.round(o.chars / 4), datesShown: DATES.test(o.text), prices: (o.text.match(PRICE) ?? []).length,
})

/** read the outline until it stops growing (or 25 s) */
async function settled(tabId) {
    let last = null
    for (let i = 0; i < 12; i++) {
        await sleep(2000)
        const o = await val("outline", { tabId })
        if (last && o.chars === last.chars && i >= 3) return o
        last = o
    }
    return last
}

async function site(s) {
    const out = { site: s.name }
    try {
        const { tabId } = await val("open", { url: s.url, mode: "tab", group: "agex: spike" })
        const plain = await settled(tabId)
        out.plain = summary(plain)
        out.plainProbe = await attempt("probeVisibility", { tabId })
        await val("wake", { tabId, how: "focus" })
        const woken = await settled(tabId)
        out.woken = summary(woken)
        out.shot = await attempt("screenshot", { tabId, via: "cdp" })
        await post(`real-${s.name}-outline`, { plain: plain.text, woken: woken.text })
        await attempt("close", { tabId })
    } catch (e) {
        out.failed = e.message
    }
    await post(`real-${s.name}`, out)
    log(`${s.name}: ${JSON.stringify({ plain: out.plain && { ...out.plain, title: undefined, url: undefined }, woken: out.woken && { ...out.woken, title: undefined, url: undefined }, failed: out.failed })}`)
}

async function realRun() {
    log("== real sites (one tab each, at once)")
    await Promise.all(SITES.map(site))
}
