// Drive the spike in headless Chromium against real (on-disk) IndexedDB.
//
//   node spike/sqlite-kvgit/run.mjs [step ...]
//
// Default steps, in order: info build open commits sync checkpoints
// lost crash growth. Others, run by name: commits50 (commit cost at
// 50 MB), commitsAt (commit cost at each SPIKE_MB and SPIKE_PAGES),
// twoTabs (two writers with and without onMoved 'raise'), openChunked (50 MB opens
// read in chunks, SPIKE_MB=50), syncBurst, spill, twoWriters,
// sizeProbe, and the diagnostics restoreLatency, loadProbe,
// encodeProbe, storeProbe, logProbe, markerProbe. Results go to
// results.json next to this file, merged with what earlier runs wrote.
//
// Environment: SPIKE_PORT (default 4391; never 5173), SPIKE_PROFILE
// (the Chromium profile, so IndexedDB persists between runs),
// SPIKE_RESULTS, SPIKE_MB and SPIKE_PAGES (comma lists), SPIKE_UNFIXED
// (run on kvgit as it is, without the spike's exact-buffer wrapper),
// SPIKE_NO_WRAP (the same, for a kvgit that stores exact buffers
// itself), SPIKE_KVGIT (a built kvgit-ts package directory to run
// against; see vite.config.js), SPIKE_CHROME (the browser binary).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const here = fileURLToPath(new URL('.', import.meta.url))
const CHROME =
  process.env.SPIKE_CHROME ??
  '/Users/ashenfad/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell'
const PORT = Number(process.env.SPIKE_PORT ?? 4391)
const PROFILE =
  process.env.SPIKE_PROFILE ??
  "/private/tmp/claude-501/-Users-ashenfad-git/52552964-cff1-43e4-8193-27117b397310/scratchpad/chrome-profile"
const RESULTS = process.env.SPIKE_RESULTS ?? `${here}results.json`

const PAGE_SIZES = (process.env.SPIKE_PAGES ?? '4096,16384,65536').split(',').map(Number)
const SIZES = (process.env.SPIKE_MB ?? '1,10,50').split(',').map(Number)
const ALL = ['info', 'build', 'open', 'commits', 'sync', 'checkpoints', 'lost', 'crash', 'growth']
const steps = process.argv.slice(2).length ? process.argv.slice(2) : ALL

const results = existsSync(RESULTS) ? JSON.parse(readFileSync(RESULTS, 'utf-8')) : {}
const save = () => writeFileSync(RESULTS, JSON.stringify(results, null, 2) + '\n')

if (PORT === 5173) throw new Error('never 5173')
const server = await createServer({ configFile: `${here}vite.config.js`, server: { port: PORT, strictPort: true } })
await server.listen()
mkdirSync(PROFILE, { recursive: true })
const context = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROME,
  headless: true,
  args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'],
})
const URL_ = `http://localhost:${PORT}/`
// Run against kvgit as it is, without the spike's exact-buffer fix.
if (process.env.SPIKE_UNFIXED || process.env.SPIKE_NO_WRAP) await context.addInitScript(() => (window.SPIKE_NO_WRAP = true))

async function freshPage() {
  // A closed page's connections must be gone before the next one opens.
  for (const p of context.pages()) await p.close().catch(() => {})
  const page = await context.newPage()
  page.on('pageerror', (e) => console.error('pageerror', e))
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') console.error('console', m.type(), m.text())
  })
  await page.goto(URL_)
  await page.waitForFunction(() => window.spike?.ready === true, null, { timeout: 60_000 })
  return page
}

async function call(page, name, arg) {
  const t = Date.now()
  const out = await page.evaluate(([n, a]) => window.spike[n](a), [name, arg])
  console.error(`  ${name} ${JSON.stringify(arg)} ${((Date.now() - t) / 1000).toFixed(1)}s`)
  return out
}

/** Run `fn` while sampling the renderer's heap (JS heap and array
 *  buffer backing stores); return its result and the peak seen. */
async function sampled(page, fn) {
  const cdp = await context.newCDPSession(page)
  await cdp.send('HeapProfiler.collectGarbage')
  const base = await cdp.send('Runtime.getHeapUsage')
  let peak = { ...base }
  let live = true
  const loop = (async () => {
    while (live) {
      try {
        const u = await cdp.send('Runtime.getHeapUsage')
        const sum = (x) => x.usedSize + (x.backingStorageSize ?? 0)
        if (sum(u) > sum(peak)) peak = u
      } catch {}
      await new Promise((r) => setTimeout(r, 20))
    }
  })()
  const out = await fn()
  live = false
  await loop
  await cdp.send('HeapProfiler.collectGarbage')
  const settled = await cdp.send('Runtime.getHeapUsage')
  await cdp.detach()
  return { out, memory: { base, peak, settled } }
}

const tagOf = (mb, ps) => `${mb}mb-${ps / 1024}k`

