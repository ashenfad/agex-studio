import { resolve, dirname, joinPath, basename } from '../chunk-ARYRPIXS.js';

// src/fs/memory.ts
var MemoryFS = class {
  #cwd = "/";
  #files = /* @__PURE__ */ new Map();
  #fileMeta = /* @__PURE__ */ new Map();
  /** Dirs explicitly created via `mkdir`. The root `/` is always present. */
  #explicitDirs = /* @__PURE__ */ new Set(["/"]);
  #dirMeta = /* @__PURE__ */ new Map([
    ["/", { createdAt: (/* @__PURE__ */ new Date(0)).toISOString(), modifiedAt: (/* @__PURE__ */ new Date(0)).toISOString() }]
  ]);
  // ---------- cwd ----------
  getcwd() {
    return this.#cwd;
  }
  async chdir(path) {
    const abs = resolve(path, this.#cwd);
    if (!this.#dirExists(abs)) {
      throw new Error(`chdir: not a directory: ${path}`);
    }
    this.#cwd = abs;
  }
  // ---------- reads ----------
  async read(path) {
    const abs = resolve(path, this.#cwd);
    const v = this.#files.get(abs);
    if (v === void 0) {
      if (this.#dirExists(abs)) throw new Error(`read: is a directory: ${path}`);
      throw new Error(`read: no such file: ${path}`);
    }
    return new Uint8Array(v);
  }
  async exists(path) {
    const abs = resolve(path, this.#cwd);
    return this.#files.has(abs) || this.#dirExists(abs);
  }
  async isFile(path) {
    const abs = resolve(path, this.#cwd);
    return this.#files.has(abs);
  }
  async isDir(path) {
    const abs = resolve(path, this.#cwd);
    return this.#dirExists(abs);
  }
  async stat(path) {
    const abs = resolve(path, this.#cwd);
    if (this.#files.has(abs)) {
      const meta = this.#fileMeta.get(abs);
      return {
        size: this.#files.get(abs).byteLength,
        createdAt: meta.createdAt,
        modifiedAt: meta.modifiedAt,
        isDir: false
      };
    }
    if (this.#dirExists(abs)) {
      const meta = this.#dirMeta.get(abs) ?? syntheticDirMeta();
      return {
        size: 0,
        createdAt: meta.createdAt,
        modifiedAt: meta.modifiedAt,
        isDir: true
      };
    }
    throw new Error(`stat: no such file or directory: ${path}`);
  }
  // ---------- writes ----------
  async write(path, content, mode = "w") {
    const abs = resolve(path, this.#cwd);
    if (this.#dirExists(abs) && !this.#files.has(abs)) {
      throw new Error(`write: is a directory: ${path}`);
    }
    const parent = dirname(abs);
    if (!this.#dirExists(parent)) {
      throw new Error(`write: parent directory does not exist: ${parent}`);
    }
    let next;
    if (mode === "a" && this.#files.has(abs)) {
      const existing = this.#files.get(abs);
      next = new Uint8Array(existing.length + content.length);
      next.set(existing);
      next.set(content, existing.length);
    } else {
      next = new Uint8Array(content);
    }
    this.#files.set(abs, next);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const existingMeta = this.#fileMeta.get(abs);
    this.#fileMeta.set(abs, {
      createdAt: existingMeta?.createdAt ?? now,
      modifiedAt: now
    });
  }
  async mkdir(path, opts = {}) {
    const abs = resolve(path, this.#cwd);
    if (this.#files.has(abs)) {
      throw new Error(`mkdir: file exists at path: ${path}`);
    }
    if (this.#dirExists(abs)) {
      if (opts.existOk) return;
      throw new Error(`mkdir: directory exists: ${path}`);
    }
    if (opts.parents) {
      const segments = abs.split("/").filter((s) => s !== "");
      let prefix = "";
      for (const seg of segments) {
        prefix = `${prefix}/${seg}`;
        if (!this.#dirExists(prefix)) this.#addDir(prefix);
      }
    } else {
      const parent = dirname(abs);
      if (!this.#dirExists(parent)) {
        throw new Error(`mkdir: parent directory does not exist: ${parent}`);
      }
      this.#addDir(abs);
    }
  }
  async remove(path) {
    const abs = resolve(path, this.#cwd);
    if (!this.#files.has(abs)) {
      if (this.#dirExists(abs)) throw new Error(`remove: is a directory: ${path}`);
      throw new Error(`remove: no such file: ${path}`);
    }
    this.#files.delete(abs);
    this.#fileMeta.delete(abs);
  }
  async rmdir(path) {
    const abs = resolve(path, this.#cwd);
    if (abs === "/") throw new Error("rmdir: cannot remove root");
    if (this.#files.has(abs)) {
      throw new Error(`rmdir: not a directory: ${path}`);
    }
    if (!this.#dirExists(abs)) {
      throw new Error(`rmdir: no such directory: ${path}`);
    }
    if (this.#dirHasChildren(abs)) {
      throw new Error(`rmdir: directory not empty: ${path}`);
    }
    this.#explicitDirs.delete(abs);
    this.#dirMeta.delete(abs);
  }
  async rename(src, dst) {
    const absSrc = resolve(src, this.#cwd);
    const absDst = resolve(dst, this.#cwd);
    if (absSrc === absDst) return;
    if (this.#files.has(absSrc)) {
      const dstParent = dirname(absDst);
      if (!this.#dirExists(dstParent)) {
        throw new Error(`rename: parent directory does not exist: ${dstParent}`);
      }
      const value = this.#files.get(absSrc);
      const meta = this.#fileMeta.get(absSrc);
      this.#files.delete(absSrc);
      this.#fileMeta.delete(absSrc);
      this.#files.set(absDst, value);
      this.#fileMeta.set(absDst, meta);
      return;
    }
    if (this.#dirExists(absSrc)) {
      const srcPrefix = `${absSrc}/`;
      const moves = [];
      for (const k of this.#files.keys()) {
        if (k.startsWith(srcPrefix)) moves.push([k, `${absDst}/${k.slice(srcPrefix.length)}`]);
      }
      for (const [from, to] of moves) {
        const value = this.#files.get(from);
        const meta = this.#fileMeta.get(from);
        this.#files.delete(from);
        this.#fileMeta.delete(from);
        this.#files.set(to, value);
        this.#fileMeta.set(to, meta);
      }
      const dirMoves = [];
      for (const d of this.#explicitDirs) {
        if (d === absSrc) dirMoves.push([d, absDst]);
        else if (d.startsWith(srcPrefix))
          dirMoves.push([d, `${absDst}/${d.slice(srcPrefix.length)}`]);
      }
      for (const [from, to] of dirMoves) {
        const meta = this.#dirMeta.get(from);
        this.#explicitDirs.delete(from);
        this.#dirMeta.delete(from);
        this.#explicitDirs.add(to);
        if (meta !== void 0) this.#dirMeta.set(to, meta);
      }
      return;
    }
    throw new Error(`rename: no such file or directory: ${src}`);
  }
  // ---------- iteration ----------
  async list(path = ".", opts = {}) {
    const abs = resolve(path, this.#cwd);
    if (!this.#dirExists(abs)) {
      throw new Error(`list: no such directory: ${path}`);
    }
    const prefix = abs === "/" ? "/" : `${abs}/`;
    const direct = /* @__PURE__ */ new Set();
    const all = /* @__PURE__ */ new Set();
    for (const k of this.#files.keys()) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (opts.recursive) {
        all.add(rest);
      } else {
        const slash = rest.indexOf("/");
        direct.add(slash === -1 ? rest : rest.slice(0, slash));
      }
    }
    for (const d of this.#explicitDirs) {
      if (d === abs) continue;
      if (!d.startsWith(prefix)) continue;
      const rest = d.slice(prefix.length);
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
      const isDir = this.#dirExists(childAbs) && !this.#files.has(childAbs);
      if (isDir) {
        const meta = this.#dirMeta.get(childAbs) ?? syntheticDirMeta();
        out.push({
          name: basename(name),
          path: userPath,
          size: 0,
          createdAt: meta.createdAt,
          modifiedAt: meta.modifiedAt,
          isDir: true
        });
      } else {
        const value = this.#files.get(childAbs);
        const meta = this.#fileMeta.get(childAbs);
        if (value === void 0 || meta === void 0) continue;
        out.push({
          name: basename(name),
          path: userPath,
          size: value.byteLength,
          createdAt: meta.createdAt,
          modifiedAt: meta.modifiedAt,
          isDir: false
        });
      }
    }
    return out;
  }
  // ---------- internal helpers ----------
  #dirExists(abs) {
    if (this.#explicitDirs.has(abs)) return true;
    if (abs === "/") return true;
    const prefix = `${abs}/`;
    for (const k of this.#files.keys()) if (k.startsWith(prefix)) return true;
    for (const d of this.#explicitDirs) if (d.startsWith(prefix)) return true;
    return false;
  }
  #dirHasChildren(abs) {
    const prefix = abs === "/" ? "/" : `${abs}/`;
    for (const k of this.#files.keys()) if (k.startsWith(prefix)) return true;
    for (const d of this.#explicitDirs) {
      if (d !== abs && d.startsWith(prefix)) return true;
    }
    return false;
  }
  #addDir(abs) {
    this.#explicitDirs.add(abs);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    this.#dirMeta.set(abs, { createdAt: now, modifiedAt: now });
  }
};
function syntheticDirMeta() {
  const epoch = (/* @__PURE__ */ new Date(0)).toISOString();
  return { createdAt: epoch, modifiedAt: epoch };
}

export { MemoryFS };
//# sourceMappingURL=memory.js.map
//# sourceMappingURL=memory.js.map