// src/backends/sqlite.browser.ts
var Sqlite = class {
  constructor() {
    throw new Error("kvgit-ts: the sqlite backend is Node-only and not available in browsers");
  }
  static async open(_opts = {}) {
    throw new Error("kvgit-ts: the sqlite backend is Node-only and not available in browsers");
  }
  // Method stubs — never reached because the constructor / factory throw
  // first. They exist so TypeScript sees `Sqlite implements KVStore`.
  get(_key) {
    throw new Error("unreachable");
  }
  set(_key, _value) {
    throw new Error("unreachable");
  }
  remove(_key) {
    throw new Error("unreachable");
  }
  has(_key) {
    throw new Error("unreachable");
  }
  getMany(_keys) {
    throw new Error("unreachable");
  }
  setMany(_items) {
    throw new Error("unreachable");
  }
  removeMany(_keys) {
    throw new Error("unreachable");
  }
  cas(_key, _value, _expected) {
    throw new Error("unreachable");
  }
  keys(_prefix) {
    throw new Error("unreachable");
  }
  items(_prefix) {
    throw new Error("unreachable");
  }
  clear() {
    throw new Error("unreachable");
  }
};

export { Sqlite };
//# sourceMappingURL=sqlite.browser.js.map
//# sourceMappingURL=sqlite.browser.js.map