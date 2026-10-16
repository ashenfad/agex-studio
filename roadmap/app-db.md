# App database: `agex.db`

Status: design, 2026-10-16; not started. The numbers come from five
spikes in headless Chromium (Apple M4), each kept on a `spike/sqlite-*`
branch with its findings:

- each database page as a kvgit key, the first design;
- lazy kvgit keysets (agex-ts #118);
- an OPFS working file vs. reading pages from kvgit on demand;
- a log of changesets in kvgit, the design below;
- batching the log's kvgit commits.

The page-per-key design worked, but its synced page history (~18 KB
per small edit) needed history-rewriting pruning. A changeset log is
5–18x smaller locally and ~11x smaller synced, and needs no rewriting.

## Why

An app built in the studio gets one place to keep data, a
`localStorage` shim. Every session's data shares the studio's own
~5 MB `localStorage`; it's strings only; each sync rewrites the whole
bag; and IndexedDB is stubbed out, because native IndexedDB on the
shared apps origin would be one database for every app, untrusted
imports included. Key-value storage is also the wrong shape for most
apps: a single-user calendar wants a table and a range query, not a
bag of keys.

So apps get SQLite: `agex.db.query(sql, params)`, run by the studio in
a file of its own, with every change recorded in a log that syncs
through the same GitHub repo as the sessions. It should do real work
with real amounts of data: hundreds of MB to a few GB locally.

## Where it sits: the three kinds of state

nontainer-studio's `design.md` keeps three kinds of state apart. The
app database is the third, external state, as nontainer's `db` is:

| | workspace + conversation | app database |
|---|---|---|
| history | every turn; undo and redo | none implicit; explicit checkpoints only |
| undo a turn | rewinds | untouched |
| fork | copied (a branch) | shared: the fork names the same database |
| delete the session | gone | kept while anything names it; swept after |
| bundle, publish | carried | never carried |

The log exists for sync and checkpoints, not as versioning. The rule
is: *external state has no implicit history*. A checkpoint is a
deliberate restore point, like a production database's backups.

Where agex-studio differs from nontainer, because it runs in a tab:

- **Each viewer has their own.** A published app opened from a link
  runs in the viewer's studio, against the viewer's own (new, empty)
  database. There is no server whose rows every viewer shares.
- **It's per device until synced.** Sync to the person's GitHub repo
  is what makes it reach another device.
- **Tabs are writers.** Two studio tabs can open the same database,
  so writes need a lock (below).

## The app's API

```js
const { rows, changes, lastInsertRowid } = await agex.db.query(
  "SELECT * FROM events WHERE start >= ? AND start < ?", [from, to])

await agex.db.transaction([
  ["UPDATE accounts SET balance = balance - ? WHERE id = ?", [10, "a1"]],
  ["UPDATE accounts SET balance = balance + ? WHERE id = ?", [10, "a2"]],
])
```

- **Each `query` is one transaction;** `transaction([...])` runs
  several statements as one. A `BEGIN` left open at the end of a call
  is rolled back.
- **Rows come back as objects;** values are SQLite's (numbers, text,
  `null`, `Uint8Array` for blobs; integers past 2^53 as bigint).
- **Errors** are SQLite's message, with the statement's index in a
  `transaction`.
- **One database per session,** opened on first use.
- **What's refused**, by an authorizer and a schema check, each with an
  error that says what to do instead:
  - `ATTACH`, `VACUUM INTO` and extensions;
  - a table without a non-null `PRIMARY KEY`, checked after every
    schema change, which is rolled back if it fails;
  - virtual tables (`CREATE VIRTUAL TABLE`: FTS5, R*Tree), for now.

  The log records changes by primary key, and silently skips rows it
  can't key. Replaying a virtual table's shadow tables is untested.

It's a `postMessage` call to the studio, as `agex.task` is. The
studio takes the session from the frame the message came from, never
from anything in the message, so an app reaches only its session's
database.

## How it's stored

### The working file

A worker per open database runs the official SQLite build
(`@sqlite.org/sqlite-wasm`, which includes the session extension) on a
file in the origin-private file system (OPFS), through our own VFS over
synchronous access handles. SQLite's own rollback journal makes the
file crash-safe. A page read costs microseconds, and opening reads
only the header, so size barely affects either. At 1 GB the spikes
opened in under 0.2 s, read a month of a calendar (135k rows) in
1.0 s and scanned the table in 2.8 s.

### The log

Every transaction's changes are captured with the session extension as
a *changeset*: the rows it inserted, deleted, and the columns it
updated, by primary key (84–380 B for a one-row edit).

