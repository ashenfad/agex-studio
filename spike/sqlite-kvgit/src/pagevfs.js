// A synchronous wa-sqlite VFS whose main database file is a set of
// fixed-size pages held in memory. Every page is an immutable
// Uint8Array: a write replaces the page object, never mutates it, so a
// page can be handed to kvgit (or shared with a copy of the database)
// without copying.
//
// The main file's writes are tracked as dirty page numbers. SQLite is
// told the device does batch-atomic writes (SQLITE_IOCAP_BATCH_ATOMIC),
// so a transaction's page writes arrive between BEGIN_ATOMIC_WRITE and
// COMMIT_ATOMIC_WRITE and no rollback journal is written for them. The
// batch is staged apart from the committed pages and only joins them at
// COMMIT_ATOMIC_WRITE; ROLLBACK_ATOMIC_WRITE drops it. Writes that land
// outside a batch (a transaction too large for SQLite's page cache
// spills, VACUUM) go straight to the pages and are still marked dirty,
// so whoever drains the dirty set at a transaction boundary sees them.
//
// Every other file (temp files, a journal if one is ever made) is a
// plain growable buffer that never leaves memory.

import { FacadeVFS } from 'wa-sqlite/src/FacadeVFS.js';
import * as VFS from 'wa-sqlite/src/VFS.js';

/** The in-memory image of one database file, page by page. */
export class PageFile {
  /** @param {number} pageSize @param {Map<number, Uint8Array>} [pages] */
  constructor(pageSize, pages = new Map()) {
    this.pageSize = pageSize;
    /** @type {Map<number, Uint8Array>} page number (0-based) -> bytes */
    this.pages = pages;
    this.size = pages.size * pageSize;
    /** @type {Set<number>} pages written since the last drain */
    this.dirty = new Set();
    /** @type {Set<number>} pages cut off by a truncate since the last drain */
    this.removed = new Set();
    /** @type {Map<number, Uint8Array> | null} the open atomic batch */
    this.batch = null;
    this.batchSize = 0;
    this.stats = { batches: 0, batchPages: 0, looseWrites: 0, rollbacks: 0 };
  }

  /** A copy sharing every page: pages are immutable, so this is cheap. */
  fork() {
    return new PageFile(this.pageSize, new Map(this.pages));
  }

  /** Take the pages changed and removed since the last drain. */
  drain() {
    const dirty = new Map();
    for (const n of this.dirty) {
      const p = this.pages.get(n);
      if (p !== undefined) dirty.set(n, p);
    }
    const removed = [...this.removed].filter((n) => !this.pages.has(n));
    this.dirty = new Set();
    this.removed = new Set();
    return { dirty, removed };
  }

  get bytes() {
    return this.size;
  }

  #page(n) {
    return this.batch?.get(n) ?? this.pages.get(n);
  }

  #setPage(n, bytes) {
    if (this.batch) this.batch.set(n, bytes);
    else {
      this.pages.set(n, bytes);
      this.dirty.add(n);
      this.removed.delete(n);
      this.stats.looseWrites++;
    }
  }

  get #currentSize() {
    return this.batch ? this.batchSize : this.size;
  }

  read(dst, offset) {
    const ps = this.pageSize;
    const size = this.#currentSize;
    let done = 0;
    while (done < dst.byteLength) {
      const at = offset + done;
      if (at >= size) break;
      const n = Math.floor(at / ps);
      const inPage = at - n * ps;
      const len = Math.min(ps - inPage, dst.byteLength - done, size - at);
      const page = this.#page(n);
      if (page) dst.set(page.subarray(inPage, inPage + len), done);
      else dst.fill(0, done, done + len);
      done += len;
    }
    if (done < dst.byteLength) {
      dst.fill(0, done);
      return false;
    }
    return true;
  }

  write(src, offset) {
    const ps = this.pageSize;
    let done = 0;
    while (done < src.byteLength) {
      const at = offset + done;
      const n = Math.floor(at / ps);
      const inPage = at - n * ps;
      const len = Math.min(ps - inPage, src.byteLength - done);
      let page;
      if (inPage === 0 && len === ps) {
        page = src.slice(done, done + ps);
      } else {
        page = new Uint8Array(ps);
        const old = this.#page(n);
        if (old) page.set(old);
        page.set(src.subarray(done, done + len), inPage);
      }
      this.#setPage(n, page);
      done += len;
    }
    const end = offset + src.byteLength;
    if (this.batch) this.batchSize = Math.max(this.batchSize, end);
    else this.size = Math.max(this.size, end);
  }

  truncate(size) {
    const ps = this.pageSize;
    const keep = Math.ceil(size / ps);
    if (this.batch) {
      for (const n of [...this.batch.keys()]) if (n >= keep) this.batch.delete(n);
      this.batchSize = size;
      return;
    }
    for (const n of [...this.pages.keys()]) {
      if (n >= keep) {
        this.pages.delete(n);
        this.dirty.delete(n);
        this.removed.add(n);
      }
    }
    this.size = size;
  }

  beginBatch() {
    this.batch = new Map();
    this.batchSize = this.size;
  }

  commitBatch() {
    const batch = this.batch;
    this.batch = null;
    if (!batch) return;
    const keep = Math.ceil(this.batchSize / this.pageSize);
    for (const n of [...this.pages.keys()]) {
      if (n >= keep) {
        this.pages.delete(n);
        this.dirty.delete(n);
        this.removed.add(n);
      }
    }
    for (const [n, p] of batch) {
      this.pages.set(n, p);
      this.dirty.add(n);
      this.removed.delete(n);
    }
    this.size = this.batchSize;
    this.stats.batches++;
    this.stats.batchPages += batch.size;
  }

  rollbackBatch() {
    this.batch = null;
    this.stats.rollbacks++;
  }
}