try {
  for (const step of steps) {
    console.error(`step ${step}`)
    if (step === 'info') {
      results.info = { ...(await call(await freshPage(), 'info')), kvgitDir: process.env.SPIKE_KVGIT ?? null, wrapped: !(process.env.SPIKE_UNFIXED || process.env.SPIKE_NO_WRAP) }
    } else if (step === 'build') {
      results.build ??= {}
      for (const mb of SIZES) for (const ps of PAGE_SIZES) {
        results.build[tagOf(mb, ps)] = await call(await freshPage(), 'build', { tag: tagOf(mb, ps), pageSize: ps, mb })
        save()
      }
    } else if (step === 'open') {
      results.open = {}
      for (const mb of SIZES) for (const ps of PAGE_SIZES) {
        const runs = []
        for (let r = 0; r < 3; r++) {
          const page = await freshPage()
          const { out, memory } = await sampled(page, () => call(page, 'open', { tag: tagOf(mb, ps) }))
          await call(page, 'closeOpen')
          runs.push({ ...out, memory })
        }
        results.open[tagOf(mb, ps)] = runs
        save()
      }
    } else if (step === 'openChunked') {
      results.openChunked = {}
      for (const mb of SIZES) for (const ps of PAGE_SIZES) for (const chunk of [256, 1024]) for (const gc of [false, true]) {
        const runs = []
        for (let r = 0; r < 3; r++) {
          const page = await freshPage()
          const { out, memory } = await sampled(page, () => call(page, 'open', { tag: tagOf(mb, ps), chunk, gc }))
          await call(page, 'closeOpen')
          runs.push({ ...out, chunk, gc, memory })
        }
        results.openChunked[`${tagOf(mb, ps)}-c${chunk}${gc ? '-gc' : ''}`] = runs
        save()
      }
    } else if (step === 'growth') {
      // On a fresh 10 MB database each, so earlier steps' history and
      // branches don't count.
      results.growth = {}
      for (const ps of PAGE_SIZES) {
        const tag = `growth-${ps / 1024}k`
        await call(await freshPage(), 'build', { tag, pageSize: ps, mb: 10 })
        results.growth[tag] = await call(await freshPage(), 'growth', { tag })
        save()
      }
    } else if (['commits', 'sync', 'checkpoints'].includes(step)) {
      results[step] = {}
      for (const ps of PAGE_SIZES) {
        results[step][tagOf(10, ps)] = await call(await freshPage(), step, { tag: tagOf(10, ps) })
        save()
      }
    } else if (step === 'restoreLatency') {
      results.restoreLatency = {}
      for (const ps of PAGE_SIZES) {
        results.restoreLatency[tagOf(10, ps)] = await call(await freshPage(), step, { tag: tagOf(10, ps) })
        save()
      }
    } else if (step === 'loadProbe') {
      results.loadProbe = {}
      for (const ps of PAGE_SIZES) for (const write of [false, true]) {
        results.loadProbe[`${tagOf(10, ps)}${write ? '-w' : ''}`] = await call(await freshPage(), step, { tag: tagOf(10, ps), write })
        save()
      }
    } else if (step === 'encodeProbe') {
      results.encodeProbe = {}
      for (const ps of PAGE_SIZES) results.encodeProbe[tagOf(10, ps)] = await call(await freshPage(), step, { tag: tagOf(10, ps) })
    } else if (step === 'storeProbe') {
      results.storeProbe = await call(await freshPage(), step, { tag: process.env.SPIKE_TAG ?? tagOf(10, 16384) })
    } else if (step === 'logProbe') {
      results.logProbe = await call(await freshPage(), step, { tag: process.env.SPIKE_TAG ?? tagOf(10, 16384) })
    } else if (step === 'markerProbe') {
      results.markerProbe = await call(await freshPage(), step, { tag: process.env.SPIKE_TAG ?? tagOf(10, 16384) })
    } else if (step === 'spill') {
      results.spill = await call(await freshPage(), step)
    } else if (step === 'sizeProbe') {
      results.sizeProbe = await call(await freshPage(), step, { tags: SIZES.flatMap((mb) => PAGE_SIZES.map((ps) => tagOf(mb, ps))) })
    } else if (step === 'syncBurst') {
      results.syncBurst = {}
      for (const ps of PAGE_SIZES) {
        results.syncBurst[tagOf(10, ps)] = await call(await freshPage(), step, { tag: tagOf(10, ps) })
        save()
      }
    } else if (step === 'twoWriters') {
      results.twoWriters = await call(await freshPage(), step, { tag: tagOf(10, 4096) })
    } else if (step === 'twoTabs') {
      results.twoTabs = await call(await freshPage(), step, { tag: tagOf(10, 4096) })
    } else if (step === 'commitsAt') {
      results.commitsAt ??= {}
      for (const mb of SIZES) for (const ps of PAGE_SIZES) {
        results.commitsAt[tagOf(mb, ps)] = await call(await freshPage(), 'commits', { tag: tagOf(mb, ps) })
        save()
      }
    } else if (step === 'commits50') {
      results.commits50 = {}
      for (const ps of PAGE_SIZES) {
        results.commits50[tagOf(50, ps)] = await call(await freshPage(), 'commits', { tag: tagOf(50, ps) })
        save()
      }
    } else if (step === 'lost') {
      results.lost = await call(await freshPage(), 'lostCommit', { tag: tagOf(10, 4096) })
    } else if (step === 'crash') {
      results.crash = []
      for (let trial = 0; trial < 8; trial++) {
        const page = await freshPage()
        let lastDurable = null
        page.on('console', (m) => {
          const t = m.text()
          if (t.startsWith('durable ')) lastDurable = Number(t.slice(8))
        })
        page.evaluate(([t]) => window.spike.writeForever({ tag: t }), [tagOf(10, 16384)]).catch(() => {})
        // Let a few transactions land, then crash mid-stream.
        await new Promise((r) => setTimeout(r, 1500 + trial * 173))
        const cdp = await context.newCDPSession(page)
        // The renderer dies before it can answer, so don't wait for one.
        cdp.send('Page.crash').catch(() => {})
        await new Promise((r) => setTimeout(r, 300))
        const check = await call(await freshPage(), 'reopenCheck', { tag: tagOf(10, 16384) })
        results.crash.push({ trial, lastDurableSeen: lastDurable, ...check })
        save()
      }
    } else {
      throw new Error(`unknown step ${step}`)
    }
    save()
  }
} finally {
  await context.close()
  await server.close()
}
console.log(JSON.stringify(results, null, 2))
