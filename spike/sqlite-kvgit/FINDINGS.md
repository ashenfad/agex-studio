# SQLite on a kvgit branch: spike findings

The question was whether agex-studio should give apps a SQLite `db`
whose storage is a kvgit branch, one database page per key. The spike
built that and measured it in headless Chromium on real IndexedDB.

## Verdict: go, with changes

The design works and is fast enough. With the whole database in
memory, a one-row transaction is durable in kvgit 2 ms later. A 10 MB
database opens in 40 to 160 ms, depending on page size. One small edit
syncs as 2 to 7 KB of gzip at 4 KB pages, against 3.1 MB for the whole
file gzipped. Checkpoints cost about a millisecond, and a test copy
costs a few. Interrupted writes, tab crashes, rollbacks, spilled
transactions and VACUUM all reopened to the last committed state, and
`PRAGMA integrity_check` came back ok every time.

These changes are needed before it ships. Change 1 and kvgit's half of
change 2 have since landed in kvgit; see "Re-run on fixed kvgit
(2026-10-16)" at the end.

1. **Fix kvgit's value buffers (a bug that affects the whole studio, not
   just SQLite).** kvgit's CBOR codec returns views into cbor-x's encode
   buffer. That buffer is about four times larger than the value: a
   4 KB page sits in a 20 KB buffer and a 64 KB page in a 260 KB one.
   IndexedDB's structured clone stores a view's *whole* buffer, so
   every value kvgit writes to IndexedDB is stored at about 4x its size.
   The spike's numbers use a store wrapper that copies each value into
   an exact buffer (`exactValues` in `src/bench.js`). Without it,
   storage is 3.8 to 4.3x larger, a 50 MB open takes 1.1 s instead of
   0.58 s, and peak memory while opening is 2.3x higher (tables below).
   The fix belongs in kvgit's IndexedDB backend or in `cborCodec.encode`.
2. **One writer per database branch, with fast-forward-only commits.**
   Two handles writing the same branch (two tabs, say) get a
   `MergeConflict` when their transactions touch the same page. When
   they touch *different* pages, kvgit three-way merges them page by
   page into a two-parent commit without complaint. That merged file
   passed `integrity_check` here, but SQLite never made it. It can
   break invariants that span pages, and the second writer keeps
   running on a stale in-memory copy. The studio needs a Web Lock per
   database branch. kvgit needs a commit mode that fails rather than
   merges when the branch has moved; today the only option is to check
   the head first, and that check can race.
3. **Give apps whole transactions.** Pages go to kvgit only when SQLite
   is back in autocommit. So `agex.db.query` should be one transaction,
   with a `transaction([...])` form for several statements. A `BEGIN`
   that a call leaves open should be rolled back at the end of the
   call, not kept across messages.
4. **Plan for history.** Every transaction keeps its page versions:
   about 18 KB per small transaction at 4 KB pages, so roughly 18 MB per
   1000 edits until pruned. Pruning (squash to a new root, then `gc`)
   takes the store back to the file's size, but it rewrites history.
   Sync is fast-forward only, so a pruned branch is `diverged` from its
   remote. See "How sync and GC fit".

