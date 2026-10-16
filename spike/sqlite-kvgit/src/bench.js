// The spike's measurements, run in the browser against real IndexedDB.
// run.mjs drives them one step at a time through window.spike.

import * as kvgit from '@agex-ts/kvgit';
import { MemoryRemote, pushBranch, Repo, walkDelta } from '@agex-ts/kvgit';
import { Memory } from '@agex-ts/kvgit/backends/memory';
import { IndexedDB } from '@agex-ts/kvgit/backends/idb';
import { encodePack } from '@agex-ts/kvgit/github';

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
import { KvSqlite, loadOptions, sqliteRuntime } from './kvsqlite.js';

const now = () => performance.now();
const MB = 1024 * 1024;
const DAY = 86400;
const T0 = 1767225600; // 2026-01-01 UTC, seconds

const dbName = (tag) => `spike-${tag}`;

// kvgit's CBOR codec returns views into cbor-x's encode buffer, which
// is several times larger than the value (a 4 KB page sits in a 20 KB
// buffer, a 64 KB page in a 260 KB one). IndexedDB's structured clone
// stores a view's whole buffer, so every stored value carries that
// slack. This wrapper gives each written value its own exact buffer,
// as a fix in kvgit's IndexedDB backend (or its codec) would; the
// spike runs with it unless `window.SPIKE_NO_WRAP` is set (kvgit
// stores exact buffers itself from @agex-ts/kvgit #115 on).
const exact = (v) => (v.byteOffset === 0 && v.byteLength === v.buffer.byteLength ? v : v.slice());
function exactValues(kv) {
  return new Proxy(kv, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      if (prop === 'set') return (key, value) => v.call(target, key, exact(value));
      if (prop === 'setMany') return (items) => v.call(target, [...items].map(([k, x]) => [k, exact(x)]));
      if (prop === 'casMany') {
        return (expected, writes, removes) =>
          v.call(target, expected, new Map([...writes].map(([k, x]) => [k, exact(x)])), removes);
      }
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

async function openRepo(tag, { fresh = false, wrap } = {}) {
  if (fresh) await IndexedDB.deleteDatabase(dbName(tag));
  let kv = await IndexedDB.open({ dbName: dbName(tag) });
  if (!window.SPIKE_NO_WRAP) kv = exactValues(kv);
  if (wrap) kv = wrap(kv);
  const repo = await Repo.open(kv, { codec: 'cbor' });
  return { kv, repo };
}

// --- The calendar workload ---

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calendars (id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  calendar_id INTEGER NOT NULL REFERENCES calendars(id),
  title TEXT NOT NULL,
  start INTEGER NOT NULL,
  end INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  rrule TEXT,
  until INTEGER,
  location TEXT,
  notes TEXT,
  updated INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_start ON events(start);
CREATE INDEX IF NOT EXISTS events_recurring ON events(until) WHERE rrule IS NOT NULL;
CREATE TABLE IF NOT EXISTS exceptions (
  event_id INTEGER NOT NULL REFERENCES events(id),
  occurs INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (event_id, occurs)
) WITHOUT ROWID;
`;

const WORDS = 'standup review lunch dentist gym sync planning retro call dinner flight offsite yoga 1:1 demo launch party school pickup groceries'.split(' ');
const PLACES = ['Room 4B', 'Zoom', 'Cafe Luna', 'Home', 'HQ lobby', '', 'Gym', 'Airport T2'];
const RULES = ['FREQ=WEEKLY;BYDAY=MO,WE,FR', 'FREQ=DAILY', 'FREQ=MONTHLY;BYMONTHDAY=1', 'FREQ=WEEKLY;BYDAY=TU'];

// mulberry32: a small seeded generator, so every build holds the same data.
let rngState = 42;
function rand() {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (xs) => xs[Math.floor(rand() * xs.length)];

function eventRow(i) {
  const start = T0 + Math.floor(rand() * 3 * 365) * DAY + Math.floor(rand() * 48) * 1800;
  const recurring = rand() < 0.08;
  const notesLen = Math.floor(rand() * 400);
  let notes = '';
  while (notes.length < notesLen) notes += pick(WORDS) + ' ';
  return [
    1 + (i % 4),
    `${pick(WORDS)} ${pick(WORDS)} #${i}`,
    start,
    start + (1 + Math.floor(rand() * 4)) * 1800,
    rand() < 0.05 ? 1 : 0,
    recurring ? pick(RULES) : null,
    recurring ? start + Math.floor(rand() * 365) * DAY : null,
    pick(PLACES),
    notes,
    start,
  ];
}

const INSERT = `INSERT INTO events (calendar_id, title, start, end, all_day, rrule, until, location, notes, updated)
  VALUES (?,?,?,?,?,?,?,?,?,?)`;

async function insertMany(db, from, count) {
  // One transaction: BEGIN, one INSERT per row, COMMIT.
  await db.query('BEGIN');
  for (let i = from; i < from + count; i++) await db.query(INSERT, eventRow(i));
  await db.query('COMMIT');
}

async function monthQuery(db, monthStart) {
  const monthEnd = monthStart + 31 * DAY;
  const t = now();
  const single = await db.query(
    'SELECT id, title, start, end FROM events WHERE start >= ? AND start < ? AND rrule IS NULL ORDER BY start',
    [monthStart, monthEnd],
  );
  const recurring = await db.query(
    `SELECT e.id, e.rrule, e.start, e.until, count(x.occurs) AS skipped FROM events e
       LEFT JOIN exceptions x ON x.event_id = e.id AND x.occurs >= ? AND x.occurs < ?
     WHERE e.rrule IS NOT NULL AND e.start < ? AND e.until >= ? GROUP BY e.id`,
    [monthStart, monthEnd, monthEnd, monthStart],
  );
  return { ms: now() - t, single: single.length, recurring: recurring.length };
}

async function rowCount(db) {
  return (await db.query('SELECT count(*) AS n FROM events'))[0].n;
}

// --- Store accounting ---

async function storeBytes(kv) {
  const out = { keys: 0, bytes: 0, blobs: 0, blobBytes: 0, nodes: 0, nodeBytes: 0, commits: 0, heads: [] };
  for await (const [k, v] of kv.items()) {
    out.keys++;
    if (k.startsWith('__commit_root__')) out.commits++;
    if (k.startsWith('__branch_head__')) out.heads.push(k.slice(15));
    out.bytes += k.length + v.byteLength;
    // What IndexedDB holds: a stored view brings its whole buffer.
    out.physical = (out.physical ?? 0) + k.length + v.buffer.byteLength;
    if (k.startsWith('kvgit:blob:')) {
      out.blobs++;
      out.blobBytes += v.byteLength;
    } else if (k.startsWith('kvgit:keyset:')) {
      out.nodes++;
      out.nodeBytes += v.byteLength;
    }
  }
  return out;
}

async function estimate() {
  const e = await navigator.storage.estimate();
  return { usage: e.usage, idb: e.usageDetails?.indexedDB };
}

function heap() {
  const m = performance.memory;
  return m ? { used: m.usedJSHeapSize, total: m.totalJSHeapSize } : null;
}

// --- Steps ---

const spike = {};
window.spike = spike;

spike.info = async () => {
  const { sqlite3, module } = await sqliteRuntime();
  const { repo } = await openRepo('info', { fresh: true });
  const db = await KvSqlite.open(repo, 'db');
  const opts = (await db.query('PRAGMA compile_options')).map((r) => r.compile_options);
  const exportsSession = typeof module._sqlite3session_create === 'function';
  await db.close();
  // Which kvgit is running: the onMoved commit option and exact value
  // buffers are both new in it.
  const enc = kvgit.cborCodec.encode(new Uint8Array(4096));
  const marker = {
    branchMovedError: typeof kvgit.BranchMovedError === 'function',
    branchMovedIsConcurrency: kvgit.BranchMovedError?.prototype instanceof kvgit.ConcurrencyError,
    cborEncode4k: { byteLength: enc.byteLength, bufferByteLength: enc.buffer.byteLength },
    wrapped: !window.SPIKE_NO_WRAP,
  };
  return { version: sqlite3.libversion(), compileOptions: opts, exportsSession, kvgit: marker };
};

/** Build a calendar database of about `mb` megabytes on its own IDB. */
spike.build = async ({ tag, pageSize, mb }) => {
  const t = now();
  const { repo } = await openRepo(tag, { fresh: true });
  const db = await KvSqlite.open(repo, 'db', { pageSize });
  await db.exec(SCHEMA);
  await db.exec(`INSERT INTO calendars (name, color) VALUES ('Home','#f00'),('Work','#00f'),('Kids','#0f0'),('Travel','#888')`);
  let n = 0;
  const batch = 4000;
  while (db.file.bytes < mb * MB) {
    await insertMany(db, n, batch);
    n += batch;
  }
  // Some recurrence exceptions.
  await db.query('BEGIN');
  for (const r of await db.query('SELECT id, start FROM events WHERE rrule IS NOT NULL LIMIT 2000')) {
    await db.query('INSERT OR IGNORE INTO exceptions (event_id, occurs, cancelled) VALUES (?,?,1)', [r.id, r.start + 7 * DAY]);
  }
  await db.query('COMMIT');
  const out = {
    tag,
    pageSize,
    rows: await rowCount(db),
    fileBytes: db.file.bytes,
    pages: db.file.pages.size,
    commits: db.commits,
    stats: db.file.stats,
    autoVacuum: (await db.query('PRAGMA auto_vacuum'))[0].auto_vacuum,
    journalMode: (await db.query('PRAGMA journal_mode'))[0].journal_mode,
    ms: now() - t,
  };
  await db.close();
  return out;
};

/** Open a built database from IndexedDB into memory, cold (fresh page). */
spike.open = async ({ tag, chunk = 0, gc = false }) => {
  loadOptions.chunk = chunk;
  loadOptions.gc = gc;
  const h0 = heap();
  const t0 = now();
  const { repo } = await openRepo(tag);
  const t1 = now();
  const wt = await repo.worktree('db');
  const t2 = now();
  const snap = await repo.snapshot({ commit: wt.head });
  const keys = await snap.keys();
  const t3 = now();
  const db = await KvSqlite.open(repo, 'db');
  const t4 = now();
  const q = await monthQuery(db, T0 + 120 * DAY);
  const t5 = now();
  const integrity = (await db.query('PRAGMA quick_check'))[0].quick_check;
  const out = {
    tag,
    pageSize: db.file.pageSize,
    fileBytes: db.file.bytes,
    keys: keys.length,
    msIdbOpen: t1 - t0,
    msWorktree: t2 - t1,
    msKeys: t3 - t2,
    msLoad: t4 - t3,
    msFirstQuery: t5 - t4,
    msTotal: t5 - t0,
    month: q,
    quickCheck: integrity,
    heapBefore: h0,
    heapAfter: heap(),
    wasmHeap: (await sqliteRuntime()).module.HEAPU8.byteLength,
  };
  spike._open = db;
  return out;
};

spike.closeOpen = async () => {
  await spike._open?.close();
  spike._open = null;
};

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0], max: s.at(-1), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