1. **The transaction** writes its changeset into a `_pending` table in
   the same file, in the same transaction. The file `COMMIT` makes the
   change durable on this device: 0.8–0.9 ms for a one-row
   transaction, from 50 MB to 1 GB.
2. **A flush** commits the pending changesets to kvgit as one log
   entry, then deletes them from `_pending`. A flush runs:
   - every 100 transactions;
   - when the tab is hidden or closed;
   - before a sync, a checkpoint, a schema change or a snapshot;
   - when the oldest pending change is a few seconds old.

   A flush of 100 takes ~2.3 ms.
3. **An entry** records `{from, to, digest, schema}`: the transaction
   numbers it covers, a hash of their changesets, and the schema
   version they were written under. Opening is idempotent: an entry
   whose digest matches the file's pending rows is this file's own
   flush, and those rows are dropped; any other entry is replayed.

**Entry format, chosen per flush.** By default an entry *packs* its
changesets side by side, so every transaction stays a restore point.
When merging the batch into one changeset (`changegroup`) makes it much
smaller, the flush stores the merged form. A game rewriting the same
rows every frame collapses that way; a calendar stays packed.

**Schema changes** aren't captured by the session extension, so DDL
runs on its own: the flush before it, then the SQL as an entry of its
own, which bumps the schema version. Replay re-executes it, so it must
be deterministic.

**Replay** turns off triggers (their effects are already in the log)
and foreign-key actions. It groups runs of entries into one changeset,
in chunks of ~100k transactions: 100k transactions replay in 1.1–1.5 s,
against 9.5 s one at a time.

**Growth.** At 100 transactions per flush, local history is ~320 B per
edit and sync ~63 B. A calendar flushing one or two edits at a time
costs ~1.1 KB locally and ~130 B synced per edit, a few MB a year.

### Epochs

A database's kvgit storage is a series of **epochs**. Each is a branch,
`db/<id>/<n>`. Its first commit holds a whole snapshot (`VACUUM INTO`,
gzipped, in ~8 MB chunks), and every later commit is one log entry, in
one key overwritten each time, so the commit chain is the log.

- **A new device** downloads the current epoch's snapshot and replays
  its log: 0.4 s at 200 MB and 2.0 s at 1 GB, plus the replay.
- **A new epoch** starts:
  - when the log since the snapshot reaches about half the snapshot's
    gzipped size. For a 200 MB database that's ~130k edits;
  - on a bulk change: a transaction whose changeset is large next to
    the snapshot (an import) starts a new epoch instead of becoming a
    huge log entry;
  - when the person or agent compacts.

  A database that's mostly appended to, like a calendar, may never need
  one.
- **Starting one:** flush, `VACUUM INTO` (writes pause ~2 s per GB),
  then gzip in the background (~21 s at 1 GB). Then commit the new
  branch and point the registry at it.
- **The old epoch** is deleted, locally and remotely, once the new one
  is synced. A device still on it rebuilds from the new snapshot and
  rebases its unsynced changes onto it. No branch is ever rewritten,
  so sync stays fast-forward, and nothing like squashing or re-rooting
  is needed.
- **A content hash** of the database is recorded with each snapshot. A
  device that replays through the same point compares its own, which
  catches silent divergence (below).

### Tabs and devices

- **One writer per database.** A Web Lock makes one tab the writer. The
  working file's access handle is exclusive, so other tabs send their
  queries to it (a `BroadcastChannel`) or wait for the lock.
- **A flush onto a moved branch** (another device's entries arrived by
  sync) gets `BranchMovedError` (`onMoved: 'raise'`). It undoes its
  pending changesets, applies the new entries, re-applies its own and
  retries: 20 ms in the spike.

### Size and space

- **Disk:** the file, plus one gzipped snapshot (~0.25x), plus the log:
  about 1.25x the database.
- **Large transactions:** a changeset is held in memory until its
  transaction ends. One over a set size starts a new epoch (above).
- **Soft cap:** a warning past ~2 GB.
- **Sync cap:** a database whose snapshot would exceed ~500 MB gzipped
  stays on its device unless the person opts in. GitHub advises repos
  under a few GB, and each epoch uploads a whole snapshot.

### Crash safety and durability

A transaction is durable on the device at its file `COMMIT`. It reaches
kvgit, and so sync, at the next flush. 36 crash trials across the two
log spikes, at every step of a transaction and a flush, reopened with
`integrity_check` ok, matched a replica built from the snapshot and log
row by row, and took the next write. Power loss is untested.

Until a flush, and until a sync, the data exists only in this browser's
storage, which a browser can evict. So:
- the studio requests persistent storage (`navigator.storage.persist()`);
- the settings view shows a database that exists on this device only;
- the settings view offers an export.

## Identity: whose database is it