**Recommended page size: 4 KB** (SQLite's default). It is the slowest to
open (0.58 s at 50 MB, against 0.25 s at 16 KB), but it is the cheapest
everywhere a database pays over its whole life. Per-edit sync is
2 to 7 KB against 5 to 24 KB at 16 KB. History grows 18 KB per
transaction against 47 KB at 16 KB and 167 KB at 64 KB. A sync after
1000 edits is 1.2 MB against 3.2 MB and 34 MB. 64 KB pages are a poor
fit: each one is larger than gzip's 32 KB window, so page versions in a
pack don't compress against each other.

## Build: wa-sqlite 1.1.2

The spike uses [wa-sqlite](https://github.com/rhashimoto/wa-sqlite) at
tag v1.1.2 (2026-08-10, SQLite 3.53.0; its package.json says 1.1.1).
It's installed from GitHub, because the npm package named `wa-sqlite`
is an unrelated placeholder. It made the VFS clean:

- `FacadeVFS` turns the C VFS into JS methods that take a `Uint8Array`
  and an offset. The synchronous build (`dist/wa-sqlite.mjs`) runs them
  synchronously, with no Asyncify cost.
- The build has `SQLITE_ENABLE_BATCH_ATOMIC_WRITE`, and `jFileControl`
  receives `BEGIN/COMMIT/ROLLBACK_ATOMIC_WRITE`.

The official `@sqlite.org/sqlite-wasm` (3.53.4-build1) can also host a JS
VFS (`sqlite3.vfs.installVfs` over its struct wrappers), but it's more
code, and that build lacks `ENABLE_BATCH_ATOMIC_WRITE`. As it turned
out, batch-atomic is not load-bearing here (see below), so the
official build is a real option.

The dependency lives in `spike/sqlite-kvgit/package.json`, in the spike's
own `node_modules`. The studio's `node_modules` and lockfile are
untouched.

## Session extension (changesets)

| build | `ENABLE_SESSION` | session/changeset exports |
|---|---|---|
| wa-sqlite 1.1.2 (chosen) | no | 0 |
| @journeyapps/wa-sqlite 2.0.5 (the PowerSync fork) | no | 0 |
| @sqlite.org/sqlite-wasm 3.53.4-build1 | yes, with `ENABLE_PREUPDATE_HOOK` | 44 (`sqlite3session_create`, `sqlite3changeset_apply`, `sqlite3changegroup_*`, `sqlite3rebaser_*`, ...) |

These were checked with `WebAssembly.Module.exports` on each `.wasm`, and
with `PRAGMA compile_options` at runtime for wa-sqlite. Real two-device
merges are possible later in two ways. One is to move this VFS to the
official build, giving up batch-atomic, which this design doesn't need.
The other is a custom wa-sqlite build with
`-DSQLITE_ENABLE_SESSION -DSQLITE_ENABLE_PREUPDATE_HOOK`, the extra
exports, and JS bindings for them, since wa-sqlite's `sqlite-api.js` has
none. Page-level merges are not a substitute: see change 2 above.

## The VFS

`src/pagevfs.js` and `src/kvsqlite.js`.

- **Pages in memory.** `PageFile` holds `Map<pageNumber, Uint8Array>`.
  Pages are immutable: a write replaces the page object and never
  mutates it. So pages go to kvgit without copying, and a test copy
  (`fork()`) is a shallow copy of the map.
- **Batch-atomic.** `jDeviceCharacteristics` reports
  `SQLITE_IOCAP_BATCH_ATOMIC`. The connection uses
  `journal_mode=MEMORY` (batch-atomic needs an in-memory journal) and the
  default `synchronous=FULL`. A transaction's writes arrive between
  `BEGIN_ATOMIC_WRITE` and `COMMIT_ATOMIC_WRITE`. They're staged apart
  from the committed pages and join them on commit; a rollback drops
  them. In the builds, every transaction went out as a batch
  (`looseWrites` 0).
- **Commit to kvgit after the transaction.** After each statement, if
  `sqlite3_get_autocommit` says no transaction is open, the dirty pages
  become one `wt.commit()`, and `query()` resolves only after that.
  Pages a truncate removed become deletions.
- **Fallback when there is no batch.** A transaction too big for the
  page cache spills, and SQLite then writes pages outside any batch.
  VACUUM and the rollback of a spilled transaction do the same. Those
  writes go straight to the pages and are marked dirty, so the commit at
  the next transaction boundary still carries them. Tested with a
  100 KB cache: a spilled 3000-row insert (229 loose writes), a spilled
  3000-row insert rolled back (1020 loose writes restoring the original
  pages), and a VACUUM. All reopened from kvgit with the right row count
  and `integrity_check` ok.

  Because of this, batch-atomic is an optimization here, not what makes
  it correct. Every write lands in memory, and kvgit only sees pages at
  a transaction boundary, when the file is consistent whichever path
  SQLite took. A VFS without batch-atomic, as on the official build,
  would also be correct, with a little more journal work.
- **If the kvgit commit fails,** the in-memory database is ahead of the
  branch. `flush` discards the pending writes, reloads the pages from
  the branch head, reopens the connection and throws, so the app sees
  an error and the last durable state.
- **Restore** closes the connection, moves the branch with `wt.reset`,
  reloads the pages and reopens. An incremental restore reads only the
  pages `repo.diff` says changed, and reuses the rest of the map.

### Problems found

- **Where the async gap bit.**
  - IndexedDB is async and the VFS must be sync, so the whole database
    has to be in memory; the spike can't page in lazily. wa-sqlite's
    JSPI and Asyncify builds would allow reading pages on demand, at a
    cost per call that wasn't measured.
  - SQLite reports a transaction committed before kvgit has it. The
    studio has to reply to the app only after the flush, and run one
    query at a time, so no reply ever describes state that isn't
    durable.
  - Pages go to kvgit only at a transaction boundary, so a transaction
    an app leaves open would never persist. Hence change 3.
- **Concurrent writers merge pages silently** (change 2). Measured:
  overlapping inserts raised `MergeConflict on page/3160`. Disjoint
  updates (the lowest and highest row ids) produced a two-parent merge
  commit holding both edits. Page 1's change counter doesn't catch this:
  both writers bump it to the same value, so kvgit sees an identical
  change on both sides.
- **An interrupted commit pins history for ten minutes.** One crashed
  tab left a commit batch that landed without its head. Its in-flight
  marker kept that commit's whole ancestry (1220 commits, 210 MB) alive
  through `gc` until the marker lapsed after 10 minutes; then `gc`
  reclaimed it all. This is correct behavior, but pruning right after a
  crash reclaims nothing.
- **Opening walks the keyset twice.** `repo.worktree()` loads every key's
  pointer (`populateState`), then the snapshot walks the HAMT again to
  read the pages. At 13,000 keys that's 75 ms on top of the read. Each
  commit also copies the worktree's key map, so commit cost grows with
  the key count: 2 ms at 2,800 keys and 4 ms at 13,000.
- **Peak memory while opening is several times the file size, though
  most of it is uncollected garbage.** Reading in chunks, with a GC
  between chunks, cuts the 50 MB peak from 150 MB to 77 MB (4 KB pages)
  or 63 MB (16 KB). A real loader should read a few MB at a time.
  Steady state is the file size plus SQLite's page cache. The spike set
  `cache_size` to 16 MB; it could be much smaller, because a read from
  this VFS is a memcpy.

## Measurements

Setup: Apple M4, chrome-headless-shell 149.0.7827.55, a persistent
profile (IndexedDB on disk), and @agex-ts/kvgit 0.1.3 from the agex-ts
checkout, with the `cbor` codec the studio's store uses. Every number
uses the exact-buffer wrapper unless it's marked unfixed. The workload
is a single-user calendar: `events` (title, start, end, all-day, rrule,
until, location, notes up to 400 characters), an index on `start`, a
partial index on recurring events, and an `exceptions` table. The month
query reads one month's single events by `start`, plus the recurring
events overlapping that month, joined to their exceptions.

`node spike/sqlite-kvgit/run.mjs` reruns everything into `results.json`,
and `node spike/sqlite-kvgit/summarize.mjs` prints these tables.
`results-unfixed.json` is the comparison run without the wrapper.

### 1. Open

The time from IndexedDB to the first answered query. Each figure is the
median of 3 runs, each in a fresh page; the slowest is in brackets.
"Peak" is the renderer's JS heap plus ArrayBuffer backing stores,
sampled every 20 ms through CDP. "Settled" is after a GC, with the
database open.

| db | keys | worktree ms | page load ms | total ms | month query ms | peak MB | settled buffers MB | wasm heap MB |
|---|---|---|---|---|---|---|---|---|
| 1mb-4k | 284 | 3.3 | 21 | 30 [32] | 2.8 | 10.8 | 3.4 | 16.6 |
| 1mb-16k | 74 | 1.1 | 16 | 21 [21] | 3.0 | 9.6 | 3.5 | 16.6 |
| 1mb-64k | 23 | 0.9 | 15 | 20 [20] | 2.5 | 10.0 | 3.7 | 16.6 |
| 10mb-4k | 2822 | 27 | 100 | 163 [176] | 13 | 37.2 | 13.3 | 16.6 |
| 10mb-16k | 690 | 4.5 | 39 | 60 [61] | 12 | 19.0 | 13.1 | 16.6 |
| 10mb-64k | 175 | 2.4 | 26 | 41 [42] | 11 | 28.4 | 13.2 | 16.6 |
| 50mb-4k | 12994 | 75 | 390 | 576 [577] | 38 | 150.4 | 53.1 | 20.0 |
| 50mb-16k | 3223 | 33 | 149 | 246 [248] | 35 | 114.6 | 52.7 | 20.0 |
| 50mb-64k | 804 | 5.2 | 62 | 115 [119] | 44 | 117.3 | 52.6 | 20.0 |

The same opens with kvgit unfixed:

| db | total ms | peak MB |
|---|---|---|
| 10mb-4k | 227 | 81 |
| 10mb-16k | 81 | 66 |
| 10mb-64k | 71 | 63 |
| 50mb-4k | 1102 | 350 |
| 50mb-16k | 381 | 280 |
| 50mb-64k | 233 | 265 |

Reading 50 MB in chunks, with and without a forced GC between chunks:

| variant | total ms | peak MB |
|---|---|---|
| 4k, 256 pages | 549 | 130 |
| 4k, 256 pages, gc | 655 | 77 |
| 16k, 256 pages | 247 | 85 |
| 16k, 256 pages, gc | 264 | 63 |
| 64k, 256 pages | 105 | 82 |
| 64k, 256 pages, gc | 108 | 63 |

### 2. Commit cost

The latency from a one-row INSERT to a durable kvgit commit (50 samples
after warm-up), and throughput. A one-row transaction touches 3 pages:
the table leaf, the index leaf and page 1.

| db | one-row tx, median / p95 ms | SQLite ms | kvgit commit ms | 1000 one-row tx | tx/s | 1000 rows in one tx |
|---|---|---|---|---|---|---|
| 10mb-4k | 2.2 / 3.1 | 0.1 | 2.1 | 2.18 s | 458 | 68 ms |
| 10mb-16k | 1.8 / 2.2 | 0.1 | 1.7 | 1.84 s | 543 | 28 ms |
| 10mb-64k | 1.8 / 3.1 | 0.2 | 1.7 | 2.20 s | 454 | 23 ms |
| 50mb-4k | 4.2 / 5.4 | 0.2 | 4.0 | 4.76 s | 210 | 216 ms |
| 50mb-16k | 2.9 / 3.7 | 0.2 | 2.7 | 3.24 s | 309 | 90 ms |
| 50mb-64k | 2.2 / 3.6 | 0.2 | 2.0 | 2.98 s | 335 | 46 ms |

Unfixed, at 10 MB: 2.4 / 2.0 / 4.2 ms median, and 385 / 408 / 211 tx/s.

"Durable" means the IndexedDB transaction completed. kvgit doesn't ask
for `durability: 'strict'`, so this survives a tab crash (tested) but
was not tested against power loss.

### 3. Sync size

Pack bytes, counted by pushing through a `MemoryRemote` subclass that
encodes each push with `encodePack`, as `PackRemote` sends it (gzip
CBOR). The database is 10 MB; the whole file gzips to 3.1 MB.

| page | insert one row | update one row | move an event (start changes, index moves) | delete one row |
|---|---|---|---|---|
| 4 KB | 3 pages, 4.4 KB | 2 pages, 2.0 KB | 4 pages, 6.9 KB | 3 pages, 4.5 KB |
| 16 KB | 3 pages, 11.7 KB | 2 pages, 5.4 KB | 4 pages, 24.2 KB | 3 pages, 15.7 KB |
| 64 KB | 3 pages, 45.6 KB | 2 pages, 17.8 KB | 3 pages, 58.8 KB | 3 pages, 57.8 KB |

A sync carries every commit's page versions, not just the net change:

| page | tx since last sync | page versions | pack gzip | net changed pages, gzip |
|---|---|---|---|---|
| 4 KB | 10 | 28 | 28 KB | 15 pages, 27 KB |
| 4 KB | 100 | 263 | 195 KB | 108 pages, 183 KB |
| 4 KB | 1000 | 2659 | 1.16 MB | 702 pages, 0.95 MB |
| 16 KB | 1000 | 2562 | 3.2 MB | 514 pages, 2.9 MB |
| 64 KB | 1000 | 2536 | 33.7 MB (159 MB raw, several packs) | 95 pages, 1.7 MB |

The edits in the burst hit rows at random across the table, which is
close to the worst case for a calendar.

The first push sends the whole history. For the 10 MB database with
1070 commits behind it, that was 5.0 MB gzip at 4 KB pages, 4.8 MB at
16 KB and 58 MB at 64 KB.

### 4. Checkpoints

The database is 10 MB. The restore goes back over 20 inserts, 20
updates and a 500-row delete. The test copy is a branch at the head,
opened by sharing the in-memory pages, given 11 writes, then deleted.

| page | tag | full restore (move / load) | incremental restore (pages read) | test copy: branch / open / writes / delete |
|---|---|---|---|---|
| 4 KB | 3.2 ms | 102 ms (29 / 72) | 66 ms (177) | 0.6 / 29 / 26 / 0.2 ms |
| 16 KB | 0.8 ms | 29 ms (4.8 / 24) | 16 ms (58) | 0.4 / 4.9 / 20 / 0.2 ms |
| 64 KB | 0.8 ms | 14 ms (2.8 / 11) | 6.6 ms (20) | 0.9 / 2.4 / 23 / 0.2 ms |

Restore times run until a `count(*)` sees the old rows, and every
restore passed `integrity_check`. Opening the copy at 4 KB pages is
29 ms because `repo.worktree()` walks the full keyset. A discarded copy
leaves its commits as orphans until `gc`.

### 5. Storage growth

Each database is a fresh 10 MB one, given 1000 small transactions
(alternating a row insert and a notes update). Pruning makes one new
root commit from the head's pages, resets the branch onto it, and runs
`repo.gc({ minAge: 0 })`.

| page | store before | after 1000 tx | per tx | after prune | squash | gc |
|---|---|---|---|---|---|---|
| 4 KB | 16.2 MB, 14 commits | 34.0 MB, 1014 commits | 18.2 KB | 12.1 MB, 2 commits | 0.7 s | 1.4 s |
| 16 KB | 14.5 MB, 14 commits | 60.2 MB, 1014 commits | 46.9 KB | 11.1 MB, 2 commits | 0.2 s | 1.2 s |
| 64 KB | 16.7 MB, 14 commits | 180.1 MB, 1014 commits | 167.4 KB | 11.1 MB, 2 commits | 0.1 s | 1.2 s |

These are logical bytes: the keys plus the values kvgit stores. Unfixed,
IndexedDB physically holds 3.8 to 4.3x that (each stored view's buffer):

| db (unfixed) | logical MB | physical MB | ratio |
|---|---|---|---|
| 10mb-4k | 42.2 | 160.6 | 3.80 |
| 10mb-16k | 77.2 | 302.7 | 3.92 |
| 10mb-64k | 237.5 | 948.2 | 3.99 |
| 50mb-4k | 143.6 | 612.2 | 4.26 |

`navigator.storage.estimate()` didn't track any of this usefully: it
reports the whole origin, and LevelDB compacts lazily.

### 6. Integrity

- **A commit that never lands.** A store wrapper made the head write
  throw, after the commit's batch had landed. The insert failed with the
  error; the handle reloaded to 42,055 rows (unchanged); a fresh
  connection saw the same head, the same rows, and `integrity_check` ok.
- **Tab crashes.** A page committed 200-row transactions in a loop until
  CDP `Page.crash` killed it. 21 crashes, at staggered times: every
  reopen held exactly the row count of the last commit the page had
  reported durable, `integrity_check` was ok, and the database was
  writable. At least one crash landed between a commit's batch and its
  head, because it left an in-flight marker, and that reopen was correct
  too.
- **Spills, rollback, VACUUM** are covered under the VFS above.

### 7. Session extension

See the table above: it's in the official build only.

## How sync and GC fit

- **Sync works as it is.** A database branch is an ordinary kvgit branch,
  so `pushBranch` and `PackRemote` carry it unchanged. Packs are
  per-commit, and at 4 KB pages that costs little: 1000 edits ship
  1.16 MB where the net change is 0.95 MB.
- **History is the cost.** Every transaction is a commit, and a database
  under steady use grows its store by about 18 KB per transaction at
  4 KB pages. Checkpoint tags pin their whole ancestry. kvgit has no
  shallow history. Pruning means squashing to a new root, which:
  - rewrites the branch. The remote then reports `diverged`, so a
    pruned database has to be pushed as a fresh remote branch (archive
    the old one), or kvgit needs a re-root operation that sync
    understands.
  - orphans the checkpoints. A tag still pins the old history, so
    pruning past a checkpoint means dropping the tag or replaying it
    (`wt.apply(base, target)` can land one commit's change on the new
    root).
- **GC is store-wide**, and its cost follows what the store holds. A
  sweep of a fresh 10 MB database took 9 to 80 ms. Reclaiming 1013
  commits took 1.2 to 1.4 s. On a 276 MB store, a deep sweep with
  nothing to take took 1.1 to 1.3 s, and reclaiming 1220 commits took
  5 s. While a sweep runs, writers wait (the lease), so it stalls
  database commits for that long. Run it when idle, not on a commit
  path.
- **Coalescing commits** would cut both history and sync, for example
  by flushing at most every N ms while still replying only after the
  flush. It wasn't measured. The per-edit numbers above are already
  small at 4 KB pages.

## Open questions

- Should kvgit's fix copy values at the IndexedDB boundary (cheap, local)
  or make `cborCodec.encode` return exact buffers (which also fixes the
  `Memory` backend's retained slack)? Studio data written before the fix
  stays bloated until it's rewritten; does it need a migration?
- What should a database's history policy be? Keep everything, keep N
  days, or squash on sync? And how should it fit with checkpoints that
  users expect to keep?
- Should a size limit for app databases be set? Memory is about the
  file size plus the page cache and wasm (20 MB), with a transient peak
  of up to 2x the file size even when loading in chunks. 50 MB costs
  about 80 MB resident and opens in 0.6 s at 4 KB pages.
- Is JSPI (lazy page reads from IndexedDB) worth measuring for larger
  databases, or is in-memory with a cap enough for app data?
- For two-device merges: the official build's session extension, or a
  custom wa-sqlite build? The VFS ports to either; the official build
  costs only batch-atomic, which this design doesn't need.
- Should a fast-forward-only commit be a kvgit `commit()` option, or a
  rule the studio enforces with a Web Lock plus a head check?
- Durability: should kvgit open IndexedDB transactions with
  `durability: 'strict'` for database commits, and what would that cost
  per commit?

## Re-run on fixed kvgit (2026-10-16)

kvgit on agex-ts `origin/main` (6115187) has three fixes the spike asked
for:

- **#115:** values are stored in buffers of their own size.
- **#116:** `commit({ onMoved: 'raise' })` throws `BranchMovedError`
  rather than merging onto a moved branch.
- **#117:** a commit updates the key maps in place, with an undo log,
  instead of copying them.

This section re-runs the affected measurements against that kvgit,
with the `exactValues` wrapper switched off.

**How it ran.** kvgit was built in a detached worktree
(`~/git/.agex-worktrees/agex-ts-main`). `SPIKE_KVGIT` points the spike's
vite config at it, aliasing each of the package's exports to its built
file. `SPIKE_NO_WRAP=1` drops the wrapper. In the browser, `info` showed
the fixed code running: `BranchMovedError` is exported (a subclass of
`ConcurrencyError`), and `cborCodec.encode` of a 4 KB page returns 4099
bytes in a 4099-byte buffer. The old kvgit returned an 8192-byte buffer
in a fresh page.

```
SPIKE_KVGIT=~/git/.agex-worktrees/agex-ts-main/packages/kvgit-ts SPIKE_NO_WRAP=1 \
SPIKE_RESULTS=$PWD/spike/sqlite-kvgit/results-fixed.json node spike/sqlite-kvgit/run.mjs \
  info build sizeProbe encodeProbe open commits commits50 sizeProbe checkpoints twoTabs twoWriters
SPIKE_MB=200 SPIKE_PAGES=4096 ... build open; SPIKE_MB=10,50,200 SPIKE_PAGES=4096 ... commitsAt
```

The setup was the same as before: the same machine, the same
chrome-headless-shell, a fresh on-disk profile, the same workload. The
first `sizeProbe` was renamed `sizeProbeBuilt` in `results-fixed.json`.

**Two controls.** Other work was running on the machine (load average
2.3 to 4.4), so the earlier figures aren't a clean baseline. Two more
runs used the same profile, after the main run:

- *pre-fix*: kvgit just before the fixes (agex-ts 28f77b9), with the
  wrapper.
- *repeat*: the fixed kvgit again.

Both are in `results-fixed.json` under `sameDay`. They ran after a
200 MB database was added to the origin, so their opens are slower
across the board. Compare them with each other, not with the main run.

### Buffer fix (#115): verdict, fixed

Stored bytes are measured at the same point as in the unfixed run:
10 MB databases after the commit step, 50 MB just built. The commit
counts and logical bytes match that run exactly. MB here is 10^6 bytes,
as in the earlier stored-bytes table.

| db | commits | unfixed logical / physical MB | fixed, no wrapper: logical / physical MB |
|---|---|---|---|
| 10mb-4k | 1070 | 42.2 / 160.6 (3.80x) | 42.2 / 42.2 (1.00x) |
| 10mb-16k | 1070 | 77.2 / 302.7 (3.92x) | 77.2 / 77.2 (1.00x) |
| 10mb-64k | 1070 | 237.5 / 948.2 (3.99x) | 237.5 / 237.5 (1.00x) |
| 50mb-4k | 50 | 143.6 / 612.2 (4.26x) | 143.6 / 143.6 (1.00x) |
| 50mb-16k | 51 | 128.0 / 520.9 (4.07x) | 128.0 / 128.0 (1.00x) |
| 50mb-64k | 51 | 133.1 / 535.3 (4.02x) | 133.1 / 133.1 (1.00x) |

Just built, the 1 MB databases store 1.3 / 1.3 / 1.8 MB, and the 10 MB
ones 17.0 / 15.2 / 17.5 MB, all at 1.00x. The 10 MB figures are the
patched run's "store before" (16.2 / 14.5 / 16.7 MiB). Read straight
from IndexedDB, stored page blobs are 4099, 16387 and 65541 bytes, in
buffers of the same size.

Open, median of 3 cold page loads:

| db | patched total ms | unfixed total ms | fixed total ms | patched peak MB | unfixed peak MB | fixed peak MB |
|---|---|---|---|---|---|---|
| 1mb-4k | 30 | - | 33 | 10.8 | - | 11.3 |
| 1mb-16k | 21 | - | 23 | 9.6 | - | 9.7 |
| 1mb-64k | 20 | - | 21 | 10.0 | - | 10.4 |
| 10mb-4k | 163 | 227 | 174 | 37.2 | 81 | 37.3 |
| 10mb-16k | 60 | 81 | 64 | 19.0 | 66 | 30.3 * |
| 10mb-64k | 41 | 71 | 44 | 28.4 | 63 | 29.1 |
| 50mb-4k | 576 | 1102 | 601 | 150.4 | 350 | 150.7 |
| 50mb-16k | 246 | 381 | 270 | 114.6 | 280 | 114.9 |
| 50mb-64k | 115 | 233 | 116 | 117.3 | 265 | 111.3 |

\* Two of the three 10mb-16k runs peaked at 30 MB and one at 19 MB. The
difference is when GC ran; the table takes the highest run.

Without any wrapper, the fixed kvgit matches the patched numbers. Storage
is 1.00x. Peak memory opening 50 MB is 151 / 115 / 111 MB, against
150 / 115 / 117 patched and 350 / 280 / 265 unfixed. A 50 MB open is
0.60 s, against 0.58 s patched and 1.10 s unfixed. Opens ran 0 to 10%
slower than the patched run. #115 changes only the write path, and the
same-day pair shows the same spread both ways (50mb-4k: pre-fix 674 ms,
repeat 737 ms), so this is machine conditions. By #115's own account,
values written before the fix keep their large buffers until rewritten (not tested here).

### Commit cost (#117): verdict, fixed up to 50 MB; still grows at 200 MB

One-row transaction to a durable commit, median / p95 ms, 50 samples, at
4 KB pages. The three sizes ran back to back in one `commitsAt` pass
for each kvgit. Each pass adds about 1,050 transactions, so the page
count grows a little from run to run.

| pages (about) | earlier patched | earlier unfixed | pre-fix, same day | fixed | fixed repeat |
|---|---|---|---|---|---|
| 2,800 to 3,700 (10 MB) | 2.2 / 3.1 | 2.4 / 3.9 | 2.8 / 5.0 | 2.0 / 3.9 | 2.3 / 3.7 |
| 13,000 to 13,900 (50 MB) | 4.2 / 5.4 | - | 4.2 / 5.8 | 2.0 / 2.9 | 2.4 / 4.1 |
| 51,500 to 51,900 (200 MB) | - | - | 11.8 / 17.3 | 3.9 / 6.6 | 4.3 / 9.9 |

All page sizes, from the `commits` and `commits50` steps. Each cell is
median / p95 ms, then throughput for 1000 one-row transactions:

| db | earlier patched | pre-fix, same day | fixed | fixed repeat |
|---|---|---|---|---|
| 10mb-4k | 2.2 / 3.1, 458 tx/s | 2.2 / 2.9, 398 tx/s | 1.9 / 5.3, 499 tx/s | 2.0 / 2.5, 406 tx/s |
| 10mb-16k | 1.8 / 2.2, 543 | 2.1 / 3.7, 457 | 1.7 / 2.1, 520 | 1.9 / 4.6, 441 |
| 10mb-64k | 1.8 / 3.1, 454 | 2.2 / 5.8, 382 | 2.0 / 2.6, 448 | 2.1 / 2.9, 355 |
| 50mb-4k | 4.2 / 5.4, 210 | 4.3 / 8.0, 216 | 2.5 / 3.8, 381 | 2.3 / 2.9, 322 |
| 50mb-16k | 2.9 / 3.7, 309 | 2.6 / 4.9, 332 | 2.1 / 3.6, 396 | 2.0 / 2.6, 357 |
| 50mb-64k | 2.2 / 3.6, 335 | 2.2 / 3.0, 371 | 2.1 / 2.9, 391 | 2.2 / 7.6, 357 |

What changed:

- **At 50 MB / 4 KB, the cost is now flat.** The median is 2.0 to
  2.5 ms against 4.2 ms, and throughput is 320 to 380 tx/s against 210.
  It is now about the 10 MB cost.
- **At 10 MB, the gain is small.** Copying a 2,800-key map was cheap, so
  2.2 ms became 1.9 to 2.0 ms, within noise. Throughput at 10 MB / 4 KB
  was 499 and 456 tx/s on the first fixed passes and 406 and 378 tx/s on
  the repeat, against 458 patched and 324 to 398 pre-fix the same day.
- **At 200 MB, the cost still grows, though 3x less.** It is 3.9 to
  4.3 ms against 11.8 ms pre-fix, and 189 to 207 tx/s against 76. The
  kvgit part is 3.6 to 4.1 ms of it, and nothing in kvgit's commit path
  should grow with the key count any more. The likely cause is IndexedDB
  itself getting slower per operation as the store grows; see
  "Something new" below. That wasn't separated out.
- **Large transactions didn't change.** 1000 rows in one transaction
  (68 to 109 ms at 10 MB, 194 to 236 ms at 50 MB) is about the pages
  written, so #117 doesn't touch it.
- **p95 is noisy.** A few runs have one outlier, such as the first fixed
  10mb-4k pass at 5.3 ms. The repeats don't show it.

### Two writers (#116): verdict, fails safe and recovers

Step `twoTabs`. Two writers get their own IndexedDB connection, `Repo`
and in-memory pages, as two tabs would, and both are loaded at the same
head. `KvSqlite` gained an `onMoved` field, passed through to
`wt.commit`. It also records `lastFailure`: the error, and whether kvgit
kept the pending changes, checked before the reload drops them. The
existing recovery path already did the rest: a failed flush discards,
reloads at the branch tip and throws.

- **Disjoint pages with `onMoved: 'raise'`** (the case that used to
  merge silently): A updates the lowest row id and commits. B updates
  the highest and commits.
  - B throws `BranchMovedError`. It's also a `ConcurrencyError`. Its
    `.base` is the shared head and its `.head` is A's commit.
  - kvgit kept B's pending changes at the throw.
  - The refused commit wrote nothing: the store's key count was
    unchanged and no in-flight marker was left. It saw the moved head
    before writing anything. The other path, a loss inside the CAS
    window, which withdraws its marker, needs an interleaving this test
    can't force and wasn't exercised.
  - A fresh connection then saw only A's commit: one parent, A's title
    on the low row, the high row untouched, `integrity_check` ok.
- **Recovery.** B was already reloaded at A's head and saw A's edit. It
  redid its update and committed. The result is a one-parent commit
  fast-forwarded on A's, and a fresh connection sees both edits with
  `integrity_check` ok.
- **Empty commit on a moved branch.** `wt.commit({ onMoved: 'raise' })`
  with nothing pending also throws `BranchMovedError`.
- **Same page (two inserts at the table's end) with `'raise'`.** B gets
  `BranchMovedError`, where before it got `MergeConflict on page/…`. It
  reloads, redoes the insert and commits: both rows, a one-parent tip,
  integrity ok. An app can now treat every lost race the same way:
  reload and redo.
- **Disjoint pages without the option** (kvgit's default, still
  `'merge'`). B's commit succeeds silently as a two-parent merge, and
  the branch holds both edits. B's in-memory pages never saw A's edit:
  the low row still shows its earlier title in B. This is the hazard the
  test is meant to catch, and it is still there by default. The old
  `twoWriters` step, one `Repo` for both writers and default merge,
  gives the same results as before: `MergeConflict` on overlapping
  inserts, and a two-parent merge holding both disjoint edits.

So the studio's database commits should always pass `onMoved: 'raise'`,
and still take a Web Lock per database branch so that a second tab
waits rather than redoing work.

### Checkpoints at 10 MB: verdict, unchanged

| db | | tag ms | full restore ms (move / load) | incremental ms (pages read) | test copy: branch / open / writes / delete ms |
|---|---|---|---|---|---|
| 10mb-4k | earlier patched | 3.2 | 102 (29 / 72) | 66 (177) | 0.6 / 29 / 26 / 0.2 |
| | fixed | 3.5 | 121 (36 / 84) | 67 (177) | 0.6 / 30 / 27 / 0.3 |
| | pre-fix, same day | 3.4 | 162 (48 / 113) | 82 (191) | 3.6 / 40 / 36 / 0.4 |
| | fixed repeat | 1.4 | 184 (57 / 127) | 91 (205) | 8.5 / 48 / 30 / 0.3 |
| 10mb-16k | earlier patched | 0.8 | 29 (4.8 / 24) | 16 (58) | 0.4 / 4.9 / 20 / 0.2 |
| | fixed | 1.0 | 30 (4.9 / 25) | 17 (58) | 0.5 / 4.9 / 20 / 0.2 |
| 10mb-64k | earlier patched | 0.8 | 14 (2.8 / 11) | 6.6 (20) | 0.9 / 2.4 / 23 / 0.2 |
| | fixed | 0.8 | 15 (2.9 / 12) | 10 (20) | 0.4 / 2.8 / 21 / 0.2 |

Every restore passed `integrity_check`. These costs are dominated by
reading pages and walking the keyset (`repo.worktree()` for the copy),
and none of the fixes change those. They come out about the same. The
4 KB full restore was 19% slower on the first fixed pass, and on the
same day it was slower again on both the pre-fix and repeat runs, so
that is machine conditions.

### Something new: opening 200 MB is superlinear

The 50,000-page point needed a 200 MB database (51,438 pages), the
first built in this spike.

- **The open is slow out of proportion.** It takes 11 s: worktree 2.0 s,
  key walk 1.5 s, page load 7.6 s. That is 19x the 50 MB open for 4x the
  pages. Per-page read cost rises from about 30 µs to about 145 µs.
- **Memory.** Peak is 477 MB; settled buffers are 203 MB.
- **It isn't the fixes.** Pre-fix kvgit takes the same time (12.3 s).
- **It isn't memory pressure.** Reading in chunks of 256 or 1024 pages,
  with or without a GC between chunks, still takes 10.8 to 12.2 s,
  though it lowers the peak to 260 to 290 MB.
- **It isn't the rest of the store.** A fresh profile holding only that
  database and a 50 MB one gives the same 10.9 s.

So IndexedDB reads get slower per key somewhere between 13,000 and
51,000 pages (this origin's LevelDB held 1.2 to 2.4 GB on disk). That
is probably also why commits at 200 MB still cost twice what they do at
50 MB. It supports capping app databases at about 50 MB while the
whole file must be in memory, or measuring lazy page reads (JSPI) for
anything larger. The open question on a size limit stands, with this
as its data point.
