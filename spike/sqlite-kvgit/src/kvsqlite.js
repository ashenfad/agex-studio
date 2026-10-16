// A SQLite database that lives on a kvgit branch, one page per key.
//
// While open, every page is in memory (a PageFile), so the VFS stays
// synchronous. After each statement that leaves SQLite in autocommit
// mode (a transaction just ended), the pages it changed become one
// kvgit commit on the branch; `query` resolves only once that commit
// is durable. Inside an explicit BEGIN ... COMMIT the commit waits for
// the COMMIT.

import SQLiteESMFactory from 'wa-sqlite/dist/wa-sqlite.mjs';
import * as SQLite from 'wa-sqlite';
import { PageFile, PageVFS } from './pagevfs.js';

const PAGE_PREFIX = 'page/';
const META_KEY = 'sqlite/meta';

let runtime = null;

/** How loadPages reads: `chunk` pages per read, 0 for one read. */
export const loadOptions = { chunk: 0, gc: false };

/** The wasm module, the API and the VFS, made once per page. */
export async function sqliteRuntime() {
  runtime ??= (async () => {
    const module = await SQLiteESMFactory();
    const sqlite3 = SQLite.Factory(module);
    const vfs = await PageVFS.create('kvpages', module);
    sqlite3.vfs_register(vfs, false);
    return { module, sqlite3, vfs };
  })();
  return runtime;
}

export const pageKey = (n) => `${PAGE_PREFIX}${n}`;

/** Read every page of the database at `snapshot` into a PageFile. */
export async function loadPages(snapshot, fallbackPageSize, { chunk = loadOptions.chunk } = {}) {
  const meta = await snapshot.get(META_KEY);
  const keys = (await snapshot.keys()).filter((k) => k.startsWith(PAGE_PREFIX));
  const pages = new Map();
  // Read a chunk of pages at a time, so what IndexedDB hands back for
  // one chunk can be collected before the next arrives.
  const step = chunk > 0 ? chunk : keys.length;
  for (let i = 0; i < keys.length; i += step) {
    const values = await snapshot.getMany(keys.slice(i, i + step));
    for (const [k, v] of values) pages.set(Number(k.slice(PAGE_PREFIX.length)), v);
    if (loadOptions.gc) globalThis.gc?.();
  }
  const pageSize = meta?.pageSize ?? fallbackPageSize;
  for (let i = 0; i < pages.size; i++) {
    if (!pages.has(i)) throw new Error(`page ${i} missing of ${pages.size}`);
  }
  return new PageFile(pageSize, pages);
}

let seq = 0;

export class KvSqlite {
  /** @type {import('@agex-ts/kvgit').Worktree} */ wt;
  /** @type {PageFile} */ file;
  db = 0;
  path = '';
  commits = 0;
  /** If set, called with each commit's writes before they go to kvgit. */
  beforeCommit = null;
  /** kvgit's `onMoved` for each commit: 'raise' refuses to merge onto a
   *  branch another writer moved; undefined keeps kvgit's default. */
  onMoved = undefined;
  /** The last failed commit: its error and whether kvgit kept the
   *  pending changes, as seen before the reload dropped them. */
  lastFailure = null;

  /**
   * Open (or create) the database on `branch` of `repo`.
   * @param {import('@agex-ts/kvgit').Repo} repo
   */
  static async open(repo, branch, { pageSize = 4096, create = true, file } = {}) {
    const self = new KvSqlite();
    self.repo = repo;
    self.wt = await repo.worktree(branch, { create });
    if (file) self.file = file;
    else {
      const snap = await repo.snapshot({ commit: self.wt.head });
      self.file = await loadPages(snap, pageSize);
    }
    self.fresh = self.file.pages.size === 0;
    await self.#connect();
    if (self.fresh) {
      await self.exec(`PRAGMA page_size=${self.file.pageSize}`);
      self.wt.set(META_KEY, { pageSize: self.file.pageSize, format: 1 });
    }
    return self;
  }

