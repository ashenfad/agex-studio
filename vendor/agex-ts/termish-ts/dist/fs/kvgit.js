import { resolve, dirname, joinPath, basename } from '../chunk-ARYRPIXS.js';
import superjson from 'superjson';

var TYPE_FILE = 70;
var TYPE_DIR = 68;
var TYPE_JSON = 74;
var ISO_LEN = 24;
var HEADER_LEN = 1 + ISO_LEN * 2;
var enc = new TextEncoder();
var dec = new TextDecoder();
function isFileRecord(v) {
  return typeof v === "object" && v !== null && "isDir" in v && "createdAt" in v && "modifiedAt" in v && "content" in v && v.content instanceof Uint8Array;
}
var fileRecordEncoder = (value) => {
  const rec = value;
  const out = new Uint8Array(HEADER_LEN + rec.content.byteLength);
  out[0] = rec.isDir ? TYPE_DIR : TYPE_FILE;
  const c = enc.encode(rec.createdAt.padEnd(ISO_LEN, " ").slice(0, ISO_LEN));
  const m = enc.encode(rec.modifiedAt.padEnd(ISO_LEN, " ").slice(0, ISO_LEN));
  out.set(c, 1);
  out.set(m, 1 + ISO_LEN);
  if (rec.content.byteLength > 0) out.set(rec.content, HEADER_LEN);
  return out;
};
var fileRecordDecoder = (bytes) => {
  if (bytes.byteLength < HEADER_LEN) {
    throw new Error("KvgitFS: record too short");
  }
  const isDir = bytes[0] === TYPE_DIR;
  const createdAt = dec.decode(bytes.subarray(1, 1 + ISO_LEN)).trim();
  const modifiedAt = dec.decode(bytes.subarray(1 + ISO_LEN, HEADER_LEN)).trim();
  const content = bytes.byteLength > HEADER_LEN ? bytes.subarray(HEADER_LEN) : new Uint8Array(0);
  return { isDir, createdAt, modifiedAt, content };
};
var polymorphicEncoder = (value) => {
  if (isFileRecord(value)) return fileRecordEncoder(value);
  const json = enc.encode(superjson.stringify(value));
  const out = new Uint8Array(1 + json.byteLength);
  out[0] = TYPE_JSON;
  out.set(json, 1);
  return out;
};
var polymorphicDecoder = (bytes) => {
  if (bytes.byteLength === 0) {
    throw new Error("polymorphicDecoder: empty record");
  }
  const tag = bytes[0];
  if (tag === TYPE_JSON) {
    return superjson.parse(dec.decode(bytes.subarray(1)));
  }
  if (tag === TYPE_FILE || tag === TYPE_DIR) {
    return fileRecordDecoder(bytes);
  }
  throw new Error(
    `polymorphicDecoder: unknown record tag 0x${(tag ?? 0).toString(16).padStart(2, "0")}`
  );
};
var KvgitFS = class {
  #staged;
  #cwd;
  constructor(staged, opts = {}) {
    this.#staged = staged;
    this.#cwd = opts.cwd ?? "/";
  }
  /** Expose the underlying `Staged` so callers can `commit()`,
   *  switch branches, etc. */
  get staged() {
    return this.#staged;
  }
  // ---------- cwd ----------
  getcwd() {
    return this.#cwd;
  }
  async chdir(path) {
    const abs = resolve(path, this.#cwd);
    if (!await this.#dirExists(abs)) {
      throw new Error(`chdir: not a directory: ${path}`);
    }
    this.#cwd = abs;
  }
  // ---------- reads ----------
  async read(path) {
    const abs = resolve(path, this.#cwd);
    const rec = await this.#getFile(abs);
    if (rec === void 0) {
      if (await this.#dirExists(abs)) throw new Error(`read: is a directory: ${path}`);
      throw new Error(`read: no such file: ${path}`);
    }
    return new Uint8Array(rec.content);
  }
  async exists(path) {
    const abs = resolve(path, this.#cwd);
    if (await this.#getFile(abs) !== void 0) return true;
    return this.#dirExists(abs);
  }
  async isFile(path) {
    const abs = resolve(path, this.#cwd);
    return await this.#getFile(abs) !== void 0;
  }
  async isDir(path) {
    const abs = resolve(path, this.#cwd);
    return this.#dirExists(abs);
  }
  async stat(path) {
    const abs = resolve(path, this.#cwd);
    const file = await this.#getFile(abs);
    if (file !== void 0) {
      return {
        size: file.content.byteLength,
        createdAt: file.createdAt,
        modifiedAt: file.modifiedAt,
        isDir: false
      };
    }
    if (await this.#dirExists(abs)) {
      const dirRec = await this.#getDir(abs);
      const meta = dirRec ?? syntheticMeta();
      return { size: 0, createdAt: meta.createdAt, modifiedAt: meta.modifiedAt, isDir: true };
    }
    throw new Error(`stat: no such file or directory: ${path}`);
  }
  // ---------- writes ----------
  async write(path, content, mode = "w") {
    const abs = resolve(path, this.#cwd);
    if (await this.#dirExists(abs) && await this.#getFile(abs) === void 0) {
      throw new Error(`write: is a directory: ${path}`);
    }
    if (!await this.#dirExists(dirname(abs))) {
      throw new Error(`write: parent directory does not exist: ${dirname(abs)}`);
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const existing = await this.#getFile(abs);
    let next;
    if (mode === "a" && existing !== void 0) {
      next = new Uint8Array(existing.content.byteLength + content.byteLength);
      next.set(existing.content);
      next.set(content, existing.content.byteLength);
    } else {
      next = new Uint8Array(content);
    }
    const rec = {
      isDir: false,
      createdAt: existing?.createdAt ?? now,
      modifiedAt: now,
      content: next
    };
    this.#staged.set(`f:${abs}`, rec);
  }
  async mkdir(path, opts = {}) {
    const abs = resolve(path, this.#cwd);
    if (await this.#getFile(abs) !== void 0) {
      throw new Error(`mkdir: file exists at path: ${path}`);
    }
    if (await this.#dirExists(abs)) {
      if (opts.existOk) return;
      throw new Error(`mkdir: directory exists: ${path}`);
    }
    if (opts.parents) {
      const segments = abs.split("/").filter((s) => s !== "");
      let prefix = "";
      for (const seg of segments) {
        prefix = `${prefix}/${seg}`;
        if (!await this.#dirExists(prefix)) this.#addDir(prefix);
      }
    } else {
      if (!await this.#dirExists(dirname(abs))) {
        throw new Error(`mkdir: parent directory does not exist: ${dirname(abs)}`);
      }
      this.#addDir(abs);
    }
  }
  async remove(path) {
    const abs = resolve(path, this.#cwd);
    if (await this.#getFile(abs) === void 0) {
      if (await this.#dirExists(abs)) throw new Error(`remove: is a directory: ${path}`);
      throw new Error(`remove: no such file: ${path}`);
    }
    this.#staged.delete(`f:${abs}`);
  }
  async rmdir(path) {
    const abs = resolve(path, this.#cwd);
    if (abs === "/") throw new Error("rmdir: cannot remove root");
    if (await this.#getFile(abs) !== void 0) {
      throw new Error(`rmdir: not a directory: ${path}`);
    }
    if (!await this.#dirExists(abs)) {
      throw new Error(`rmdir: no such directory: ${path}`);
    }
    if (await this.#dirHasChildren(abs)) {
      throw new Error(`rmdir: directory not empty: ${path}`);
    }
    this.#staged.delete(`d:${abs}`);
  }
  async rename(src, dst) {
    const absSrc = resolve(src, this.#cwd);
    const absDst = resolve(dst, this.#cwd);
    if (absSrc === absDst) return;
    const srcFile = await this.#getFile(absSrc);
    if (srcFile !== void 0) {
      if (!await this.#dirExists(dirname(absDst))) {
        throw new Error(`rename: parent directory does not exist: ${dirname(absDst)}`);
      }
      this.#staged.delete(`f:${absSrc}`);
      this.#staged.set(`f:${absDst}`, srcFile);
      return;
    }
    if (await this.#dirExists(absSrc)) {
      const srcPrefix = `${absSrc}/`;
      const fileKeys = [];
      const dirKeys = [];
      for await (const k of this.#staged.keys()) {
        if (k.startsWith("f:")) {
          if (k.slice(2).startsWith(srcPrefix)) fileKeys.push(k);
        } else if (k.startsWith("d:")) {
          const path = k.slice(2);
          if (path === absSrc || path.startsWith(srcPrefix)) dirKeys.push(k);
        }
      }
      const fileMoves = [];
      const dirMoves = [];
      for (const k of fileKeys) {
        const path = k.slice(2);
        const rec = await this.#staged.get(k);
        if (rec !== void 0) {
          fileMoves.push([`${absDst}/${path.slice(srcPrefix.length)}`, rec]);
          this.#staged.delete(k);
        }
      }
      for (const k of dirKeys) {
        const path = k.slice(2);
        const rec = await this.#staged.get(k);
        const dst2 = path === absSrc ? absDst : `${absDst}/${path.slice(srcPrefix.length)}`;
        dirMoves.push([dst2, rec ?? null]);
        this.#staged.delete(k);
      }
      for (const [dstPath, rec] of fileMoves) this.#staged.set(`f:${dstPath}`, rec);
      for (const [dstPath, rec] of dirMoves) {
        if (rec !== null) this.#staged.set(`d:${dstPath}`, rec);
      }
      return;
    }
    throw new Error(`rename: no such file or directory: ${src}`);
  }
  // ---------- iteration ----------
  async list(path = ".", opts = {}) {
    const abs = resolve(path, this.#cwd);
    if (!await this.#dirExists(abs)) {
      throw new Error(`list: no such directory: ${path}`);
    }
    const prefix = abs === "/" ? "/" : `${abs}/`;
    const direct = /* @__PURE__ */ new Set();
    const all = /* @__PURE__ */ new Set();
    for await (const k of this.#staged.keys()) {
      let path2;
      if (k.startsWith("f:")) path2 = k.slice(2);
      else if (k.startsWith("d:")) path2 = k.slice(2);
      else continue;
      if (path2 === abs) continue;
      if (!path2.startsWith(prefix)) continue;
      const rest = path2.slice(prefix.length);
      if (opts.recursive) {
        all.add(rest);
      } else {
        const slash = rest.indexOf("/");
        direct.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    const out = opts.recursive ? [...all] : [...direct];
    return out.sort();
  }
  async listDetailed(path = ".", opts = {}) {
    const names = await this.list(path, opts);
    const abs = resolve(path, this.#cwd);
    const userPrefix = path === "/" ? "/" : path.replace(/\/$/, "");
    const out = [];
    for (const name of names) {
      const childAbs = joinPath(abs, name);
      const userPath = joinPath(userPrefix, name);
      const file = await this.#getFile(childAbs);
      if (file !== void 0) {
        out.push({
          name: basename(name),
          path: userPath,
          size: file.content.byteLength,
          createdAt: file.createdAt,
          modifiedAt: file.modifiedAt,
          isDir: false
        });
      } else if (await this.#dirExists(childAbs)) {
        const dirRec = await this.#getDir(childAbs) ?? syntheticMeta();
        out.push({
          name: basename(name),
          path: userPath,
          size: 0,
          createdAt: dirRec.createdAt,
          modifiedAt: dirRec.modifiedAt,
          isDir: true
        });
      }
    }
    return out;
  }
  // ---------- internal ----------
  async #getFile(abs) {
    const rec = await this.#staged.get(`f:${abs}`);
    return rec;
  }
  async #getDir(abs) {
    if (abs === "/") return void 0;
    return this.#staged.get(`d:${abs}`);
  }
  async #dirExists(abs) {
    if (abs === "/") return true;
    if (await this.#getDir(abs) !== void 0) return true;
    const prefix = `${abs}/`;
    for await (const k of this.#staged.keys()) {
      if (k.startsWith("f:") || k.startsWith("d:")) {
        if (k.slice(2).startsWith(prefix)) return true;
      }
    }
    return false;
  }
  async #dirHasChildren(abs) {
    const prefix = abs === "/" ? "/" : `${abs}/`;
    for await (const k of this.#staged.keys()) {
      if (k.startsWith("f:") || k.startsWith("d:")) {
        const path = k.slice(2);
        if (path !== abs && path.startsWith(prefix)) return true;
      }
    }
    return false;
  }
  #addDir(abs) {
    if (abs === "/") return;
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const rec = {
      isDir: true,
      createdAt: now,
      modifiedAt: now,
      content: new Uint8Array(0)
    };
    this.#staged.set(`d:${abs}`, rec);
  }
};
function syntheticMeta() {
  const epoch = (/* @__PURE__ */ new Date(0)).toISOString();
  return { createdAt: epoch, modifiedAt: epoch };
}

export { KvgitFS, fileRecordDecoder, fileRecordEncoder, polymorphicDecoder, polymorphicEncoder };
//# sourceMappingURL=kvgit.js.map
//# sourceMappingURL=kvgit.js.map