// Print results.json (or the file named) as the markdown tables FINDINGS.md uses.
//
//   node spike/sqlite-kvgit/summarize.mjs [results.json]

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const r = JSON.parse(readFileSync(process.argv[2] ?? `${here}results.json`, 'utf-8'))

const mb = (b) => (b / 1024 / 1024).toFixed(1)
const kb = (b) => (b / 1024).toFixed(1)
const ms = (x) => (x < 10 ? x.toFixed(1) : Math.round(x).toString())
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
const table = (head, rows) =>
  [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((row) => `| ${row.join(' | ')} |`)].join('\n')
const out = (title, t) => console.log(`\n### ${title}\n\n${t}`)

if (r.build) {
  out('Databases built', table(
    ['db', 'page', 'rows', 'file MB', 'pages (keys)', 'atomic batches', 'loose writes'],
    Object.values(r.build).map((b) => [b.tag, kb(b.pageSize) + ' KB', b.rows, mb(b.fileBytes), b.pages, b.stats.batches, b.stats.looseWrites]),
  ))
}

if (r.open) {
  out('Open (IndexedDB to queryable, median of 3 cold page loads; max in brackets)', table(
    ['db', 'keys', 'worktree ms', 'page load ms', 'total ms', 'first month query ms', 'peak JS+buffers MB', 'settled buffers MB', 'wasm heap MB'],
    Object.entries(r.open).map(([tag, runs]) => {
      const peak = Math.max(...runs.map((x) => x.memory.peak.usedSize + x.memory.peak.backingStorageSize))
      return [
        tag,
        runs[0].keys,
        ms(median(runs.map((x) => x.msWorktree))),
        ms(median(runs.map((x) => x.msLoad))),
        `${ms(median(runs.map((x) => x.msTotal)))} [${ms(Math.max(...runs.map((x) => x.msTotal)))}]`,
        ms(median(runs.map((x) => x.month.ms))),
        mb(peak),
        mb(runs[0].memory.settled.backingStorageSize),
        mb(runs[0].wasmHeap),
      ]
    }),
  ))
}

if (r.openChunked) {
  out('Open at 50 MB, reading pages in chunks (median ms; peak MB)', table(
    ['variant', 'total ms', 'peak JS+buffers MB'],
    Object.entries(r.openChunked).map(([k, runs]) => [
      k,
      ms(median(runs.map((x) => x.msTotal))),
      mb(Math.max(...runs.map((x) => x.memory.peak.usedSize + x.memory.peak.backingStorageSize))),
    ]),
  ))
}

for (const [key, size] of [['commits', 10], ['commits50', 50]]) if (r[key]) {
  out(`Commit cost on a ${size} MB database`, table(
    ['db', 'one-row tx to durable: median / p95 ms', 'of which SQLite', 'of which kvgit commit', 'pages per tx', '1000 one-row tx (s)', 'tx/s', '1000 rows in one tx (ms)'],
    Object.values(r[key]).map((c) => [
      c.tag,
      `${ms(c.oneRowTx.total.median)} / ${ms(c.oneRowTx.total.p95)}`,
      ms(c.oneRowTx.sqlite.median),
      ms(c.oneRowTx.kvgit.median),
      `${c.oneRowTx.pagesPerTx.median} (max ${c.oneRowTx.pagesPerTx.max})`,
      (c.thousandTxMs / 1000).toFixed(2),
      Math.round(c.thousandTxPerSec),
      ms(c.thousandRowsOneTxMs),
    ]),
  ))
}

if (r.sync) {
  const edits = ['insertOne', 'updateOne', 'updateMoveStart', 'deleteOne']
  out('Sync: pack bytes pushed per edit (gzip), 10 MB database', table(
    ['db', 'file MB', 'whole file gz MB', ...edits.map((e) => `${e} pages / KB`)],
    Object.values(r.sync).map((s) => [
      s.tag,
      mb(s.fileBytes),
      mb(s.wholeFileGz),
      ...edits.map((e) => `${s.edits[e].pagesChanged} / ${kb(s.edits[e].gz)}`),
    ]),
  ))
  out('Sync: first push (the whole history so far)', table(
    ['db', 'commits', 'page versions', 'raw MB', 'gzip MB', 'ms'],
    Object.values(r.sync).map((s) => [s.tag, s.initialPush.commits, s.initialPush.updates, mb(s.initialPush.raw), mb(s.initialPush.gz), ms(s.initialPush.ms)]),
  ))
}

if (r.checkpoints) {
  out('Checkpoints, restores, test copies (10 MB database)', table(
    ['db', 'tag ms', 'full restore ms (move / load)', 'incremental restore ms (pages read)', 'integrity', 'test copy: branch / open / 11 writes / delete ms'],
    Object.values(r.checkpoints).map((c) => [
      c.tag,
      ms(c.tagMs),
      `${ms(c.fullRestoreMs)} (${ms(c.fullTimings.move)} / ${ms(c.fullTimings.load)})`,
      `${ms(c.incRestoreMs)} (${c.incChangedPages})`,
      c.integrity,
      `${ms(c.testCopy.branchMs)} / ${ms(c.testCopy.openCopyMs)} / ${ms(c.testCopy.writeCopyMs)} / ${ms(c.testCopy.deleteMs)}`,
    ]),
  ))
}

if (r.growth) {
  const s = (x) => `${mb(x.bytes)} MB, ${x.keys} keys, ${x.commits} commits`
  out('Storage growth: 1000 small transactions, then prune (squash + gc)', table(
    ['db', 'file MB', 'store before', 'after 1000 tx', 'growth per tx KB', 'after prune', 'squash ms', 'gc ms'],
    Object.entries(r.growth).map(([tag, g]) => [
      tag,
      mb(g.fileBytes),
      s(g.before),
      s(g.after1000),
      kb((g.after1000.bytes - g.before.bytes) / 1000),
      s(g.afterPrune),
      ms(g.squashMs),
      ms(g.gc.ms),
    ]),
  ))
}

if (r.lost) out('Lost commit', '```\n' + JSON.stringify(r.lost, null, 1) + '\n```')
if (r.crash) {
  out('Tab crash mid-write', table(
    ['trial', 'last durable seen', 'rows on reopen', 'integrity', 'writable after'],
    r.crash.map((c) => [c.trial, c.lastDurableSeen, c.rows, c.integrity, c.rowsAfterWrite === c.rows + 1 ? 'yes' : 'no']),
  ))
}

if (r.syncBurst) {
  out('Sync after a burst of small transactions (10 MB database)', table(
    ['db', 'tx since last sync', 'page versions in pack', 'pack raw MB', 'pack gzip KB', 'net changed pages', 'net pages gzip KB'],
    Object.values(r.syncBurst).flatMap((s) =>
      s.bursts.map((b) => [s.tag, b.tx, b.pack.updates, mb(b.pack.raw), kb(b.pack.gz), b.netPages, kb(b.netGz)]),
    ),
  ))
}

if (r.sizeProbe) {
  out('Stored bytes: logical vs what IndexedDB holds', table(
    ['db', 'commits', 'logical MB', 'physical MB', 'ratio'],
    Object.entries(r.sizeProbe).map(([tag, s]) => [tag, s.commits, mb(s.logical), mb(s.physical), s.ratio.toFixed(2)]),
  ))
}

for (const k of ['spill', 'twoWriters']) if (r[k]) out(k, '```\n' + JSON.stringify(r[k], null, 1) + '\n```')