/** Latency and throughput of commits, on a built database. */
spike.commits = async ({ tag, samples = 50 }) => {
  const { repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  let i = 1_000_000;
  // Warm up.
  for (let k = 0; k < 5; k++) await db.query(INSERT, eventRow(i++));

  const total = [];
  const sqlite = [];
  const kvgit = [];
  const pages = [];
  for (let k = 0; k < samples; k++) {
    const t0 = now();
    let t1 = 0;
    db.beforeCommit = (dirty) => {
      t1 = now();
      pages.push(dirty.size);
    };
    await db.query(INSERT, eventRow(i++));
    const t2 = now();
    total.push(t2 - t0);
    sqlite.push(t1 - t0);
    kvgit.push(t2 - t1);
  }
  db.beforeCommit = null;

  let t = now();
  for (let k = 0; k < 1000; k++) await db.query(INSERT, eventRow(i++));
  const thousandTx = now() - t;

  t = now();
  const before = db.commits;
  await insertMany(db, i, 1000);
  i += 1000;
  const oneTx = now() - t;
  const oneTxCommits = db.commits - before;

  const out = {
    tag,
    pageSize: db.file.pageSize,
    fileBytes: db.file.bytes,
    oneRowTx: { total: stats(total), sqlite: stats(sqlite), kvgit: stats(kvgit), pagesPerTx: stats(pages) },
    thousandTxMs: thousandTx,
    thousandTxPerSec: 1000 / (thousandTx / 1000),
    thousandRowsOneTxMs: oneTx,
    oneTxCommits,
    stats: db.file.stats,
  };
  await db.close();
  return out;
};

/** A remote that is a MemoryRemote, and also encodes each push as the
 *  pack PackRemote would send, to count its bytes. */
class CountingRemote extends MemoryRemote {
  packs = [];
  async push(branch, expectedOld, newHead, commits) {
    const list = [];
    for await (const c of commits) list.push(c);
    const raw = await encodePack(list, { kernel: 'spike', base: expectedOld, compress: false });
    const gz = await encodePack(list, { kernel: 'spike', base: expectedOld });
    const values = list.reduce((a, c) => a + [...c.updates.values()].reduce((x, v) => x + v.byteLength, 0), 0);
    this.packs.push({ commits: list.length, raw: raw.byteLength, gz: gz.byteLength, valueBytes: values, updates: list.reduce((a, c) => a + c.updates.size, 0) });
    return super.push(branch, expectedOld, newHead, list);
  }
}

/** The bytes a sync pushes after small edits. */
spike.sync = async ({ tag }) => {
  const { kv, repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  const remote = new CountingRemote(new Memory(), { id: `mem-${Date.now()}-${Math.random()}` });

  const t = now();
  const first = await pushBranch(kv, remote, 'db');
  const firstMs = now() - t;
  const initial = remote.packs.at(-1);

  // The whole file, gzipped, for comparison.
  const whole = new Uint8Array(db.file.bytes);
  for (const [n, p] of db.file.pages) whole.set(p, n * db.file.pageSize);
  const wholeGz = (await gzip(whole)).byteLength;

  const edits = {};
  const editsSql = {
    insertOne: [INSERT, eventRow(2_000_000)],
    updateOne: ['UPDATE events SET title = ?, updated = ? WHERE id = ?', ['moved: dentist', T0 + 999, 777]],
    updateMoveStart: ['UPDATE events SET start = start + ?, end = end + ? WHERE id = ?', [40 * DAY, 40 * DAY, 1234]],
    deleteOne: ['DELETE FROM events WHERE id = ?', [4321]],
  };
  for (const [name, [sql, params]] of Object.entries(editsSql)) {
    let dirty = 0;
    db.beforeCommit = (d) => (dirty = d.size);
    await db.query(sql, params);
    const ts = now();
    const res = await pushBranch(kv, remote, 'db');
    edits[name] = { pagesChanged: dirty, ...remote.packs.at(-1), status: res.status ?? res, pushMs: now() - ts };
  }
  db.beforeCommit = null;

  const out = {
    tag,
    pageSize: db.file.pageSize,
    fileBytes: db.file.bytes,
    wholeFileGz: wholeGz,
    initialPush: { ...initial, ms: firstMs, status: first.status ?? first },
    edits,
  };
  await db.close();
  return out;
};

/** Checkpoints (tags), restores and test copies. */
spike.checkpoints = async ({ tag }) => {
  const { repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  const before = await rowCount(db);

  let t = now();
  await repo.tags.create(`cp-${Date.now()}`, db.head, { info: { reason: 'checkpoint' } });
  const tagMs = now() - t;
  const tagged = db.head;

  // Some edits after the checkpoint: 20 inserts, 20 updates, one bulk delete.
  for (let k = 0; k < 20; k++) await db.query(INSERT, eventRow(3_000_000 + k));
  for (let k = 0; k < 20; k++) await db.query('UPDATE events SET title = ? WHERE id = ?', [`edited ${k}`, 100 + k * 37]);
  await db.query('DELETE FROM events WHERE id BETWEEN 5000 AND 5500');
  const after = await rowCount(db);
  const editedHead = db.head;
  await repo.tags.create(`edited-${Date.now()}`, editedHead);

  // Full restore: move the branch, reload every page, first query.
  t = now();
  await db.reload(tagged);
  const fullTimings = db.lastTimings;
  const restored = await rowCount(db);
  const fullRestoreMs = now() - t;

  // Back to the edited head, then an incremental restore.
  await db.reload(editedHead);
  t = now();
  const changedPages = await db.restoreIncremental(tagged);
  const incTimings = db.lastTimings;
  const restoredInc = await rowCount(db);
  const incRestoreMs = now() - t;
  const integrity = (await db.query('PRAGMA integrity_check'))[0].integrity_check;

  // Test copy: branch at head, write, discard.
  t = now();
  const copyName = `test-${Date.now()}`;
  await repo.branches.create(copyName, db.head);
  const branchMs = now() - t;
  t = now();
  const copy = await KvSqlite.open(repo, copyName, { create: false, file: db.file.fork() });
  const openCopyMs = now() - t;
  t = now();
  for (let k = 0; k < 10; k++) await copy.query(INSERT, eventRow(4_000_000 + k));
  await copy.query("UPDATE events SET location = 'test' WHERE id < 50");
  const writeCopyMs = now() - t;
  const copyRows = await rowCount(copy);
  const mainRows = await rowCount(db);
  await copy.close();
  t = now();
  await repo.branches.delete(copyName);
  const deleteMs = now() - t;

  const out = {
    tag,
    pageSize: db.file.pageSize,
    fileBytes: db.file.bytes,
    tagMs,
    rows: { before, after, restored, restoredInc, copyRows, mainRows },
    fullRestoreMs,
    fullTimings,
    incRestoreMs,
    incTimings,
    incChangedPages: changedPages,
    integrity,
    testCopy: { branchMs, openCopyMs, writeCopyMs, deleteMs, totalMs: branchMs + openCopyMs + writeCopyMs + deleteMs },
  };
  await db.close();
  return out;
};

/** What 1000 small transactions add to the store, and what pruning reclaims. */
spike.growth = async ({ tag }) => {
  const { kv, repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  // Drop the tags earlier steps made, so only the branch holds history.
  for (const name of await repo.tags.list()) await repo.tags.delete(name);
  let t = now();
  const gc0 = await repo.gc({ minAge: 0 });
  const gc0Ms = now() - t;
  const s0 = await storeBytes(kv);
  const e0 = await estimate();
  for (let k = 0; k < 1000; k++) {
    if (k % 2) await db.query(INSERT, eventRow(5_000_000 + k));
    else await db.query('UPDATE events SET notes = ? WHERE id = ?', [`note ${k}`, 1 + ((k * 7919) % 20000)]);
  }
  const s1 = await storeBytes(kv);
  const e1 = await estimate();

  // Prune: one new root commit holding today's pages, the branch reset
  // onto it, then gc. History before it goes.
  t = now();
  const squash = await repo.worktree(`squash-${Date.now()}`, { create: true });
  const snap = await repo.snapshot({ commit: db.head });
  for (const [k, v] of await snap.getMany(await snap.keys())) squash.set(k, v);
  await squash.commit({ info: { tool: 'squash' } });
  const squashed = squash.head;
  await db.reload(squashed);
  await repo.branches.delete(squash.branch);
  const squashMs = now() - t;
  t = now();
  const removedCommits = await repo.gc({ minAge: 0 });
  const gcMs = now() - t;
  const s2 = await storeBytes(kv);
  const e2 = await estimate();
  const integrity = (await db.query('PRAGMA integrity_check'))[0].integrity_check;
  const out = {
    tag,
    pageSize: db.file.pageSize,
    fileBytes: db.file.bytes,
    gc0: { removed: gc0, ms: gc0Ms },
    before: s0,
    after1000: s1,
    afterPrune: s2,
    estimate: { before: e0, after1000: e1, afterPrune: e2 },
    squashMs,
    gc: { removedCommits, ms: gcMs },
    integrity,
  };
  await db.close();
  return out;
};

/** A commit that never lands: the head write fails. */
spike.lostCommit = async ({ tag }) => {
  let failHead = false;
  const wrap = (kv) =>
    new Proxy(kv, {
      get(target, prop) {
        const v = Reflect.get(target, prop, target);
        if (prop === 'casMany') {
          return async (expect, writes, removes) => {
            const writesHead = [...writes.keys()].some((k) => k.startsWith('__branch_head__'));
            if (failHead && writesHead) throw new Error('simulated: the head write never landed');
            return v.call(target, expect, writes, removes);
          };
        }
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
  const { repo } = await openRepo(tag, { wrap });
  const db = await KvSqlite.open(repo, 'db');
  const rows0 = await rowCount(db);
  const head0 = db.head;
  failHead = true;
  let error = null;
  try {
    await insertMany(db, 6_000_000, 50);
  } catch (e) {
    error = String(e.message ?? e);
  }
  failHead = false;
  // The KvSqlite reloaded what is durable.
  const rowsAfterError = await rowCount(db);
  await db.close();

  // A fresh connection, as after a reload of the page.
  const { repo: repo2 } = await openRepo(tag);
  const db2 = await KvSqlite.open(repo2, 'db');
  const out = {
    tag,
    error,
    rowsBefore: rows0,
    rowsAfterError,
    rowsReopened: await rowCount(db2),
    headUnchanged: db2.head === head0,
    integrity: (await db2.query('PRAGMA integrity_check'))[0].integrity_check,
  };
  await db2.close();
  return out;
};

/** Keep committing until the page dies; the driver crashes the tab. */
spike.writeForever = async ({ tag }) => {
  const { repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  let k = 0;
  window.__durable = await rowCount(db);
  for (;;) {
    // 200 rows per transaction, so the crash is likely mid-commit.
    await insertMany(db, 7_000_000 + k * 200, 200);
    k++;
    window.__durable = await rowCount(db);
    console.log(`durable ${window.__durable}`);
  }
};

spike.reopenCheck = async ({ tag }) => {
  const { kv, repo } = await openRepo(tag);
  // A commit batch that landed without its head leaves its marker.
  const inflight = [];
  for await (const k of kv.keys('__inflight__')) inflight.push(k.slice(12, 20));
  const db = await KvSqlite.open(repo, 'db');
  const out = {
    inflightMarkers: inflight,
    rows: await rowCount(db),
    integrity: (await db.query('PRAGMA integrity_check'))[0].integrity_check,
  };
  // Writable after the crash.
  await db.query(INSERT, eventRow(8_000_000));
  out.rowsAfterWrite = await rowCount(db);
  await db.close();
  return out;
};

spike.ready = true;

/** Restore cost against how recently the store was written. */
spike.restoreLatency = async ({ tag }) => {
  const { repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  const out = { tag, pageSize: db.file.pageSize, runs: [] };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const idle of [0, 0, 1000, 5000]) {
    const base = db.head;
    for (let k = 0; k < 20; k++) await db.query('UPDATE events SET title = ? WHERE id = ?', [`lat ${k}`, 200 + k * 41]);
    const edited = db.head;
    await sleep(idle);
    let t = now();
    await db.reload(base);
    const full = now() - t;
    const fullT = db.lastTimings;
    await db.reload(edited);
    await sleep(idle);
    t = now();
    const pages = await db.restoreIncremental(base);
    const inc = now() - t;
    out.runs.push({ idle, full, fullT, inc, incT: db.lastTimings, pages });
    await db.reload(edited);
  }
  await db.close();
  return out;
};

/** Where a same-session reload spends its time. */
spike.loadProbe = async ({ tag, write = true }) => {
  const { repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  const out = { tag, pageSize: db.file.pageSize, write };
  const timeLoad = async (r) => {
    const snap = await r.snapshot({ branch: 'db' });
    const keys = (await snap.keys()).filter((k) => k.startsWith('page/'));
    const t = now();
    await snap.rawMany(keys);
    return now() - t;
  };
  out.rawBeforeWrites = await timeLoad(repo);
  if (write) for (let k = 0; k < 20; k++) await db.query('UPDATE events SET title = ? WHERE id = ?', [`probe ${Math.random()}`, 300 + k * 41]);
  out.rawAfterWrites = await timeLoad(repo);
  out.rawAgain = await timeLoad(repo);
  const { repo: fresh } = await openRepo(tag);
  out.rawFreshConnection = await timeLoad(fresh);
  await db.close();
  return out;
};

/** Does a CBOR-encoded value carry more buffer than its bytes? */
spike.encodeProbe = async ({ tag }) => {
  const { cborCodec } = await import('@agex-ts/kvgit');
  const encoded = [4096, 16384, 65536].map((n) => {
    const e = cborCodec.encode(new Uint8Array(n));
    return { page: n, byteLength: e.byteLength, bufferByteLength: e.buffer.byteLength, byteOffset: e.byteOffset };
  });
  // What IndexedDB holds for a few stored page blobs.
  const idb = await new Promise((res, rej) => {
    const r = indexedDB.open(dbName(tag));
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const stored = await new Promise((res) => {
    const out = [];
    const tx = idb.transaction('kv');
    const cur = tx.objectStore('kv').openCursor(IDBKeyRange.bound('kvgit:blob:', 'kvgit:blob:￿'));
    cur.onsuccess = () => {
      const c = cur.result;
      if (!c || out.length >= 8) return res(out);
      out.push({ byteLength: c.value.byteLength, bufferByteLength: c.value.buffer.byteLength });
      c.continue();
    };
  });
  idb.close();
  return { encoded, stored };
};

/** What a store holds, and what a deep gc takes. */
spike.storeProbe = async ({ tag }) => {
  const { kv, repo } = await openRepo(tag);
  const before = await storeBytes(kv);
  const tags = await repo.tags.list();
  const branches = await repo.branches.list();
  const db = await KvSqlite.open(repo, 'db');
  const file = db.file.bytes;
  await db.close();
  let t = now();
  const removed = await repo.gc({ minAge: 0, deep: true });
  const ms = now() - t;
  const after = await storeBytes(kv);
  const strip = (s) => ({ ...s, heads: s.heads.length });
  return { tag, file, tags, branches, before: strip(before), deep: { removed, ms }, after: strip(after) };
};

spike.logProbe = async ({ tag }) => {
  const { repo } = await openRepo(tag);
  const out = { n: 0, infos: {}, oldest: null };
  for await (const c of repo.log({ branch: 'db' })) {
    out.n++;
    const tool = c.info?.tool ?? 'none';
    out.infos[tool] = (out.infos[tool] ?? 0) + 1;
    out.oldest = { hash: c.hash.slice(0, 8), parents: c.parents.length, time: c.time, info: c.info };
  }
  return out;
};

spike.markerProbe = async ({ tag }) => {
  const { kv, repo } = await openRepo(tag);
  const out = { now: Date.now() / 1000, markers: [] };
  for await (const [k, v] of kv.items('__inflight__')) {
    const commit = k.slice(12);
    let c = null;
    try {
      c = await repo.getCommit(commit);
    } catch (e) {
      c = String(e);
    }
    out.markers.push({ commit: commit.slice(0, 8), value: new TextDecoder().decode(v), commitTime: c?.time, parents: c?.parents?.length });
  }
  out.lease = new TextDecoder().decode((await kv.get('__gc_lease__')) ?? new Uint8Array());
  return out;
};

/** Transactions too big for the page cache (they spill outside an
 *  atomic batch), a rolled-back spilled transaction, and VACUUM. */
spike.spill = async () => {
  const tag = 'spill';
  const { repo } = await openRepo(tag, { fresh: true });
  const db = await KvSqlite.open(repo, 'db', { pageSize: 4096 });
  await db.exec(SCHEMA);
  await db.exec(`INSERT INTO calendars (name) VALUES ('Home')`);
  await insertMany(db, 0, 2000);
  await db.query('PRAGMA cache_size=25'); // 25 pages: 100 KB
  const s0 = { ...db.file.stats };
  await insertMany(db, 10_000, 3000);
  const s1 = { ...db.file.stats };
  const rowsCommitted = await rowCount(db);
  // A spilled transaction that rolls back.
  await db.query('BEGIN');
  for (let i = 0; i < 3000; i++) await db.query(INSERT, eventRow(20_000 + i));
  await db.query('ROLLBACK');
  const s2 = { ...db.file.stats };
  const rowsAfterRollback = await rowCount(db);
  await db.query('DELETE FROM events WHERE id % 3 = 0');
  const beforeVacuum = db.file.bytes;
  await db.query('VACUUM');
  const afterVacuum = db.file.bytes;
  const rowsLive = await rowCount(db);
  const headLive = db.head;
  await db.close();
  const { repo: repo2 } = await openRepo(tag);
  const db2 = await KvSqlite.open(repo2, 'db');
  const out = {
    statsSpilledTx: { batches: s1.batches - s0.batches, looseWrites: s1.looseWrites - s0.looseWrites },
    statsRolledBack: { batches: s2.batches - s1.batches, looseWrites: s2.looseWrites - s1.looseWrites, rollbacks: s2.rollbacks - s1.rollbacks },
    rowsCommitted,
    rowsAfterRollback,
    vacuum: { beforeVacuum, afterVacuum },
    rowsLive,
    rowsReopened: await rowCount(db2),
    sameHead: db2.head === headLive,
    integrity: (await db2.query('PRAGMA integrity_check'))[0].integrity_check,
  };
  await db2.close();
  return out;
};

/** Logical and physical bytes of each named store, read only. */
spike.sizeProbe = async ({ tags }) => {
  const out = {};
  for (const tag of tags) {
    const { kv } = await openRepo(tag);
    const s = await storeBytes(kv);
    out[tag] = { keys: s.keys, commits: s.commits, logical: s.bytes, physical: s.physical, ratio: s.physical / s.bytes };
  }
  return out;
};

/** A sync after a burst of small transactions: every commit's page
 *  versions travel, against only the pages that differ end to end. */
spike.syncBurst = async ({ tag }) => {
  const { kv, repo } = await openRepo(tag);
  const db = await KvSqlite.open(repo, 'db');
  const remote = new CountingRemote(new Memory(), { id: `mem-${Date.now()}-${Math.random()}` });
  await pushBranch(kv, remote, 'db');
  const out = { tag, pageSize: db.file.pageSize, fileBytes: db.file.bytes, bursts: [] };
  let i = 9_000_000;
  for (const n of [10, 100, 1000]) {
    const from = db.head;
    for (let k = 0; k < n; k++) {
      if (k % 2) await db.query(INSERT, eventRow(i++));
      else await db.query('UPDATE events SET notes = ? WHERE id = ?', [`burst ${k} ${Date.now()}`, 1 + ((k * 7919) % 20000)]);
    }
    await pushBranch(kv, remote, 'db');
    const pack = remote.packs.at(-1);
    // The same change as one commit: just the pages that differ.
    const diff = await repo.diff(from, db.head);
    const keys = [...diff.added, ...diff.modified];
    const snap = await repo.snapshot({ commit: db.head });
    const raw = await snap.rawMany(keys);
    let total = 0;
    for (const v of raw.values()) total += v.byteLength;
    const joined = new Uint8Array(total);
    let at = 0;
    for (const v of raw.values()) {
      joined.set(v, at);
      at += v.byteLength;
    }
    out.bursts.push({ tx: n, pack, netPages: keys.length, netRaw: total, netGz: (await gzip(joined)).byteLength });
  }
  await db.close();
  return out;
};

/** Two handles on one branch (two tabs, say), both writing. */
spike.twoWriters = async ({ tag }) => {
  const { repo } = await openRepo(tag);
  const a = await KvSqlite.open(repo, 'db');
  const b = await KvSqlite.open(repo, 'db');
  const rows0 = await rowCount(a);
  await a.query(INSERT, eventRow(10_000_001));
  let error = null;
  try {
    await b.query(INSERT, eventRow(10_000_002));
  } catch (e) {
    error = `${e.constructor?.name}: ${String(e.message ?? e).slice(0, 200)}`;
  }
  const out = { rows0, rowsA: await rowCount(a), rowsBAfterReload: await rowCount(b), error };

  // Disjoint edits: each updates a row on a different leaf page.
  const [lo, hi] = [(await a.query('SELECT min(id) AS v FROM events'))[0].v, (await a.query('SELECT max(id) AS v FROM events'))[0].v];
  await b.reload();
  await a.query('UPDATE events SET title = ? WHERE id = ?', ['edited by A', lo]);
  let disjointError = null;
  try {
    await b.query('UPDATE events SET title = ? WHERE id = ?', ['edited by B', hi]);
  } catch (e) {
    disjointError = `${e.constructor?.name}: ${String(e.message ?? e).slice(0, 200)}`;
  }
  const tip = await repo.branches.get('db');
  const merged = await repo.getCommit(tip);
  out.disjoint = { error: disjointError, tipParents: merged.parents.length };
  await a.close();
  await b.close();
  const { repo: r2 } = await openRepo(tag);
  const c = await KvSqlite.open(r2, 'db');
  out.rowsReopened = await rowCount(c);
  out.integrity = (await c.query('PRAGMA integrity_check'))[0].integrity_check;
  out.disjoint.titles = (await c.query('SELECT id, title FROM events WHERE id IN (?, ?)', [lo, hi])).map((r) => r.title);
  await c.close();
  return out;
};

/** Count a store's keys, and its commits' in-flight markers. */
async function storeKeys(kv) {
  let keys = 0;
  let inflight = 0;
  for await (const k of kv.keys()) {
    keys++;
    if (k.startsWith('__inflight__')) inflight++;
  }
  return { keys, inflight };
}

const errorName = (e) => (e ? `${e.name ?? e.constructor?.name}: ${String(e.message ?? e).slice(0, 200)}` : null);

/**
 * Two writers on one branch as two tabs would have them: each its own
 * IndexedDB connection, Repo and in-memory pages, loaded at the same
 * head. With onMoved 'raise' the second commit must fail and the
 * second writer recovers by reloading and redoing; with kvgit's default
 * the two merge page by page.
 */
spike.twoTabs = async ({ tag }) => {
  const tab = async (onMoved) => {
    const { kv, repo } = await openRepo(tag);
    const db = await KvSqlite.open(repo, 'db');
    db.onMoved = onMoved;
    return { kv, repo, db };
  };
  const title = async (db, id) => (await db.query('SELECT title FROM events WHERE id = ?', [id]))[0].title;
  const freshView = async (ids) => {
    const { repo } = await openRepo(tag);
    const c = await KvSqlite.open(repo, 'db');
    const tip = await repo.getCommit(c.head);
    const out = {
      head: c.head,
      tipParents: tip.parents.length,
      titles: Object.fromEntries(await Promise.all(ids.map(async (id) => [id, await title(c, id)]))),
      rows: await rowCount(c),
      integrity: (await c.query('PRAGMA integrity_check'))[0].integrity_check,
    };
    await c.close();
    return out;
  };
  const out = {};

  // --- Disjoint pages, onMoved 'raise' ---
  {
    const a = await tab('raise');
    const b = await tab('raise');
    const [lo, hi] = [(await a.db.query('SELECT min(id) AS v FROM events'))[0].v, (await a.db.query('SELECT max(id) AS v FROM events'))[0].v];
    const base = a.db.head;
    const sameBase = base === b.db.head;
    const titles0 = { lo: await title(a.db, lo), hi: await title(a.db, hi) };
    const stamp = Date.now();
    await a.db.query('UPDATE events SET title = ? WHERE id = ?', [`A ${stamp}`, lo]);
    const headA = a.db.head;
    const keysBefore = await storeKeys(a.kv);
    let err = null;
    try {
      await b.db.query('UPDATE events SET title = ? WHERE id = ?', [`B ${stamp}`, hi]);
    } catch (e) {
      err = e;
    }
    const keysAfter = await storeKeys(a.kv);
    const failure = b.db.lastFailure;
    const afterRefusal = await freshView([lo, hi]);
    // Recovery: the failed flush already reloaded B at the branch tip.
    const bReloadedAt = b.db.head;
    const bSeesA = (await title(b.db, lo)) === `A ${stamp}`;
    await b.db.query('UPDATE events SET title = ? WHERE id = ?', [`B ${stamp}`, hi]);
    const headB = b.db.head;
    const bCommit = await b.repo.getCommit(headB);
    const recovered = await freshView([lo, hi]);
    // An empty commit on a moved branch also raises.
    let emptyErr = null;
    try {
      await a.db.wt.commit({ onMoved: 'raise' });
    } catch (e) {
      emptyErr = e;
    }
    out.raiseDisjoint = {
      lo,
      hi,
      sameBase,
      titles0,
      error: errorName(err),
      isBranchMovedError: err instanceof kvgit.BranchMovedError,
      isConcurrencyError: err instanceof kvgit.ConcurrencyError,
      errorHeadIsA: err?.head === headA,
      errorBaseIsBase: err?.base === base,
      pendingKeptAtThrow: failure?.pendingKept ?? null,
      storeKeysDelta: keysAfter.keys - keysBefore.keys,
      inflightAfterRefusal: keysAfter.inflight,
      afterRefusal: { ...afterRefusal, headIsA: afterRefusal.head === headA, loIsA: afterRefusal.titles[lo] === `A ${stamp}`, hiUnchanged: afterRefusal.titles[hi] === titles0.hi },
      recovery: {
        reloadedAtA: bReloadedAt === headA,
        seesA: bSeesA,
        redoParents: bCommit.parents.length,
        fastForwardOnA: bCommit.parents[0] === headA,
        ...recovered,
        bothPresent: recovered.titles[lo] === `A ${stamp}` && recovered.titles[hi] === `B ${stamp}`,
      },
      emptyCommitOnMoved: { error: errorName(emptyErr), isBranchMovedError: emptyErr instanceof kvgit.BranchMovedError },
    };
    await a.db.close();
    await b.db.close();
  }

  // --- Same page (two inserts at the end of the table), onMoved 'raise' ---
  {
    const a = await tab('raise');
    const b = await tab('raise');
    const rows0 = await rowCount(a.db);
    await a.db.query(INSERT, eventRow(11_000_001));
    let err = null;
    try {
      await b.db.query(INSERT, eventRow(11_000_002));
    } catch (e) {
      err = e;
    }
    const failedRows = await rowCount(b.db);
    await b.db.query(INSERT, eventRow(11_000_002));
    const view = await freshView([]);
    out.raiseSamePage = { rows0, error: errorName(err), isBranchMovedError: err instanceof kvgit.BranchMovedError, rowsAfterReload: failedRows, rowsFinal: view.rows, tipParents: view.tipParents, integrity: view.integrity };
    await a.db.close();
    await b.db.close();
  }

  // --- Disjoint pages, kvgit's default (merge): the old hazard ---
  {
    const a = await tab(undefined);
    const b = await tab(undefined);
    const [lo, hi] = [(await a.db.query('SELECT min(id) AS v FROM events'))[0].v, (await a.db.query('SELECT max(id) AS v FROM events'))[0].v];
    const stamp = Date.now();
    await a.db.query('UPDATE events SET title = ? WHERE id = ?', [`A2 ${stamp}`, lo]);
    let err = null;
    try {
      await b.db.query('UPDATE events SET title = ? WHERE id = ?', [`B2 ${stamp}`, hi]);
    } catch (e) {
      err = e;
    }
    // B's pages in memory never saw A's edit, though the branch has it.
    const bSeesLo = await title(b.db, lo);
    const view = await freshView([lo, hi]);
    out.mergeDisjoint = {
      error: errorName(err),
      tipParents: view.tipParents,
      branchHasBoth: view.titles[lo] === `A2 ${stamp}` && view.titles[hi] === `B2 ${stamp}`,
      bStaleInMemory: bSeesLo !== `A2 ${stamp}`,
      bSeesLo,
      integrity: view.integrity,
    };
    await a.db.close();
    await b.db.close();
  }
  return out;
};
