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

These changes are needed before it ships:

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
