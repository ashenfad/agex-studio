// src/backends/memory.ts
var Memory = class {
  #data = /* @__PURE__ */ new Map();
  async get(key) {
    const v = this.#data.get(key);
    return v === void 0 ? null : v;
  }
  async set(key, value) {
    this.#data.set(key, value);
  }
  async remove(key) {
    this.#data.delete(key);
  }
  async has(key) {
    return this.#data.has(key);
  }
  async getMany(keys) {
    const out = /* @__PURE__ */ new Map();
    for (const k of keys) {
      const v = this.#data.get(k);
      if (v !== void 0) out.set(k, v);
    }
    return out;
  }
  async setMany(items) {
    for (const [k, v] of items) {
      this.#data.set(k, v);
    }
  }
  async removeMany(keys) {
    for (const k of keys) {
      this.#data.delete(k);
    }
  }
  async cas(key, value, expected) {
    const current = this.#data.get(key) ?? null;
    if (!bytesEqual(current, expected)) return false;
    this.#data.set(key, value);
    return true;
  }
  async *keys(prefix) {
    if (prefix === void 0) {
      for (const k of this.#data.keys()) yield k;
    } else {
      for (const k of this.#data.keys()) {
        if (k.startsWith(prefix)) yield k;
      }
    }
  }
  async *items(prefix) {
    if (prefix === void 0) {
      for (const entry of this.#data.entries()) yield entry;
    } else {
      for (const entry of this.#data.entries()) {
        if (entry[0].startsWith(prefix)) yield entry;
      }
    }
  }
  async clear() {
    this.#data.clear();
  }
};
function bytesEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export { Memory };
//# sourceMappingURL=memory.js.map
//# sourceMappingURL=memory.js.map