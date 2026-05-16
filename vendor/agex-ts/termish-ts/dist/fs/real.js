import { resolve, dirname, joinPath } from '../chunk-ARYRPIXS.js';
import { promises } from 'fs';
import * as nodePath from 'path/posix';

var RealFS = class {
  #root;
  #cwd;
  constructor(opts) {
    if (!nodePath.isAbsolute(opts.root)) {
      throw new Error(`RealFS: root must be absolute, got: ${opts.root}`);
    }
    this.#root = nodePath.normalize(opts.root).replace(/\/+$/, "") || "/";
    this.#cwd = opts.cwd ?? "/";
  }
  // ---------- cwd ----------
  getcwd() {
    return this.#cwd;
  }
  async chdir(path) {
    const abs = resolve(path, this.#cwd);
    const real = this.#toReal(abs);
    let stat;
    try {
      stat = await promises.stat(real);
    } catch {
      throw new Error(`chdir: not a directory: ${path}`);
    }
    if (!stat.isDirectory()) throw new Error(`chdir: not a directory: ${path}`);
    this.#cwd = abs;
  }
  // ---------- reads ----------
  async read(path) {
    const real = this.#toReal(resolve(path, this.#cwd));
    let stat;
    try {
      stat = await promises.stat(real);
    } catch {
      throw new Error(`read: no such file: ${path}`);
    }
    if (stat.isDirectory()) throw new Error(`read: is a directory: ${path}`);
    const buf = await promises.readFile(real);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  async exists(path) {
    const real = this.#toReal(resolve(path, this.#cwd));
    try {
      await promises.stat(real);
      return true;
    } catch {
      return false;
    }
  }
  async isFile(path) {
    const real = this.#toReal(resolve(path, this.#cwd));
    try {
      const s = await promises.stat(real);
      return s.isFile();
    } catch {
      return false;
    }
  }
  async isDir(path) {
    const real = this.#toReal(resolve(path, this.#cwd));
    try {
      const s = await promises.stat(real);
      return s.isDirectory();
    } catch {
      return false;
    }
  }
  async stat(path) {
    const real = this.#toReal(resolve(path, this.#cwd));
    let s;
    try {
      s = await promises.stat(real);
    } catch {
      throw new Error(`stat: no such file or directory: ${path}`);
    }
    return {
      size: s.isDirectory() ? 0 : s.size,
      createdAt: new Date(s.birthtimeMs || s.ctimeMs).toISOString(),
      modifiedAt: new Date(s.mtimeMs).toISOString(),
      isDir: s.isDirectory()
    };
  }
  // ---------- writes ----------
  async write(path, content, mode = "w") {
    const abs = resolve(path, this.#cwd);
    const real = this.#toReal(abs);
    const parentReal = this.#toReal(dirname(abs));
    try {
      const s = await promises.stat(parentReal);
      if (!s.isDirectory()) {
        throw new Error(`write: parent directory does not exist: ${dirname(abs)}`);
      }
    } catch {
      throw new Error(`write: parent directory does not exist: ${dirname(abs)}`);
    }
    try {
      const s = await promises.stat(real);
      if (s.isDirectory()) throw new Error(`write: is a directory: ${path}`);
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("write:")) throw e;
    }
    await promises.writeFile(real, content, { flag: mode === "a" ? "a" : "w" });
  }
  async mkdir(path, opts = {}) {
    const abs = resolve(path, this.#cwd);
    const real = this.#toReal(abs);
    try {
      const s = await promises.stat(real);
      if (s.isFile()) throw new Error(`mkdir: file exists at path: ${path}`);
      if (s.isDirectory()) {
        if (opts.existOk) return;
        throw new Error(`mkdir: directory exists: ${path}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("mkdir:")) throw e;
    }
    if (!opts.parents) {
      const parentReal = this.#toReal(dirname(abs));
      try {
        const s = await promises.stat(parentReal);
        if (!s.isDirectory()) {
          throw new Error(`mkdir: parent directory does not exist: ${dirname(abs)}`);
        }
      } catch {
        throw new Error(`mkdir: parent directory does not exist: ${dirname(abs)}`);
      }
    }
    await promises.mkdir(real, { recursive: opts.parents === true });
  }
  async remove(path) {
    const real = this.#toReal(resolve(path, this.#cwd));
    let s;
    try {
      s = await promises.stat(real);
    } catch {
      throw new Error(`remove: no such file: ${path}`);
    }
    if (s.isDirectory()) throw new Error(`remove: is a directory: ${path}`);
    await promises.unlink(real);
  }
  async rmdir(path) {
    const abs = resolve(path, this.#cwd);
    if (abs === "/") throw new Error("rmdir: cannot remove root");
    const real = this.#toReal(abs);
    let s;
    try {
      s = await promises.stat(real);
    } catch {
      throw new Error(`rmdir: no such directory: ${path}`);
    }
    if (!s.isDirectory()) throw new Error(`rmdir: not a directory: ${path}`);
    const entries = await promises.readdir(real);
    if (entries.length > 0) throw new Error(`rmdir: directory not empty: ${path}`);
    await promises.rmdir(real);
  }
  async rename(src, dst) {
    const realSrc = this.#toReal(resolve(src, this.#cwd));
    const realDst = this.#toReal(resolve(dst, this.#cwd));
    if (realSrc === realDst) return;
    try {
      await promises.stat(realSrc);
    } catch {
      throw new Error(`rename: no such file or directory: ${src}`);
    }
    const dstParent = dirname(resolve(dst, this.#cwd));
    try {
      const s = await promises.stat(this.#toReal(dstParent));
      if (!s.isDirectory()) {
        throw new Error(`rename: parent directory does not exist: ${dstParent}`);
      }
    } catch (e) {
      if (e instanceof Error && e.message.startsWith("rename:")) throw e;
      throw new Error(`rename: parent directory does not exist: ${dstParent}`);
    }
    await promises.rename(realSrc, realDst);
  }
  // ---------- iteration ----------
  async list(path = ".", opts = {}) {
    const abs = resolve(path, this.#cwd);
    const real = this.#toReal(abs);
    let stat;
    try {
      stat = await promises.stat(real);
    } catch {
      throw new Error(`list: no such directory: ${path}`);
    }
    if (!stat.isDirectory()) throw new Error(`list: not a directory: ${path}`);
    const out = [];
    if (opts.recursive) {
      await walk(real, "", out);
    } else {
      const entries = await promises.readdir(real);
      for (const e of entries) out.push(e);
    }
    return out.sort();
  }
  async listDetailed(path = ".", opts = {}) {
    const names = await this.list(path, opts);
    const userPrefix = path === "/" ? "/" : path.replace(/\/$/, "");
    const baseReal = this.#toReal(resolve(path, this.#cwd));
    const out = [];
    for (const name of names) {
      const childReal = nodePath.join(baseReal, name);
      let s;
      try {
        s = await promises.stat(childReal);
      } catch {
        continue;
      }
      const last = name.includes("/") ? name.slice(name.lastIndexOf("/") + 1) : name;
      out.push({
        name: last,
        path: joinPath(userPrefix, name),
        size: s.isDirectory() ? 0 : s.size,
        createdAt: new Date(s.birthtimeMs || s.ctimeMs).toISOString(),
        modifiedAt: new Date(s.mtimeMs).toISOString(),
        isDir: s.isDirectory()
      });
    }
    return out;
  }
  // ---------- internal ----------
  /** Map a virtual absolute path to a real host path under `root`.
   *  Throws if the path would escape the root. */
  #toReal(virtualAbs) {
    if (!virtualAbs.startsWith("/")) {
      throw new Error(`RealFS: expected absolute path, got: ${virtualAbs}`);
    }
    const real = nodePath.join(this.#root, virtualAbs);
    if (real !== this.#root && !real.startsWith(`${this.#root}/`)) {
      throw new Error(`RealFS: path escape detected: ${virtualAbs}`);
    }
    return real;
  }
};
async function walk(real, relPrefix, out) {
  const entries = await promises.readdir(real, { withFileTypes: true });
  for (const e of entries) {
    const childReal = nodePath.join(real, e.name);
    const childRel = relPrefix === "" ? e.name : `${relPrefix}/${e.name}`;
    out.push(childRel);
    if (e.isDirectory()) await walk(childReal, childRel, out);
  }
}

export { RealFS };
//# sourceMappingURL=real.js.map
//# sourceMappingURL=real.js.map