/** A growable buffer for files that never leave memory. */
class ScratchFile {
  data = new Uint8Array(0);
  size = 0;
  read(dst, offset) {
    const n = Math.max(0, Math.min(dst.byteLength, this.size - offset));
    if (n > 0) dst.set(this.data.subarray(offset, offset + n));
    if (n < dst.byteLength) {
      dst.fill(0, n);
      return false;
    }
    return true;
  }
  write(src, offset) {
    const end = offset + src.byteLength;
    if (end > this.data.byteLength) {
      const grown = new Uint8Array(Math.max(end, this.data.byteLength * 2));
      grown.set(this.data.subarray(0, this.size));
      this.data = grown;
    }
    this.data.set(src, offset);
    this.size = Math.max(this.size, end);
  }
  truncate(size) {
    this.size = Math.min(this.size, size);
  }
}

export class PageVFS extends FacadeVFS {
  /** @type {Map<string, PageFile>} database files, by path */
  #databases = new Map();
  /** @type {Map<string, ScratchFile>} */
  #scratch = new Map();
  /** @type {Map<number, {path: string, file: PageFile | ScratchFile, flags: number}>} */
  #open = new Map();

  static async create(name, module) {
    const vfs = new PageVFS(name, module);
    await vfs.isReady();
    return vfs;
  }

  /** Make `file` the contents of database `path` (before opening it). */
  attach(path, file) {
    this.#databases.set(normalize(path), file);
  }

  detach(path) {
    this.#databases.delete(normalize(path));
  }

  jOpen(filename, fileId, flags, pOutFlags) {
    const path = normalize(filename || `tmp-${Math.random().toString(36).slice(2)}`);
    let file;
    if (flags & VFS.SQLITE_OPEN_MAIN_DB) {
      file = this.#databases.get(path);
      if (!file) return VFS.SQLITE_CANTOPEN;
    } else {
      file = this.#scratch.get(path);
      if (!file) {
        if (!(flags & VFS.SQLITE_OPEN_CREATE)) return VFS.SQLITE_CANTOPEN;
        file = new ScratchFile();
        this.#scratch.set(path, file);
      }
    }
    this.#open.set(fileId, { path, file, flags });
    pOutFlags.setInt32(0, flags, true);
    return VFS.SQLITE_OK;
  }

  jClose(fileId) {
    const entry = this.#open.get(fileId);
    this.#open.delete(fileId);
    if (entry && entry.flags & VFS.SQLITE_OPEN_DELETEONCLOSE) this.#scratch.delete(entry.path);
    return VFS.SQLITE_OK;
  }

  jRead(fileId, pData, iOffset) {
    const { file } = this.#open.get(fileId);
    return file.read(pData, iOffset) ? VFS.SQLITE_OK : VFS.SQLITE_IOERR_SHORT_READ;
  }

  jWrite(fileId, pData, iOffset) {
    const { file } = this.#open.get(fileId);
    file.write(pData, iOffset);
    return VFS.SQLITE_OK;
  }

  jTruncate(fileId, iSize) {
    this.#open.get(fileId).file.truncate(iSize);
    return VFS.SQLITE_OK;
  }

  jSync() {
    return VFS.SQLITE_OK;
  }

  jFileSize(fileId, pSize64) {
    const { file } = this.#open.get(fileId);
    const size = file instanceof PageFile && file.batch ? file.batchSize : file.size;
    pSize64.setBigInt64(0, BigInt(size), true);
    return VFS.SQLITE_OK;
  }

  jFileControl(fileId, op, pArg) {
    const { file } = this.#open.get(fileId);
    if (file instanceof PageFile) {
      switch (op) {
        case VFS.SQLITE_FCNTL_BEGIN_ATOMIC_WRITE:
          file.beginBatch();
          return VFS.SQLITE_OK;
        case VFS.SQLITE_FCNTL_COMMIT_ATOMIC_WRITE:
          file.commitBatch();
          return VFS.SQLITE_OK;
        case VFS.SQLITE_FCNTL_ROLLBACK_ATOMIC_WRITE:
          file.rollbackBatch();
          return VFS.SQLITE_OK;
      }
    }
    return VFS.SQLITE_NOTFOUND;
  }

  jDeviceCharacteristics(fileId) {
    const { file } = this.#open.get(fileId);
    return file instanceof PageFile
      ? VFS.SQLITE_IOCAP_BATCH_ATOMIC | VFS.SQLITE_IOCAP_UNDELETABLE_WHEN_OPEN
      : 0;
  }

  jDelete(name) {
    this.#scratch.delete(normalize(name));
    return VFS.SQLITE_OK;
  }

  jAccess(name, flags, pResOut) {
    const path = normalize(name);
    const there = this.#databases.has(path) || this.#scratch.has(path);
    pResOut.setInt32(0, there ? 1 : 0, true);
    return VFS.SQLITE_OK;
  }
}

function normalize(name) {
  return new URL(name, 'file://').pathname;
}
