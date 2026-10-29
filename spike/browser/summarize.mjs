// Spike: one line per scenario from results/.
import { readFileSync, readdirSync } from "node:fs"
const dir = new URL("results/", import.meta.url).pathname
for (const f of readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "done.json").sort()) {
    const r = JSON.parse(readFileSync(dir + f, "utf8"))
    const name = f.replace(".json", "")
    if (r.failed) { console.log(name.padEnd(22), "FAILED", r.failed); continue }
    if (!r.probes) { console.log(name.padEnd(22), JSON.stringify({ ...r, portRoundTrip: r.portRoundTrip?.value?.visibility })); continue }
    const p = r.probes[0], a = r.afterInput
    console.log(name.padEnd(22), JSON.stringify({
        studio: r.studioVisibility, win: r.window?.state, vis: p.visibility, iv: p.intervals, raf: p.rafs, framed: p.framed, lazy: r.lazyAfterScroll,
        clicks: a.clicks.map((c) => c.trusted), inputs: a.inputs.map((i) => `${i.trusted}:${i.value}`),
        shotVis: r.shotVisible.ok ? r.shotVisible.value.capturedActiveTab : r.shotVisible.error, shotCdp: r.shotCdp.ok ? r.shotCdp.ms + "ms" : r.shotCdp.error,
        ...(r.afterDetach && { afterDetach: r.afterDetach }),
    }))
}