A database has an id of its own, minted on first use (`db-<hex>`),
never spelled from a session name, as in nontainer.

The session→database link must survive an undo, so it can't live in
the session's history: undoing past the turn that made the app would
forget the link, and the sweep would take the data. It lives in a
small registry instead, branch `dbs`, synced like app data:
- `session/<name>` → id;
- `db/<id>` → the current epoch.

Deleting a session removes its entry; a sweep deletes the branches of
databases nothing names.

**A fork names the same database** by default, as in nontainer. A
schema change made while experimenting in a fork then reaches the
parent's app. So a fork can also take its own copy: a file copy, a new
id and a first epoch made from it.

## The agent

- **The agent can query it** from its code, as nontainer's agent holds
  `db`: a `db` host object in `run_ts` with the same `query` and
  `transaction`, so it can inspect data, debug and migrate. Its writes
  go through the same lock and log.
- **Checkpoints** are positions in the log: a store tag on the entry's
  commit, with a label and a time.
  - automatic, before every schema change, from the app or the agent;
  - explicit: `db.checkpoint("before backfill")`.

  Kept: every explicit one, and the last 10 automatic ones.
- **Restore** inverts the changesets back to the checkpoint, newest
  first: 10,000 transactions in under 2 s at any size. Packed entries
  reach any transaction. A restore across a schema change rebuilds from
  the epoch's snapshot and replays forward to the checkpoint instead.
  - The restore is logged as an ordinary entry, so other devices follow
    it by fast-forward.
  - It discards everything written since, possibly by the person using
    the app right now. So the agent must ask, as an app from a link
    asks before spending the viewer's key, and the open app reloads.
- **Diff, later:** the changesets between two checkpoints are already
  a diff by primary key. Showing them as tables is a later phase.

The person sees the checkpoints in the session's settings, and can
restore one or reset the database.

## Tests

`test_app` runs against a copy of the person's database file (38 ms at
50 MB, 64 ms at 200 MB, 0.5 s at 1 GB). The copy writes no log entries
and is deleted at the end. `{reload: true}` keeps it for the next call;
`live: true` uses the real database.

## Sync

- **Sync** pushes the current epoch's branch and `dbs` like any branch:
  fast-forward, only what's new. A one-row edit is 0.3–0.44 KB.
- **Two devices that both wrote** are rebased as a flush is: undo this
  device's unsynced entries, apply the synced ones, re-apply this
  device's. If nothing conflicts, the merge is automatic. That covers
  different rows, and different columns of the same row.
- **Any conflict stops the merge,** with the file unchanged. The person
  picks: keep this device's changes, or use the synced ones. The other
  side is kept as a checkpoint, so nothing is lost silently. A conflict
  here means the same column of the same row, a delete against an
  update, the same key inserted on both, or a constraint the
  combination breaks.
- **Merging around conflicts automatically** (this device wins, field
  by field) can come later as an opt-in.

## Integrity: what keeps devices from silently diverging

The session extension records changes by primary key and skips some
things without an error. The design closes each gap:

| gap | closed by |
|---|---|
| a table without a primary key isn't recorded | refused by the schema check |
| a row with a NULL key isn't recorded | key columns must be `NOT NULL` (schema check) |
| a change with more columns than the table (after `DROP COLUMN`) is skipped | entries carry the schema version; a flush, replay or rebase across a mismatch stops and says so |
| virtual tables' shadow tables | `CREATE VIRTUAL TABLE` refused for now |
| triggers and `ON DELETE CASCADE` firing again on replay | both turned off during replay and restore |
| anything else | a content hash with each snapshot, compared by devices replaying through it |

The schema version also covers app code and schema drifting apart
between devices: device B, still running the old app, can't flush old
changes onto a schema device A has moved on. It syncs, then the app
reloads with the new code.

## What the skill teaches

The skill's database section tells the agent:

- give every table a non-null `PRIMARY KEY`. For data that syncs, make
  it random (UUID-style). Auto-assigned integers collide when two
  devices insert while apart, which forces the person to pick a side;
- keep frame-rate state (positions, timers) in memory, and write to
  the database at moments worth keeping: saves, level ends, settings;
- group related writes with `transaction([...])`;
- make schema changes from its own code, deliberately: they checkpoint
  first, and they must be deterministic;
- use `LIKE` rather than FTS until virtual tables are allowed.

## What stays

- **`localStorage`** stays as it is, for small settings. (Moving its
  bag onto per-key kvgit entries, out of the studio's own
  `localStorage`, is a separate fix.)
- **IndexedDB** stays stubbed; its error now points at `agex.db`.

## Where the code lives