  async #connect() {
    const { sqlite3, vfs } = await sqliteRuntime();
    this.sqlite3 = sqlite3;
    this.vfs = vfs;
    this.path = `/db-${++seq}.sqlite`;
    vfs.attach(this.path, this.file);
    this.db = await sqlite3.open_v2(
      this.path,
      SQLite.SQLITE_OPEN_READWRITE | SQLite.SQLITE_OPEN_CREATE,
      'kvpages',
    );
    // An in-memory journal: batch-atomic writes need one, and the only
    // file that has to survive is the database itself.
    await this.#run('PRAGMA journal_mode=MEMORY');
    await this.#run('PRAGMA temp_store=MEMORY');
    // Page cache well above a typical transaction, so a transaction's
    // pages stay in cache and go out as one atomic batch.
    await this.#run('PRAGMA cache_size=-16384');
  }

  async #run(sql, params, rows) {
    const { sqlite3, db } = this;
    for await (const stmt of sqlite3.statements(db, sql)) {
      if (params) sqlite3.bind_collection(stmt, params);
      let cols;
      while ((await sqlite3.step(stmt)) === SQLite.SQLITE_ROW) {
        if (rows) {
          cols ??= sqlite3.column_names(stmt);
          const r = sqlite3.row(stmt);
          rows.push(Object.fromEntries(cols.map((c, i) => [c, r[i]])));
        }
      }
    }
  }

  /** Run `sql` (one or more statements) and return the rows; durable
   *  in kvgit when it resolves, unless a transaction is still open. */
  async query(sql, params) {
    const rows = [];
    try {
      await this.#run(sql, params, rows);
    } finally {
      if (this.sqlite3.get_autocommit(this.db)) await this.flush();
    }
    return rows;
  }

  exec(sql) {
    return this.query(sql);
  }

  /** Commit the pages changed since the last flush as one kvgit commit. */
  async flush(info) {
    const { dirty, removed } = this.file.drain();
    if (dirty.size === 0 && removed.length === 0 && this.wt.status().clean) return null;
    for (const [n, page] of dirty) this.wt.set(pageKey(n), page);
    for (const n of removed) await this.wt.delete(pageKey(n));
    this.beforeCommit?.(dirty, removed);
    try {
      const result = await this.wt.commit({
        info: info ?? { tool: 'sql' },
        ...(this.onMoved !== undefined && { onMoved: this.onMoved }),
      });
      this.commits++;
      return result;
    } catch (e) {
      this.lastFailure = { error: e, pendingKept: !this.wt.status().clean, base: this.wt.head };
      // The pages in memory are ahead of the branch: drop them and
      // reload what is durable.
      this.wt.discard();
      await this.reload();
      throw e;
    }
  }

  /** Throw away the in-memory pages and reload them from the branch. */
  async reload(commit) {
    const t = [performance.now()];
    await this.#close();
    if (commit !== undefined) await this.wt.reset(commit);
    else await this.wt.refresh();
    t.push(performance.now());
    const snap = await this.repo.snapshot({ commit: this.wt.head });
    this.file = await loadPages(snap, this.file.pageSize);
    t.push(performance.now());
    await this.#connect();
    t.push(performance.now());
    this.lastTimings = { move: t[1] - t[0], load: t[2] - t[1], connect: t[3] - t[2] };
  }

  /**
   * Restore to `commit` reading only the pages that differ: the
   * branch moves to `commit` and only changed pages are fetched.
   */
  async restoreIncremental(commit) {
    const t = [performance.now()];
    const from = this.wt.head;
    const diff = await this.repo.diff(from, commit);
    t.push(performance.now());
    await this.#close();
    await this.wt.reset(commit);
    t.push(performance.now());
    const snap = await this.repo.snapshot({ commit });
    const want = [...diff.added, ...diff.modified].filter((k) => k.startsWith(PAGE_PREFIX));
    const got = want.length ? await snap.getMany(want) : new Map();
    t.push(performance.now());
    const pages = new Map(this.file.pages);
    for (const k of diff.removed) if (k.startsWith(PAGE_PREFIX)) pages.delete(Number(k.slice(5)));
    for (const [k, v] of got) pages.set(Number(k.slice(5)), v);
    this.file = new PageFile(this.file.pageSize, pages);
    await this.#connect();
    t.push(performance.now());
    this.lastTimings = { diff: t[1] - t[0], move: t[2] - t[1], load: t[3] - t[2], connect: t[4] - t[3] };
    return want.length + diff.removed.size;
  }

  async #close() {
    if (this.db) {
      await this.sqlite3.close(this.db);
      this.db = 0;
      this.vfs.detach(this.path);
    }
  }

  async close() {
    await this.#close();
  }

  get head() {
    return this.wt.head;
  }
}