**`@agex-ts/kvsql`**, a new package in agex-ts beside kvgit-ts,
released with the rest of agex-ts. Its reusable core is about 1,850
lines of JS in the spikes:
- the OPFS VFS;
- the session and changeset helpers;
- the log with `_pending` and flush;
- snapshots and epochs;
- restore, replay and rebase.

It depends on `@sqlite.org/sqlite-wasm` and `@agex-ts/kvgit`'s public
API only. Its browser-only part is the VFS's file class; a Node file
class would make the rest run in Node.

The studio-specific parts are:
- the registry;
- the `agex.db` messages and frame mapping;
- the authorizer and schema check;
- the lock and tab routing;
- `test_app`;
- the settings view.

kvgit changes this needs:
- **Delete a remote branch** in `PackRemote`, for old epochs.
- **Push cost:** `walkDelta` walks the remote head's whole ancestry on
  each push. It should stop early using the generation numbers commits
  already record.
- **Lazy worktrees (#118)** matter less here than under the page
  design, but keep long logs cheap to open.

## Risks

1. **It's a sync engine,** and bugs in it lose data. Phase 1 needs:
   - randomized crash tests;
   - property tests that replay equals the source;
   - cross-device rebase scenarios.

   The log format is the long-term commitment, so it's versioned from
   the first entry.
2. **Only Chromium has been measured.** Before phase 1: OPFS sync
   handles and performance in Firefox and Safari, and memory on iOS
   (a 1 GB rebuild peaked at ~400 MB, grouped replay at ~650 MB).
3. **Browser storage can be evicted,** and people will assume their
   data is safer than it is (see Crash safety and durability).
4. **The official build** lacks two constants
   (`SESSION_OBJCONFIG_ROWID`, `CHANGESETAPPLY_FKNOACTION`, passed as
   numbers) and the backup API. Its version is pinned.
5. **Untested:**
   - routing many tabs through one writer;
   - large imports turning into epochs;
   - the GitHub pathway with chunked snapshots;
   - why transactions after idle gaps took 2 ms instead of 0.9.

## Phases

1. **The database, local only.** Starts with the cross-browser check.
   - The core: VFS, log, flush, epochs, replay.
   - The worker, and `agex.db.query`/`transaction`.
   - The authorizer and schema check.
   - Identity and registry; lock and tab routing.
   - Persistent storage, the this-device-only indicator, export.
   - The skill's section.
2. **Agent and tests.**
   - The `db` host object.
   - Checkpoints and restore, with asking.
   - `test_app` copies; a fork's own copy.
   - The settings view.
3. **Sync.**
   - Pushing epochs; chunked snapshots.
   - Rebase, and the conflict choice.
   - Deleting old epochs.
   - Content-hash checks.
   - kvgit: deleting remote branches, cheaper pushes.
4. **Later.**
   - Diffs as tables.
   - Opt-in merging around conflicts.
   - Virtual tables.
   - Seed data a publisher opts into.

### Build order in agex-ts

1. **Scaffold:** `packages/kvsql`, the pinned sqlite-wasm, Node and
   browser test setups (Chromium, Firefox, WebKit).
2. **File layer:** the file interface, OPFS and in-memory files, the
   VFS; the cross-browser check.
3. **Changesets and schema guard:** capture, invert, `changegroup`,
   apply; the authorizer and the primary-key check. In parallel with 2.
4. **The log:** `_pending`, flush, entry format v1, recovery, grouped
   replay, rebase; randomized crash and replay-equality tests.
5. **Checkpoints, restore, copies,** with a basic snapshot.
6. **Worker host:** one database per worker, a message protocol, Web
   Lock writer, tab routing, the flush on hide.
7. **Epochs:** triggers, new-device rebuild, content hash, old epochs.
8. **Sync,** after kvgit's remote branch deletion and cheaper pushes.

Phase 1 needs 1–4 and 6; phase 2, 5; phase 3, 7 and 8. The studio's
PRs follow each phase.

## Open questions

1. **The caps:** a ~2 GB soft cap and a ~500 MB-gzipped sync cap?
2. **The agent's restore:** ask every time, or only when the database
   changed since the checkpoint?
3. **Checkpoints older than the current epoch:** keep the old epoch
   locally while an explicit checkpoint needs it, or turn such a
   checkpoint into a snapshot of its own when the epoch changes?
4. **Registry vs. session plane:** is a second synced branch (`dbs`)
   the right home, or should it join `appdata/` as one branch of
   studio-wide records?
5. **nontainer parity:** nontainer's `db` has no checkpoints. Python's
   `sqlite3` doesn't expose the session extension, so the same log
   there needs a binding; or agex-studio leads, and nontainer follows
   later if at all.
