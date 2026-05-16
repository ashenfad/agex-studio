// src/types.ts
var ConcurrencyError = class extends Error {
  name = "ConcurrencyError";
};
var MergeConflict = class extends Error {
  name = "MergeConflict";
  keys;
  causes;
  constructor(keys, causes) {
    const keySet = new Set(keys);
    super(`Merge conflict on ${keySet.size} key(s): ${[...keySet].sort().join(", ")}`);
    this.keys = keySet;
    this.causes = causes ?? /* @__PURE__ */ new Map();
  }
};

// src/hamt.ts
var HASH_LEN = 64;
var EMPTY_LEAF = { items: {}, kind: "leaf" };
var _emptyHashPromise = null;
function emptyHash() {
  if (_emptyHashPromise === null) {
    _emptyHashPromise = sha256Hex(nodeBytes(EMPTY_LEAF));
  }
  return _emptyHashPromise;
}
var _encoder = new TextEncoder();
var _decoder = new TextDecoder();
function nodeBytes(node) {
  return _encoder.encode(canonicalJson(node));
}
function parseNode(bytes) {
  return JSON.parse(_decoder.decode(bytes));
}
function canonicalJson(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const obj = value;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${parts.join(",")}}`;
}
async function sha256Hex(data) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}
function keyHash(key) {
  return sha256Hex(_encoder.encode(key));
}
function encodeValue(value) {
  let binary = "";
  const chunkSize = 32768;
  for (let i = 0; i < value.length; i += chunkSize) {
    const slice = value.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}
function decodeValue(s) {
  const binary = atob(s);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}
var Hamt = class _Hamt {
  store;
  root;
  prefix;
  bucketMax;
  pending;
  constructor(store, root, opts = {}) {
    const bucketMax = opts.bucketMax ?? 8;
    if (bucketMax < 1) {
      throw new RangeError(`bucketMax must be >= 1, got ${bucketMax}`);
    }
    this.store = store;
    this.root = root;
    this.prefix = opts.prefix ?? "hamt:";
    this.bucketMax = bucketMax;
    this.pending = opts.pending ?? /* @__PURE__ */ new Map();
  }
  /** Construct a fresh, empty HAMT. */
  static async empty(store, opts = {}) {
    return new _Hamt(store, await emptyHash(), opts);
  }
  /** The hash of the canonical empty leaf. Useful for tests. */
  static emptyHash() {
    return emptyHash();
  }
  // ---------- Internal load / store ----------
  /**
   * Load a node by hash. Checks the supplied transient pending dict
   * first (used during in-progress batch updates), then `this.pending`,
   * then the store. Returns null if not found.
   */
  async load(nodeHash, pending) {
    if (nodeHash === await emptyHash()) return EMPTY_LEAF;
    const prefixed = this.prefix + nodeHash;
    const fromPending = pending?.get(prefixed) ?? this.pending.get(prefixed);
    if (fromPending !== void 0) return parseNode(fromPending);
    const raw = await this.store.get(prefixed);
    if (raw === null) return null;
    return parseNode(raw);
  }
  async storeLeaf(items, pending) {
    const node = { items, kind: "leaf" };
    const bytes = nodeBytes(node);
    const hash = await sha256Hex(bytes);
    pending.set(this.prefix + hash, bytes);
    return hash;
  }
  async storeBranch(children, pending) {
    const node = { children, kind: "branch" };
    const bytes = nodeBytes(node);
    const hash = await sha256Hex(bytes);
    pending.set(this.prefix + hash, bytes);
    return hash;
  }
  // ---------- Reads ----------
  /** Look up a key. Returns null if absent. */
  async get(key) {
    const empty = await emptyHash();
    if (this.root === empty) return null;
    const kh = await keyHash(key);
    let nodeHash = this.root;
    let depth = 0;
    while (true) {
      const node = await this.load(nodeHash);
      if (node === null) return null;
      if (node.kind === "leaf") {
        const encoded = node.items[key];
        return encoded === void 0 ? null : decodeValue(encoded);
      }
      const chunk = kh[depth];
      const nextHash = node.children[chunk];
      if (nextHash === void 0) return null;
      nodeHash = nextHash;
      depth++;
    }
  }
  async has(key) {
    return await this.get(key) !== null;
  }
  /**
   * Iterate over all `(key, value)` pairs lazily. One store read per
   * visited node. Use `materialize()` if you want the whole map and the
   * underlying store has non-trivial per-call latency.
   */
  async *items() {
    const empty = await emptyHash();
    if (this.root === empty) return;
    yield* this.itemsFrom(this.root);
  }
  async *itemsFrom(nodeHash) {
    const node = await this.load(nodeHash);
    if (node === null) return;
    if (node.kind === "leaf") {
      for (const [k, v] of Object.entries(node.items)) {
        yield [k, decodeValue(v)];
      }
    } else {
      for (const childHash of Object.values(node.children)) {
        yield* this.itemsFrom(childHash);
      }
    }
  }
  async *keys() {
    for await (const [k] of this.items()) yield k;
  }
  async *values() {
    for await (const [, v] of this.items()) yield v;
  }
  /** Walk the entire HAMT and return its contents as a Map. */
  async materialize() {
    const [items] = await this.walk();
    return items;
  }
  /**
   * Walk the entire HAMT, returning `[items, nodeHashes]`.
   *
   * Single batched BFS that collects both the key→value entries and
   * the set of every visited node hash. Used by GC mark phases that
   * want both, like `cleanOrphans`.
   *
   * `skipNodes` is an optional set of node hashes to treat as
   * already-visited. Skipped subtrees are not fetched, not recursed
   * into, and not included in the returned `nodes` set. Items beneath
   * skipped subtrees are also omitted. Pass a cumulative seen-set
   * across multiple `walk()` calls (e.g. across the commits of a
   * branch's history) to share work where the underlying HAMTs share
   * structure.
   */
  async walk(skipNodes) {
    const empty = await emptyHash();
    const items = /* @__PURE__ */ new Map();
    const nodes = /* @__PURE__ */ new Set();
    if (this.root === empty || skipNodes?.has(this.root)) return [items, nodes];
    let currentLevel = [this.root];
    while (currentLevel.length > 0) {
      const cachedNodes = /* @__PURE__ */ new Map();
      const toFetch = [];
      for (const h of currentLevel) {
        if (h === empty || skipNodes?.has(h)) continue;
        const prefixed = this.prefix + h;
        const fromPending = this.pending.get(prefixed);
        if (fromPending !== void 0) {
          cachedNodes.set(h, parseNode(fromPending));
        } else {
          toFetch.push(prefixed);
        }
      }
      const fetched = toFetch.length > 0 ? await this.store.getMany(toFetch) : /* @__PURE__ */ new Map();
      const nextLevel = [];
      for (const h of currentLevel) {
        if (h === empty || skipNodes?.has(h)) continue;
        const cached = cachedNodes.get(h);
        let node;
        if (cached !== void 0) {
          node = cached;
        } else {
          const raw = fetched.get(this.prefix + h);
          if (raw === void 0) continue;
          node = parseNode(raw);
        }
        nodes.add(h);
        if (node.kind === "leaf") {
          for (const [k, v] of Object.entries(node.items)) {
            items.set(k, decodeValue(v));
          }
        } else {
          nextLevel.push(...Object.values(node.children));
        }
      }
      currentLevel = nextLevel;
    }
    return [items, nodes];
  }
  /** Total entry count. O(N) — walks the tree. */
  async size() {
    let n = 0;
    for await (const _ of this.items()) n++;
    return n;
  }
  // ---------- Writes ----------
  /**
   * Apply updates and removals. Returns a new `Hamt` whose `pending`
   * map contains any new node bytes not yet flushed.
   */
  async updated(opts = {}) {
    const pending = new Map(this.pending);
    let currentRoot = this.root;
    for (const [key, value] of opts.updates ?? []) {
      currentRoot = await this.insert(currentRoot, key, value, pending);
    }
    for (const key of opts.removals ?? []) {
      currentRoot = await this.delete(currentRoot, key, pending);
    }
    const reachablePending = await this.filterPending(currentRoot, pending);
    return new _Hamt(this.store, currentRoot, {
      prefix: this.prefix,
      bucketMax: this.bucketMax,
      pending: reachablePending
    });
  }
  /**
   * Apply updates and write any new nodes to the store immediately.
   * Returns a fresh `Hamt` with empty pending.
   */
  async persist(opts = {}) {
    const next = await this.updated(opts);
    if (next.pending.size > 0) {
      await this.store.setMany(next.pending);
    }
    return new _Hamt(this.store, next.root, {
      prefix: this.prefix,
      bucketMax: this.bucketMax
    });
  }
  /** Persist any pending node writes. Returns a fresh `Hamt`. */
  async flush() {
    if (this.pending.size > 0) {
      await this.store.setMany(this.pending);
    }
    return new _Hamt(this.store, this.root, {
      prefix: this.prefix,
      bucketMax: this.bucketMax
    });
  }
  // ---------- Insert ----------
  async insert(rootHash, key, value, pending) {
    const empty = await emptyHash();
    if (rootHash === empty) {
      return this.storeLeaf({ [key]: encodeValue(value) }, pending);
    }
    const kh = await keyHash(key);
    return this.insertAt(rootHash, 0, kh, key, value, pending);
  }
  async insertAt(nodeHash, depth, kh, key, value, pending) {
    const node = await this.load(nodeHash, pending);
    if (node === null) {
      return this.storeLeaf({ [key]: encodeValue(value) }, pending);
    }
    if (node.kind === "leaf") {
      const encoded = encodeValue(value);
      const existing = node.items[key];
      if (existing === encoded) return nodeHash;
      const newItems = { ...node.items, [key]: encoded };
      if (Object.keys(newItems).length <= this.bucketMax) {
        return this.storeLeaf(newItems, pending);
      }
      return this.splitLeaf(newItems, depth, pending);
    }
    const chunk = kh[depth];
    const existingChildren = node.children;
    const existingChildHash = existingChildren[chunk];
    if (existingChildHash !== void 0) {
      const newChildHash = await this.insertAt(
        existingChildHash,
        depth + 1,
        kh,
        key,
        value,
        pending
      );
      if (newChildHash === existingChildHash) return nodeHash;
      const newChildren2 = { ...existingChildren, [chunk]: newChildHash };
      return this.storeBranch(newChildren2, pending);
    }
    const newLeafHash = await this.storeLeaf({ [key]: encodeValue(value) }, pending);
    const newChildren = { ...existingChildren, [chunk]: newLeafHash };
    return this.storeBranch(newChildren, pending);
  }
  /** Convert an overflowing leaf at `depth` into a branch. */
  async splitLeaf(encodedItems, depth, pending) {
    if (depth >= HASH_LEN) {
      return this.storeLeaf(encodedItems, pending);
    }
    const groups = /* @__PURE__ */ new Map();
    for (const [k, v] of Object.entries(encodedItems)) {
      const nibble = (await keyHash(k))[depth];
      let group = groups.get(nibble);
      if (group === void 0) {
        group = {};
        groups.set(nibble, group);
      }
      group[k] = v;
    }
    if (groups.size === 1) {
      const [nibble, groupItems] = groups.entries().next().value;
      const childHash = await this.splitLeaf(groupItems, depth + 1, pending);
      return this.storeBranch({ [nibble]: childHash }, pending);
    }
    const children = {};
    for (const [nibble, groupItems] of groups) {
      if (Object.keys(groupItems).length <= this.bucketMax) {
        children[nibble] = await this.storeLeaf(groupItems, pending);
      } else {
        children[nibble] = await this.splitLeaf(groupItems, depth + 1, pending);
      }
    }
    return this.storeBranch(children, pending);
  }
  // ---------- Delete ----------
  async delete(rootHash, key, pending) {
    const empty = await emptyHash();
    if (rootHash === empty) return empty;
    const kh = await keyHash(key);
    const result = await this.deleteAt(rootHash, 0, kh, key, pending);
    return result === null ? empty : result;
  }
  /** Returns the new node hash, or null if the subtree is now empty. */
  async deleteAt(nodeHash, depth, kh, key, pending) {
    const node = await this.load(nodeHash, pending);
    if (node === null) return nodeHash;
    if (node.kind === "leaf") {
      if (!(key in node.items)) return nodeHash;
      const newItems = {};
      for (const [k, v] of Object.entries(node.items)) {
        if (k !== key) newItems[k] = v;
      }
      if (Object.keys(newItems).length === 0) return null;
      return this.storeLeaf(newItems, pending);
    }
    const chunk = kh[depth];
    const existingChildren = node.children;
    const existingChildHash = existingChildren[chunk];
    if (existingChildHash === void 0) return nodeHash;
    const newChildHash = await this.deleteAt(existingChildHash, depth + 1, kh, key, pending);
    if (newChildHash === existingChildHash) return nodeHash;
    const newChildren = { ...existingChildren };
    if (newChildHash === null) {
      delete newChildren[chunk];
    } else {
      newChildren[chunk] = newChildHash;
    }
    if (Object.keys(newChildren).length === 0) return null;
    const collapsed = await this.tryCollapse(newChildren, pending);
    if (collapsed !== null) return collapsed;
    return this.storeBranch(newChildren, pending);
  }
  /**
   * If every child is a leaf and the union of their entries fits in
   * `bucketMax`, return the merged leaf hash. Otherwise null.
   */
  async tryCollapse(children, pending) {
    const merged = {};
    let count = 0;
    for (const childHash of Object.values(children)) {
      const child = await this.load(childHash, pending);
      if (child === null || child.kind !== "leaf") return null;
      for (const [k, v] of Object.entries(child.items)) {
        if (!(k in merged)) {
          merged[k] = v;
          count++;
        }
        if (count > this.bucketMax) return null;
      }
    }
    return this.storeLeaf(merged, pending);
  }
  // ---------- Pending management ----------
  /**
   * Walk from `root`, returning only pending entries actually reachable.
   * Drops orphans created by superseded inserts.
   */
  async filterPending(root, pending) {
    const empty = await emptyHash();
    const result = /* @__PURE__ */ new Map();
    if (root === empty) return result;
    const queue = [root];
    while (queue.length > 0) {
      const h = queue.pop();
      const prefixed = this.prefix + h;
      if (result.has(prefixed) || !pending.has(prefixed)) continue;
      const bytes = pending.get(prefixed);
      result.set(prefixed, bytes);
      const node = parseNode(bytes);
      if (node.kind === "branch") {
        queue.push(...Object.values(node.children));
      }
    }
    return result;
  }
  // ---------- Structural ops ----------
  /**
   * Yield every node hash reachable from this root. Used by GC layers
   * to mark live nodes. Includes pending nodes — works on a Hamt that
   * hasn't been flushed.
   */
  async *reachableNodes() {
    const empty = await emptyHash();
    if (this.root === empty) return;
    const seen = /* @__PURE__ */ new Set();
    const queue = [this.root];
    while (queue.length > 0) {
      const h = queue.pop();
      if (seen.has(h)) continue;
      seen.add(h);
      yield h;
      const node = await this.load(h);
      if (node === null) continue;
      if (node.kind === "branch") {
        queue.push(...Object.values(node.children));
      }
    }
  }
  /**
   * Structural diff against `other`. Cost is O(changes + log N), not
   * O(N), because identical subtrees (same hash) are skipped wholesale.
   * The primary payoff of structural sharing.
   */
  async diff(other) {
    const added = /* @__PURE__ */ new Map();
    const removed = /* @__PURE__ */ new Map();
    const modified = /* @__PURE__ */ new Map();
    await this.diffWalk(this.root, other.root, other, added, removed, modified);
    return { added, removed, modified };
  }
  async diffWalk(aHash, bHash, other, added, removed, modified) {
    if (aHash === bHash) return;
    const empty = await emptyHash();
    if (aHash === empty) {
      for await (const [k, v] of other.itemsFrom(bHash)) added.set(k, v);
      return;
    }
    if (bHash === empty) {
      for await (const [k, v] of this.itemsFrom(aHash)) removed.set(k, v);
      return;
    }
    const aNode = await this.load(aHash);
    const bNode = await other.load(bHash);
    if (aNode === null || bNode === null) {
      if (aNode !== null) {
        for await (const [k, v] of this.itemsFrom(aHash)) removed.set(k, v);
      }
      if (bNode !== null) {
        for await (const [k, v] of other.itemsFrom(bHash)) added.set(k, v);
      }
      return;
    }
    if (aNode.kind === "leaf" && bNode.kind === "leaf") {
      const aItems2 = aNode.items;
      const bItems2 = bNode.items;
      for (const [k, v] of Object.entries(aItems2)) {
        if (!(k in bItems2)) {
          removed.set(k, decodeValue(v));
        } else if (bItems2[k] !== v) {
          modified.set(k, [decodeValue(v), decodeValue(bItems2[k])]);
        }
      }
      for (const [k, v] of Object.entries(bItems2)) {
        if (!(k in aItems2)) added.set(k, decodeValue(v));
      }
      return;
    }
    if (aNode.kind === "branch" && bNode.kind === "branch") {
      const chunks = /* @__PURE__ */ new Set([...Object.keys(aNode.children), ...Object.keys(bNode.children)]);
      for (const chunk of chunks) {
        const aChild = aNode.children[chunk] ?? empty;
        const bChild = bNode.children[chunk] ?? empty;
        await this.diffWalk(aChild, bChild, other, added, removed, modified);
      }
      return;
    }
    const aItems = /* @__PURE__ */ new Map();
    const bItems = /* @__PURE__ */ new Map();
    for await (const [k, v] of this.itemsFrom(aHash)) aItems.set(k, v);
    for await (const [k, v] of other.itemsFrom(bHash)) bItems.set(k, v);
    for (const [k, v] of aItems) {
      const bv = bItems.get(k);
      if (bv === void 0) {
        removed.set(k, v);
      } else if (!bytesEqual(v, bv)) {
        modified.set(k, [v, bv]);
      }
    }
    for (const [k, v] of bItems) {
      if (!aItems.has(k)) added.set(k, v);
    }
  }
};
function bytesEqual(a, b) {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// src/keyset.ts
var _encoder2 = new TextEncoder();
var _decoder2 = new TextDecoder();
function encodeEntry(entry) {
  const meta = { createdAt: entry.meta.createdAt, size: entry.meta.size };
  const payload = [entry.blob, meta];
  return _encoder2.encode(JSON.stringify(payload));
}
function decodeEntry(raw) {
  const parsed = JSON.parse(_decoder2.decode(raw));
  const [blob, meta] = parsed;
  return {
    blob,
    meta: {
      createdAt: meta.createdAt,
      size: meta.size
    }
  };
}
var Keyset = class _Keyset {
  /** Default storage-key prefix for HAMT nodes belonging to a Keyset.
   *  Used by the GC layer to identify keyset nodes via prefix scan. */
  static DEFAULT_PREFIX = "kvgit:keyset:";
  #hamt;
  constructor(hamt) {
    this.#hamt = hamt;
  }
  /** Construct a fresh, empty Keyset. */
  static async empty(store, opts = {}) {
    return new _Keyset(await Hamt.empty(store, hamtOpts(opts)));
  }
  /** Construct a Keyset from a known root hash. */
  static fromRoot(store, root, opts = {}) {
    return new _Keyset(new Hamt(store, root, hamtOpts(opts)));
  }
  // ---------- Properties ----------
  get store() {
    return this.#hamt.store;
  }
  get root() {
    return this.#hamt.root;
  }
  get prefix() {
    return this.#hamt.prefix;
  }
  get bucketMax() {
    return this.#hamt.bucketMax;
  }
  get pending() {
    return this.#hamt.pending;
  }
  // ---------- Reads ----------
  async get(key) {
    const raw = await this.#hamt.get(key);
    return raw === null ? null : decodeEntry(raw);
  }
  /** Shortcut: just the blob pointer, skipping a meta decode. */
  async getBlob(key) {
    const entry = await this.get(key);
    return entry === null ? null : entry.blob;
  }
  async has(key) {
    return this.#hamt.has(key);
  }
  /**
   * Iterate over all `(key, entry)` pairs lazily. One store read per
   * visited HAMT node. See `materialize()` for a batched alternative.
   */
  async *items() {
    for await (const [k, v] of this.#hamt.items()) {
      yield [k, decodeEntry(v)];
    }
  }
  /** Walk the entire keyset using batched store reads. */
  async materialize() {
    const raw = await this.#hamt.materialize();
    const out = /* @__PURE__ */ new Map();
    for (const [k, v] of raw) out.set(k, decodeEntry(v));
    return out;
  }
  /**
   * Single batched walk returning `[entries, hamtNodeHashes]`.
   *
   * Equivalent to `materialize()` plus collecting every visited HAMT
   * node hash, in one tree traversal. Used by GC mark phases. See
   * `Hamt.walk` for `skipNodes` cumulative seen-set semantics.
   */
  async walk(skipNodes) {
    const [raw, nodes] = await this.#hamt.walk(skipNodes);
    const entries = /* @__PURE__ */ new Map();
    for (const [k, v] of raw) entries.set(k, decodeEntry(v));
    return [entries, nodes];
  }
  async *keys() {
    yield* this.#hamt.keys();
  }
  async *values() {
    for await (const [, entry] of this.items()) yield entry;
  }
  /** Total entry count. O(N) — walks the tree. */
  async size() {
    return this.#hamt.size();
  }
  // ---------- Writes ----------
  async updated(opts = {}) {
    const encodedUpdates = [];
    if (opts.updates) {
      for (const [k, entry] of opts.updates) {
        encodedUpdates.push([k, encodeEntry(entry)]);
      }
    }
    const newHamt = await this.#hamt.updated({
      updates: encodedUpdates,
      ...opts.removals !== void 0 && { removals: opts.removals }
    });
    return new _Keyset(newHamt);
  }
  async persist(opts = {}) {
    const next = await this.updated(opts);
    return new _Keyset(await next.#hamt.flush());
  }
  async flush() {
    return new _Keyset(await this.#hamt.flush());
  }
  // ---------- Structural ops ----------
  /** Yield every HAMT node hash reachable from this root. */
  reachableNodes() {
    return this.#hamt.reachableNodes();
  }
  /**
   * Structural diff against `other`. Skips identical subtrees by hash
   * equality, so cost is proportional to the number of changed entries.
   */
  async diff(other) {
    const raw = await this.#hamt.diff(other.#hamt);
    const added = /* @__PURE__ */ new Map();
    const removed = /* @__PURE__ */ new Map();
    const modified = /* @__PURE__ */ new Map();
    for (const [k, v] of raw.added) added.set(k, decodeEntry(v));
    for (const [k, v] of raw.removed) removed.set(k, decodeEntry(v));
    for (const [k, [oldRaw, newRaw]] of raw.modified) {
      modified.set(k, [decodeEntry(oldRaw), decodeEntry(newRaw)]);
    }
    return { added, removed, modified };
  }
};
function hamtOpts(opts) {
  return {
    prefix: opts.prefix ?? Keyset.DEFAULT_PREFIX,
    ...opts.bucketMax !== void 0 && { bucketMax: opts.bucketMax },
    ...opts.pending !== void 0 && { pending: opts.pending }
  };
}

// src/versioned/helpers.ts
function diffKeysets(keysetA, keysetB) {
  const added = /* @__PURE__ */ new Set();
  const removed = /* @__PURE__ */ new Set();
  const modified = /* @__PURE__ */ new Set();
  for (const k of keysetB.keys()) {
    if (!keysetA.has(k)) added.add(k);
  }
  for (const [k, v] of keysetA) {
    if (!keysetB.has(k)) {
      removed.add(k);
    } else if (keysetB.get(k) !== v) {
      modified.add(k);
    }
  }
  return { added, removed, modified };
}
async function* walkHistory(start, parentLoader, opts = {}) {
  if (opts.allParents) {
    const visited = /* @__PURE__ */ new Set();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift();
      if (visited.has(current)) continue;
      visited.add(current);
      yield current;
      const parents = await parentLoader(current);
      for (const p of parents) {
        if (!visited.has(p)) queue.push(p);
      }
    }
  } else {
    let current = start;
    while (current !== null) {
      yield current;
      const parents = await parentLoader(current);
      current = parents[0] ?? null;
    }
  }
}

// src/versioned/merge.ts
async function resolveMerge(opts) {
  const {
    lcaKeyset,
    ourKeyset,
    theirKeyset,
    ourDiff,
    theirDiff,
    blobReader,
    mergeFns,
    defaultMerge
  } = opts;
  const ourChanged = union(ourDiff.added, ourDiff.removed, ourDiff.modified);
  const theirChanged = union(theirDiff.added, theirDiff.removed, theirDiff.modified);
  const allChanged = union(ourChanged, theirChanged);
  const mergedKeyset = /* @__PURE__ */ new Map();
  const mergedValues = /* @__PURE__ */ new Map();
  const autoMerged = [];
  const conflicts = /* @__PURE__ */ new Set();
  const mergeErrors = /* @__PURE__ */ new Map();
  const allKeys = /* @__PURE__ */ new Set([...ourKeyset.keys(), ...theirKeyset.keys()]);
  for (const key of allKeys) {
    if (allChanged.has(key)) continue;
    const fromTheirs = theirKeyset.get(key);
    if (fromTheirs !== void 0) {
      mergedKeyset.set(key, fromTheirs);
    } else {
      const fromOurs = ourKeyset.get(key);
      if (fromOurs !== void 0) mergedKeyset.set(key, fromOurs);
    }
  }
  for (const key of ourChanged) {
    if (theirChanged.has(key)) continue;
    if (!ourDiff.removed.has(key)) {
      const ptr = ourKeyset.get(key);
      if (ptr !== void 0) {
        mergedKeyset.set(key, ptr);
        autoMerged.push(key);
      }
    }
  }
  for (const key of theirChanged) {
    if (ourChanged.has(key)) continue;
    if (!theirDiff.removed.has(key)) {
      const ptr = theirKeyset.get(key);
      if (ptr !== void 0) mergedKeyset.set(key, ptr);
    }
  }
  const contested = intersection(ourChanged, theirChanged);
  for (const key of contested) {
    const ourRemoved = ourDiff.removed.has(key);
    const theirRemoved = theirDiff.removed.has(key);
    if (ourRemoved && theirRemoved) continue;
    if (!ourRemoved && !theirRemoved && ourKeyset.get(key) === theirKeyset.get(key)) {
      const ptr = theirKeyset.get(key);
      if (ptr !== void 0) mergedKeyset.set(key, ptr);
      continue;
    }
    const fn = mergeFns.get(key) ?? defaultMerge;
    if (fn === null || fn === void 0) {
      conflicts.add(key);
      continue;
    }
    const lcaPtr = lcaKeyset.get(key);
    const ourPtr = ourKeyset.get(key);
    const theirPtr = theirKeyset.get(key);
    const oldVal = lcaPtr !== void 0 ? await blobReader(lcaPtr) : null;
    const ourVal = ourRemoved || ourPtr === void 0 ? null : await blobReader(ourPtr);
    const theirVal = theirRemoved || theirPtr === void 0 ? null : await blobReader(theirPtr);
    try {
      const result = fn(oldVal, ourVal, theirVal);
      mergedValues.set(key, result);
      autoMerged.push(key);
    } catch (e) {
      conflicts.add(key);
      mergeErrors.set(key, e);
    }
  }
  if (conflicts.size > 0) {
    throw new MergeConflict(conflicts, mergeErrors);
  }
  return {
    mergedKeyset,
    mergedValues,
    autoMergedKeys: autoMerged
  };
}
function union(...sets) {
  const out = /* @__PURE__ */ new Set();
  for (const s of sets) for (const k of s) out.add(k);
  return out;
}
function intersection(a, b) {
  const out = /* @__PURE__ */ new Set();
  for (const k of a) if (b.has(k)) out.add(k);
  return out;
}

// src/versioned/base.ts
var VersionedBase = class {
  branch;
  currentCommitHash;
  baseCommitHash;
  commitKeys;
  mergeFns;
  defaultMergeFn;
  lastMergeResult;
  /** Cached on first access; the root commit walking back from HEAD. */
  cachedInitialCommit = null;
  constructor(opts) {
    this.branch = opts.branch;
    this.currentCommitHash = opts.commitHash;
    this.baseCommitHash = opts.commitHash;
    this.commitKeys = /* @__PURE__ */ new Map();
    this.mergeFns = /* @__PURE__ */ new Map();
    this.defaultMergeFn = null;
    this.lastMergeResult = null;
  }
  // --- Properties ---
  get currentCommit() {
    return this.currentCommitHash;
  }
  get baseCommit() {
    return this.baseCommitHash;
  }
  get currentBranch() {
    return this.branch;
  }
  get initialCommit() {
    if (this.cachedInitialCommit !== null) return this.cachedInitialCommit;
    throw new Error("initialCommit not yet resolved; call await initial() first");
  }
  /** Resolve the root commit by walking the parent chain. Caches the result. */
  async initial() {
    if (this.cachedInitialCommit !== null) return this.cachedInitialCommit;
    let last = this.currentCommitHash;
    for await (const c of this.history()) last = c;
    this.cachedInitialCommit = last;
    return last;
  }
  // --- Reads (in-memory keyset) ---
  async get(key) {
    const blob = this.commitKeys.get(key);
    if (blob === void 0) return null;
    return this.readBlob(blob);
  }
  async getMany(keys) {
    const out = /* @__PURE__ */ new Map();
    for (const key of keys) {
      const v = await this.get(key);
      if (v !== null) out.set(key, v);
    }
    return out;
  }
  async has(key) {
    return this.commitKeys.has(key);
  }
  async *keys() {
    for (const k of this.commitKeys.keys()) yield k;
  }
  // --- Merge fn registry ---
  setMergeFn(key, fn) {
    this.mergeFns.set(key, fn);
  }
  setDefaultMerge(fn) {
    this.defaultMergeFn = fn;
  }
  // --- History and diff ---
  async diff(commitA, commitB) {
    const a = await this.loadKeyset(commitA);
    const b = await this.loadKeyset(commitB);
    return diffKeysets(a, b);
  }
  history(commitHash, opts = {}) {
    const start = commitHash ?? this.currentCommitHash;
    return walkHistory(start, (h) => this.loadParents(h), opts);
  }
  async parents(commitHash) {
    return this.loadParents(commitHash ?? this.currentCommitHash);
  }
  // --- Commit orchestration ---
  async commit(opts = {}) {
    const updates = opts.updates ?? null;
    const removals = opts.removals ?? null;
    const onConflict = opts.onConflict ?? "raise";
    const info = opts.info ?? null;
    if ((updates === null || updates.size === 0) && (removals === null || removals.size === 0) && info === null) {
      const result = {
        merged: true,
        commit: this.currentCommitHash,
        strategy: "no_op",
        autoMergedKeys: [],
        carriedKeys: []
      };
      this.lastMergeResult = result;
      return result;
    }
    if (onConflict !== "raise" && onConflict !== "skip") {
      throw new TypeError(`onConflict must be 'raise' or 'skip', got ${String(onConflict)}`);
    }
    const currentHead = await this.latestHead();
    if (currentHead === this.baseCommitHash) {
      const saved2 = this.snapshotState();
      await this.createCommit({
        ...updates !== null && { updates },
        ...removals !== null && { removals },
        ...info !== null && { info }
      });
      const ok = await this.casHead(this.baseCommitHash, this.currentCommitHash);
      if (ok) {
        this.baseCommitHash = this.currentCommitHash;
        const result = {
          merged: true,
          commit: this.currentCommitHash,
          strategy: "fast_forward",
          autoMergedKeys: [],
          carriedKeys: [...this.commitKeys.keys()]
        };
        this.lastMergeResult = result;
        return result;
      }
      this.restoreState(saved2);
      if (onConflict === "skip") {
        const result = {
          merged: false,
          commit: null,
          strategy: "fast_forward",
          autoMergedKeys: [],
          carriedKeys: []
        };
        this.lastMergeResult = result;
        return result;
      }
      throw new ConcurrencyError(`HEAD changed from ${this.baseCommitHash}. Refresh and retry.`);
    }
    if (currentHead === null) {
      throw new Error(`Branch '${this.branch}' has no HEAD`);
    }
    const saved = this.snapshotState();
    await this.createCommit({
      ...updates !== null && { updates },
      ...removals !== null && { removals }
    });
    return this.threeWayMerge(currentHead, {
      onConflict,
      ...opts.mergeFns !== null && opts.mergeFns !== void 0 && { mergeFns: opts.mergeFns },
      ...opts.defaultMerge !== null && opts.defaultMerge !== void 0 && { defaultMerge: opts.defaultMerge },
      ...info !== null && { info },
      savedState: saved
    });
  }
  async threeWayMerge(theirHead, opts) {
    const lca = await this.findLca(this.currentCommitHash, theirHead);
    if (lca === null) {
      this.restoreState(opts.savedState);
      if (opts.onConflict === "skip") {
        const result = {
          merged: false,
          commit: null,
          strategy: "three_way",
          autoMergedKeys: [],
          carriedKeys: []
        };
        this.lastMergeResult = result;
        return result;
      }
      throw new ConcurrencyError("No common ancestor found between current commit and HEAD.");
    }
    const lcaKeyset = await this.loadKeyset(lca);
    const ourKeyset = await this.loadKeyset(this.currentCommitHash);
    const theirKeyset = await this.loadKeyset(theirHead);
    const ourDiff = diffKeysets(lcaKeyset, ourKeyset);
    const theirDiff = diffKeysets(lcaKeyset, theirKeyset);
    const effectiveFns = new Map(this.mergeFns);
    if (opts.mergeFns) {
      for (const [k, v] of opts.mergeFns) effectiveFns.set(k, v);
    }
    const effectiveDefault = opts.defaultMerge ?? this.defaultMergeFn;
    let resolution;
    try {
      resolution = await resolveMerge({
        lcaKeyset,
        ourKeyset,
        theirKeyset,
        ourDiff,
        theirDiff,
        blobReader: (id) => this.readBlob(id),
        mergeFns: effectiveFns,
        defaultMerge: effectiveDefault
      });
    } catch (e) {
      if (e instanceof MergeConflict) {
        this.restoreState(opts.savedState);
        if (opts.onConflict === "skip") {
          const result = {
            merged: false,
            commit: null,
            strategy: "three_way",
            autoMergedKeys: [],
            carriedKeys: []
          };
          this.lastMergeResult = result;
          return result;
        }
      }
      throw e;
    }
    const parents = [theirHead, this.currentCommitHash];
    await this.createMergeCommit(resolution, parents, opts.info ?? null);
    const mergeHash = this.currentCommitHash;
    const mergedKeyset = this.commitKeys;
    if (await this.casHead(theirHead, mergeHash)) {
      this.baseCommitHash = mergeHash;
      const carriedKeys = [];
      for (const k of mergedKeyset.keys()) {
        if (!resolution.autoMergedKeys.includes(k) && !resolution.mergedValues.has(k)) {
          carriedKeys.push(k);
        }
      }
      const result = {
        merged: true,
        commit: mergeHash,
        strategy: "three_way",
        autoMergedKeys: [...resolution.autoMergedKeys],
        carriedKeys
      };
      this.lastMergeResult = result;
      return result;
    }
    this.restoreState(opts.savedState);
    if (opts.onConflict === "skip") {
      const result = {
        merged: false,
        commit: null,
        strategy: "three_way",
        autoMergedKeys: [],
        carriedKeys: []
      };
      this.lastMergeResult = result;
      return result;
    }
    throw new ConcurrencyError("HEAD changed during three-way merge. Refresh and retry.");
  }
};

// src/versioned/kv.ts
var STORAGE_VERSION = 1;
var STORAGE_VERSION_KEY = "__kvgit_version__";
var BRANCH_HEAD = (branch) => `__branch_head__${branch}`;
var BRANCH_HEAD_PREV = (branch) => `__branch_head_prev__${branch}`;
var COMMIT_ROOT = (commit) => `__commit_root__${commit}`;
var PARENT_COMMIT = (commit) => `__parent_commit__${commit}`;
var COMMIT_TIME = (commit) => `__commit_time__${commit}`;
var INFO_KEY = (commit) => `__info__${commit}`;
var BRANCH_HEAD_PREFIX = "__branch_head__";
var _encoder3 = new TextEncoder();
var _decoder3 = new TextDecoder();
function dumps(value) {
  return _encoder3.encode(JSON.stringify(value));
}
function loads(raw) {
  return JSON.parse(_decoder3.decode(raw));
}
function safeLoads(raw) {
  try {
    return loads(raw);
  } catch {
    return null;
  }
}
async function resolveHead(store, branch, opts = {}) {
  const repair = opts.repair ?? true;
  const headBytes = await store.get(BRANCH_HEAD(branch));
  if (headBytes !== null) {
    const commitHash = safeLoads(headBytes);
    if (typeof commitHash === "string" && await store.get(COMMIT_ROOT(commitHash)) !== null) {
      return commitHash;
    }
  }
  const prevBytes = await store.get(BRANCH_HEAD_PREV(branch));
  if (prevBytes !== null) {
    const commitHash = safeLoads(prevBytes);
    if (typeof commitHash === "string" && await store.get(COMMIT_ROOT(commitHash)) !== null) {
      console.warn(`kvgit: branch '${branch}' HEAD corrupt, recovered from prev HEAD`);
      if (repair) await store.set(BRANCH_HEAD(branch), dumps(commitHash));
      return commitHash;
    }
  }
  if (opts.recoverFromCorruptHead && headBytes !== null) {
    const recovered = await opts.recoverFromCorruptHead(store, branch);
    if (recovered !== null) {
      console.warn(`kvgit: branch '${branch}' HEAD corrupt, recovered via scan`);
      if (repair) await store.set(BRANCH_HEAD(branch), dumps(recovered));
      return recovered;
    }
  }
  return null;
}
async function checkStorageVersion(store) {
  const raw = await store.get(STORAGE_VERSION_KEY);
  if (raw !== null) {
    const version = safeLoads(raw);
    if (version !== STORAGE_VERSION) {
      throw new Error(
        `Store has kvgit storage version ${JSON.stringify(version)}, this code supports ${STORAGE_VERSION}. Use a fresh store.`
      );
    }
    return;
  }
  let hasExisting = false;
  for await (const _k of store.keys(BRANCH_HEAD_PREFIX)) {
    hasExisting = true;
    break;
  }
  if (hasExisting) {
    throw new Error(
      `Store appears to use an older kvgit storage format. This version requires storage v${STORAGE_VERSION}. Use a fresh store.`
    );
  }
  await store.set(STORAGE_VERSION_KEY, dumps(STORAGE_VERSION));
}
async function sha256Hex2(data) {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    hex += (b < 16 ? "0" : "") + b.toString(16);
  }
  return hex;
}
async function contentHash(parents, keyset, updates, info) {
  const parts = [];
  parts.push(_encoder3.encode(JSON.stringify(parents)));
  const sortedKeyset = [...keyset.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  parts.push(_encoder3.encode(JSON.stringify(sortedKeyset)));
  const sortedUpdateKeys = [...updates.keys()].sort();
  for (const key of sortedUpdateKeys) {
    parts.push(_encoder3.encode(key));
    parts.push(updates.get(key));
  }
  if (info !== null) {
    parts.push(_encoder3.encode(canonicalJson2(info)));
  }
  let total = 0;
  for (const p of parts) total += p.length;
  const flat = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    flat.set(p, off);
    off += p.length;
  }
  const hex = await sha256Hex2(flat);
  return hex.slice(0, 40);
}
function canonicalJson2(value) {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson2).join(",")}]`;
  }
  const obj = value;
  const keys = Object.keys(obj).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson2(obj[k])}`);
  return `{${parts.join(",")}}`;
}
var VersionedKV = class _VersionedKV extends VersionedBase {
  store;
  meta;
  recoverFromCorruptHead;
  constructor(opts) {
    super({ branch: opts.branch, commitHash: opts.commitHash });
    this.store = opts.store;
    this.commitKeys = opts.commitKeys;
    this.meta = opts.meta;
    this.recoverFromCorruptHead = opts.recoverFromCorruptHead;
  }
  /**
   * Open or create a versioned store on `store`.
   *
   * Resolves the branch HEAD with prev-HEAD recovery; creates an
   * initial empty commit if the branch doesn't exist yet. Validates
   * the storage version (rejects formats from other versions).
   */
  static async open(store, opts = {}) {
    await checkStorageVersion(store);
    const branch = opts.branch ?? "main";
    let commitHash = opts.commitHash;
    if (commitHash === void 0) {
      const recovered = await resolveHead(store, branch, {
        ...opts.recoverFromCorruptHead !== void 0 && {
          recoverFromCorruptHead: opts.recoverFromCorruptHead
        }
      });
      if (recovered !== null) {
        commitHash = recovered;
      } else if (await store.get(BRANCH_HEAD(branch)) !== null) {
        throw new Error(`Branch '${branch}' HEAD is corrupt and unrecoverable`);
      } else {
        const initialHash = await contentHash([], /* @__PURE__ */ new Map(), /* @__PURE__ */ new Map(), null);
        await store.setMany([
          [COMMIT_ROOT(initialHash), dumps((await Keyset.empty(store)).root)],
          [PARENT_COMMIT(initialHash), dumps([])],
          [COMMIT_TIME(initialHash), dumps(Date.now())],
          [BRANCH_HEAD(branch), dumps(initialHash)]
        ]);
        commitHash = initialHash;
      }
    }
    const { commitKeys, meta } = await populateState(store, commitHash);
    return new _VersionedKV({
      store,
      branch,
      commitHash,
      commitKeys,
      meta,
      recoverFromCorruptHead: opts.recoverFromCorruptHead
    });
  }
  // --- VersionedBase abstract methods ---
  async latestHead() {
    return resolveHead(this.store, this.branch, {
      repair: false,
      ...this.recoverFromCorruptHead !== void 0 && {
        recoverFromCorruptHead: this.recoverFromCorruptHead
      }
    });
  }
  snapshotState() {
    return {
      currentCommit: this.currentCommitHash,
      commitKeys: new Map(this.commitKeys),
      meta: new Map(this.meta)
    };
  }
  restoreState(saved) {
    const s = saved;
    this.currentCommitHash = s.currentCommit;
    this.commitKeys = s.commitKeys;
    this.meta = s.meta;
  }
  async createCommit(opts) {
    const updates = opts.updates ?? /* @__PURE__ */ new Map();
    const removals = opts.removals ?? /* @__PURE__ */ new Set();
    const info = opts.info ?? null;
    const newCommitKeys = /* @__PURE__ */ new Map();
    const newMeta = /* @__PURE__ */ new Map();
    for (const [k, ptr] of this.commitKeys) {
      if (removals.has(k)) continue;
      newCommitKeys.set(k, ptr);
      const m = this.meta.get(k);
      if (m !== void 0) newMeta.set(k, m);
    }
    const previewKeys = new Map(newCommitKeys);
    for (const k of updates.keys()) previewKeys.set(k, `<pending:${k}>`);
    const newHash = await contentHash([this.currentCommitHash], previewKeys, updates, info);
    const blobWrites = [];
    const now = Date.now();
    for (const [key, value] of updates) {
      const versionedKey = `${newHash}:${key}`;
      blobWrites.push([versionedKey, value]);
      newCommitKeys.set(key, versionedKey);
      const existing = newMeta.get(key);
      const createdAt = existing !== void 0 ? existing.createdAt : now;
      newMeta.set(key, { size: value.length, createdAt });
    }
    const parentRootBytes = await this.store.get(COMMIT_ROOT(this.currentCommitHash));
    const parentRoot = parentRootBytes !== null ? loads(parentRootBytes) : null;
    const parentKs = parentRoot !== null ? Keyset.fromRoot(this.store, parentRoot) : await Keyset.empty(this.store);
    const keysetUpdates = [];
    for (const k of updates.keys()) {
      const m = newMeta.get(k);
      keysetUpdates.push([k, { blob: newCommitKeys.get(k), meta: m }]);
    }
    const newKs = await parentKs.updated({ updates: keysetUpdates, removals });
    const writes = [...blobWrites];
    for (const [k, v] of newKs.pending) writes.push([k, v]);
    writes.push([COMMIT_ROOT(newHash), dumps(newKs.root)]);
    writes.push([PARENT_COMMIT(newHash), dumps([this.currentCommitHash])]);
    writes.push([COMMIT_TIME(newHash), dumps(Date.now())]);
    if (info !== null) writes.push([INFO_KEY(newHash), dumps(info)]);
    await this.store.setMany(writes);
    this.commitKeys = newCommitKeys;
    this.currentCommitHash = newHash;
    this.meta = newMeta;
    return newHash;
  }
  async createMergeCommit(resolution, parents, info) {
    const mergedKeyset = new Map(resolution.mergedKeyset);
    const mergedValues = resolution.mergedValues;
    const previewKeys = new Map(mergedKeyset);
    for (const k of mergedValues.keys()) previewKeys.set(k, `<pending:${k}>`);
    const mergeHash = await contentHash(parents, previewKeys, mergedValues, info);
    const blobWrites = [];
    for (const [key, value] of mergedValues) {
      const versionedKey = `${mergeHash}:${key}`;
      blobWrites.push([versionedKey, value]);
      mergedKeyset.set(key, versionedKey);
    }
    const theirParent = parents[0];
    const theirRootBytes = await this.store.get(COMMIT_ROOT(theirParent));
    const theirKs = theirRootBytes !== null ? Keyset.fromRoot(this.store, loads(theirRootBytes)) : null;
    const now = Date.now();
    const mergedMeta = /* @__PURE__ */ new Map();
    for (const k of mergedKeyset.keys()) {
      if (mergedValues.has(k)) {
        mergedMeta.set(k, { size: mergedValues.get(k).length, createdAt: now });
      } else if (this.meta.has(k)) {
        mergedMeta.set(k, this.meta.get(k));
      } else if (theirKs !== null) {
        const theirEntry = await theirKs.get(k);
        if (theirEntry !== null) mergedMeta.set(k, theirEntry.meta);
      }
    }
    const ourRootBytes = await this.store.get(COMMIT_ROOT(this.currentCommitHash));
    const ourRoot = ourRootBytes !== null ? loads(ourRootBytes) : null;
    const parentKs = ourRoot !== null ? Keyset.fromRoot(this.store, ourRoot) : await Keyset.empty(this.store);
    const keysetUpdates = [];
    for (const [k, blob] of mergedKeyset) {
      const newEntry = { blob, meta: mergedMeta.get(k) };
      const oldBlob = this.commitKeys.get(k);
      const oldMeta = this.meta.get(k);
      if (oldBlob !== newEntry.blob || oldMeta?.size !== newEntry.meta.size || oldMeta?.createdAt !== newEntry.meta.createdAt) {
        keysetUpdates.push([k, newEntry]);
      }
    }
    const keysetRemovals = /* @__PURE__ */ new Set();
    for (const k of this.commitKeys.keys()) {
      if (!mergedKeyset.has(k)) keysetRemovals.add(k);
    }
    const newKs = await parentKs.updated({
      updates: keysetUpdates,
      removals: keysetRemovals
    });
    const writes = [...blobWrites];
    for (const [k, v] of newKs.pending) writes.push([k, v]);
    writes.push([COMMIT_ROOT(mergeHash), dumps(newKs.root)]);
    writes.push([PARENT_COMMIT(mergeHash), dumps([...parents])]);
    writes.push([COMMIT_TIME(mergeHash), dumps(Date.now())]);
    if (info !== null) writes.push([INFO_KEY(mergeHash), dumps(info)]);
    await this.store.setMany(writes);
    this.commitKeys = mergedKeyset;
    this.currentCommitHash = mergeHash;
    this.meta = mergedMeta;
    return mergeHash;
  }
  async casHead(expected, newHead) {
    await this.store.set(BRANCH_HEAD_PREV(this.branch), dumps(expected));
    return this.store.cas(BRANCH_HEAD(this.branch), dumps(newHead), dumps(expected));
  }
  async loadKeyset(commitHash) {
    const out = /* @__PURE__ */ new Map();
    const rootBytes = await this.store.get(COMMIT_ROOT(commitHash));
    if (rootBytes === null) return out;
    const root = loads(rootBytes);
    const ks = Keyset.fromRoot(this.store, root);
    for await (const [k, entry] of ks.items()) out.set(k, entry.blob);
    return out;
  }
  async loadParents(commitHash) {
    const raw = await this.store.get(PARENT_COMMIT(commitHash));
    if (raw === null) return [];
    const parsed = loads(raw);
    if (typeof parsed === "string") return [parsed];
    if (Array.isArray(parsed)) return parsed.filter((p) => typeof p === "string");
    return [];
  }
  async findLca(commitA, commitB) {
    if (commitA === commitB) return commitA;
    const seenA = /* @__PURE__ */ new Set([commitA]);
    const seenB = /* @__PURE__ */ new Set([commitB]);
    const queueA = [commitA];
    const queueB = [commitB];
    while (queueA.length > 0 || queueB.length > 0) {
      if (queueA.length > 0) {
        const current = queueA.shift();
        if (seenB.has(current)) return current;
        for (const p of await this.loadParents(current)) {
          if (!seenA.has(p)) {
            seenA.add(p);
            queueA.push(p);
            if (seenB.has(p)) return p;
          }
        }
      }
      if (queueB.length > 0) {
        const current = queueB.shift();
        if (seenA.has(current)) return current;
        for (const p of await this.loadParents(current)) {
          if (!seenB.has(p)) {
            seenB.add(p);
            queueB.push(p);
            if (seenA.has(p)) return p;
          }
        }
      }
    }
    return null;
  }
  async readBlob(blobId) {
    return this.store.get(blobId);
  }
  // --- Navigation ---
  async refresh() {
    const head = await resolveHead(this.store, this.branch, {
      ...this.recoverFromCorruptHead !== void 0 && {
        recoverFromCorruptHead: this.recoverFromCorruptHead
      }
    });
    if (head === null) {
      throw new Error(`No HEAD commit found for branch '${this.branch}'`);
    }
    await this.loadCommitInto(head, true);
  }
  async checkout(commitHash, opts = {}) {
    if (await this.store.get(COMMIT_ROOT(commitHash)) === null) return null;
    return _VersionedKV.open(this.store, {
      commitHash,
      branch: opts.branch ?? this.branch,
      ...this.recoverFromCorruptHead !== void 0 && {
        recoverFromCorruptHead: this.recoverFromCorruptHead
      }
    });
  }
  async createBranch(name, opts = {}) {
    const target = opts.at ?? this.currentCommitHash;
    if (opts.at !== void 0 && await this.store.get(COMMIT_ROOT(opts.at)) === null) {
      throw new Error(`Commit '${opts.at}' does not exist`);
    }
    const ok = await this.store.cas(BRANCH_HEAD(name), dumps(target), null);
    if (!ok) throw new Error(`Branch '${name}' already exists`);
    return _VersionedKV.open(this.store, {
      branch: name,
      commitHash: target,
      ...this.recoverFromCorruptHead !== void 0 && {
        recoverFromCorruptHead: this.recoverFromCorruptHead
      }
    });
  }
  async deleteBranch(name) {
    if (name === this.branch) {
      throw new Error("Cannot delete the current branch");
    }
    if (await this.store.get(BRANCH_HEAD(name)) === null) {
      throw new Error(`Branch '${name}' does not exist`);
    }
    await this.store.remove(BRANCH_HEAD(name));
    await this.store.remove(BRANCH_HEAD_PREV(name));
  }
  async switchBranch(name) {
    const head = await resolveHead(this.store, name, {
      ...this.recoverFromCorruptHead !== void 0 && {
        recoverFromCorruptHead: this.recoverFromCorruptHead
      }
    });
    if (head === null) {
      if (await this.store.get(BRANCH_HEAD(name)) !== null) {
        throw new Error(`Branch '${name}' HEAD is corrupt and unrecoverable`);
      }
      throw new Error(`Branch '${name}' does not exist`);
    }
    this.branch = name;
    await this.loadCommitInto(head, true);
  }
  async peek(key, opts) {
    const head = await resolveHead(this.store, opts.branch, { repair: false });
    if (head === null) return null;
    const rootBytes = await this.store.get(COMMIT_ROOT(head));
    if (rootBytes === null) return null;
    const root = loads(rootBytes);
    const ks = Keyset.fromRoot(this.store, root);
    const entry = await ks.get(key);
    if (entry === null) return null;
    return this.store.get(entry.blob);
  }
  async resetTo(commitHash) {
    if (await this.store.get(COMMIT_ROOT(commitHash)) === null) return false;
    const current = await this.store.get(BRANCH_HEAD(this.branch));
    if (current !== null) await this.store.set(BRANCH_HEAD_PREV(this.branch), current);
    await this.store.set(BRANCH_HEAD(this.branch), dumps(commitHash));
    await this.loadCommitInto(commitHash, true);
    return true;
  }
  async listBranches() {
    const out = [];
    for await (const k of this.store.keys(BRANCH_HEAD_PREFIX)) {
      const name = k.slice(BRANCH_HEAD_PREFIX.length);
      if (name.length > 0) out.push(name);
    }
    return out.sort();
  }
  async commitInfo(commitHash) {
    const target = commitHash ?? this.currentCommitHash;
    const raw = await this.store.get(INFO_KEY(target));
    if (raw === null) return null;
    return loads(raw);
  }
  // --- Orphan cleanup ---
  /**
   * Remove orphaned commits (and their unreachable blobs + HAMT nodes)
   * not reachable from any live branch HEAD.
   *
   * Mark phase walks every branch's full ancestry, accumulating
   * reachable commits / blobs / HAMT node hashes. `Keyset.walk(skipNodes)`
   * is given the cumulative seen-set so subtrees shared via structural
   * sharing across commits are visited exactly once.
   *
   * The `minAge` guard (default 1 hour) protects recently-created
   * commits from being swept. Within that window, an orphan commit's
   * blobs are marked reachable too — they may belong to an in-flight
   * writer whose CAS hasn't landed yet.
   *
   * @param opts.minAge Milliseconds. Commits younger than this are
   *   protected from sweep, even if currently unreachable. Default: 1 hour.
   * @returns Number of orphaned commits removed.
   */
  async cleanOrphans(opts = {}) {
    const minAge = opts.minAge ?? 36e5;
    const cutoffTime = Date.now() - minAge;
    const reachableCommits = /* @__PURE__ */ new Set();
    const reachableBlobs = /* @__PURE__ */ new Set();
    const reachableNodes = /* @__PURE__ */ new Set();
    const walkCommitForMarks = async (commitHash) => {
      const rootBytes = await this.store.get(COMMIT_ROOT(commitHash));
      if (rootBytes === null) return;
      const root = loads(rootBytes);
      const ks = Keyset.fromRoot(this.store, root);
      const [entries, newNodes] = await ks.walk(reachableNodes);
      for (const entry of entries.values()) reachableBlobs.add(entry.blob);
      for (const node of newNodes) reachableNodes.add(node);
    };
    for await (const k of this.store.keys(BRANCH_HEAD_PREFIX)) {
      const branchName = k.slice(BRANCH_HEAD_PREFIX.length);
      const branchHead = await resolveHead(this.store, branchName, { repair: false });
      if (branchHead === null) continue;
      for await (const commit of this.history(branchHead, { allParents: true })) {
        if (reachableCommits.has(commit)) continue;
        reachableCommits.add(commit);
        await walkCommitForMarks(commit);
      }
    }
    const orphans = [];
    const youngOrphanCommits = [];
    const COMMIT_ROOT_PREFIX = "__commit_root__";
    for await (const k of this.store.keys(COMMIT_ROOT_PREFIX)) {
      const commitHash = k.slice(COMMIT_ROOT_PREFIX.length);
      if (commitHash.length === 0 || reachableCommits.has(commitHash)) continue;
      const timeBytes = await this.store.get(COMMIT_TIME(commitHash));
      if (timeBytes === null) continue;
      const ts = safeLoads(timeBytes);
      if (typeof ts !== "number") continue;
      if (ts < cutoffTime) {
        orphans.push(commitHash);
      } else {
        youngOrphanCommits.push(commitHash);
      }
    }
    for (const young of youngOrphanCommits) {
      await walkCommitForMarks(young);
    }
    const allRemovals = [];
    for (const orphan of orphans) {
      const orphanRootBytes = await this.store.get(COMMIT_ROOT(orphan));
      if (orphanRootBytes !== null) {
        try {
          const orphanRoot = loads(orphanRootBytes);
          const orphanKs = Keyset.fromRoot(this.store, orphanRoot);
          const orphanEntries = await orphanKs.materialize();
          for (const entry of orphanEntries.values()) {
            if (!reachableBlobs.has(entry.blob)) {
              allRemovals.push(entry.blob);
            }
          }
        } catch {
        }
      }
      allRemovals.push(COMMIT_ROOT(orphan));
      allRemovals.push(PARENT_COMMIT(orphan));
      allRemovals.push(COMMIT_TIME(orphan));
      allRemovals.push(INFO_KEY(orphan));
    }
    const KEYSET_PREFIX = Keyset.DEFAULT_PREFIX;
    for await (const k of this.store.keys(KEYSET_PREFIX)) {
      const nodeHash = k.slice(KEYSET_PREFIX.length);
      if (nodeHash.length > 0 && !reachableNodes.has(nodeHash)) {
        allRemovals.push(k);
      }
    }
    if (allRemovals.length > 0) {
      await this.store.removeMany(allRemovals);
    }
    return orphans.length;
  }
  // --- Internal ---
  async loadCommitInto(commitHash, updateBase) {
    this.currentCommitHash = commitHash;
    if (updateBase) this.baseCommitHash = commitHash;
    const { commitKeys, meta } = await populateState(this.store, commitHash);
    this.commitKeys = commitKeys;
    this.meta = meta;
  }
};
async function populateState(store, commitHash) {
  const rootBytes = await store.get(COMMIT_ROOT(commitHash));
  if (rootBytes === null) {
    return { commitKeys: /* @__PURE__ */ new Map(), meta: /* @__PURE__ */ new Map() };
  }
  const root = loads(rootBytes);
  const ks = Keyset.fromRoot(store, root);
  const materialized = await ks.materialize();
  const commitKeys = /* @__PURE__ */ new Map();
  const meta = /* @__PURE__ */ new Map();
  for (const [k, entry] of materialized) {
    commitKeys.set(k, entry.blob);
    meta.set(k, entry.meta);
  }
  return { commitKeys, meta };
}

// src/staged.ts
var _encoder4 = new TextEncoder();
var _decoder4 = new TextDecoder();
var jsonEncoder = (value) => _encoder4.encode(JSON.stringify(value));
var jsonDecoder = (bytes) => JSON.parse(_decoder4.decode(bytes));
var Staged = class _Staged {
  versioned;
  encoder;
  decoder;
  // Buffered state. `_updates` holds new/replaced values; `_removals`
  // holds keys to delete. A key in `_updates` overrides any prior
  // removal and vice versa.
  updates = /* @__PURE__ */ new Map();
  removals = /* @__PURE__ */ new Set();
  cache = /* @__PURE__ */ new Map();
  // User-level merge fns (decoded values cross the boundary).
  userMergeFns = /* @__PURE__ */ new Map();
  userDefaultMerge = null;
  constructor(versioned, opts = {}) {
    this.versioned = versioned;
    this.encoder = opts.encoder ?? jsonEncoder;
    this.decoder = opts.decoder ?? jsonDecoder;
  }
  // --- Versioned pass-through (read-only) ---
  get currentCommit() {
    return this.versioned.currentCommit;
  }
  get baseCommit() {
    return this.versioned.baseCommit;
  }
  get currentBranch() {
    return this.versioned.currentBranch;
  }
  get initialCommit() {
    return this.versioned.initialCommit;
  }
  get lastMergeResult() {
    return this.versioned.lastMergeResult;
  }
  // --- Reads ---
  async get(key) {
    if (this.removals.has(key)) return void 0;
    if (this.updates.has(key)) return this.updates.get(key);
    if (this.cache.has(key)) return this.cache.get(key);
    const raw = await this.versioned.get(key);
    if (raw === null) return void 0;
    const value = this.decoder(raw);
    this.cache.set(key, value);
    return value;
  }
  async has(key) {
    if (this.removals.has(key)) return false;
    if (this.updates.has(key)) return true;
    return this.versioned.has(key);
  }
  async *keys() {
    const seen = /* @__PURE__ */ new Set();
    for await (const k of this.versioned.keys()) {
      if (this.removals.has(k)) continue;
      seen.add(k);
      yield k;
    }
    for (const k of this.updates.keys()) {
      if (!seen.has(k)) yield k;
    }
  }
  // --- Writes (in-memory buffer; no IO) ---
  set(key, value) {
    this.removals.delete(key);
    this.updates.set(key, value);
  }
  delete(key) {
    this.updates.delete(key);
    this.removals.add(key);
  }
  /** Whether there are any staged changes. */
  get hasChanges() {
    return this.updates.size > 0 || this.removals.size > 0;
  }
  /** Whether a specific key has a pending update or removal. */
  isStaged(key) {
    return this.updates.has(key) || this.removals.has(key);
  }
  /** Discard all staged changes and the read cache. */
  reset() {
    this.updates.clear();
    this.removals.clear();
    this.cache.clear();
  }
  // --- Navigation + inspection (canonical wrappers around `Versioned`) ---
  //
  // The full Versioned navigation surface is mirrored on `Staged` so
  // callers don't need to reach through `staged.versioned.*` for any
  // common operation. Two reasons:
  //
  // 1. Operations that move HEAD (switchBranch / resetTo / refresh)
  //    must clear `Staged`'s read cache, otherwise post-move reads
  //    return stale values. Reaching through `versioned` skips that.
  // 2. Operations that fork a new HEAD (createBranch / checkout)
  //    return a new `Versioned`. Wrapping it in `Staged` here keeps
  //    the encoder/decoder aligned — callers stay in `Staged`-land
  //    instead of constructing fresh `Staged`s by hand.
  //
  // Same shape as kvgit-py's `Staged` API. The `versioned` property
  // remains exposed for raw bytes-level access, but for branch / commit
  // navigation use these wrappers.
  /**
   * Switch to a different branch in-place. **Discards staged changes**
   * — `updates`, `removals`, and the read cache are all cleared.
   *
   * Carrying uncommitted writes across a branch switch is a three-way-
   * merge problem in disguise; the kvgit contract is to drop them
   * rather than silently fold them into the new branch.
   */
  async switchBranch(name) {
    await this.versioned.switchBranch(name);
    this.updates.clear();
    this.removals.clear();
    this.cache.clear();
  }
  /**
   * Reset HEAD to `commitHash` and discard staged changes.
   *
   * Returns `true` if the commit exists and the reset landed; `false`
   * leaves staged state untouched. Mirrors kvgit-py's `reset_to` —
   * cleanup only fires on success so a failed reset (unknown hash)
   * doesn't silently throw away the caller's work.
   */
  async resetTo(commitHash) {
    const ok = await this.versioned.resetTo(commitHash);
    if (ok) {
      this.updates.clear();
      this.removals.clear();
      this.cache.clear();
    }
    return ok;
  }
  /**
   * Reload from HEAD (picks up writes from other producers on the
   * same branch). **Discards staged changes** — same reasoning as
   * `switchBranch`: a refresh that landed concurrent commits can
   * leave staged work unable to merge cleanly.
   */
  async refresh() {
    await this.versioned.refresh();
    this.updates.clear();
    this.removals.clear();
    this.cache.clear();
  }
  /**
   * Fork a new branch off `at` (defaults to current HEAD). Returns a
   * fresh `Staged` wrapping the new branch's `Versioned`, with the
   * same encoder/decoder as this one. User merge fns are NOT
   * propagated — register them on the returned instance if needed.
   */
  async createBranch(name, opts = {}) {
    const v = await this.versioned.createBranch(name, opts);
    return new _Staged(v, { encoder: this.encoder, decoder: this.decoder });
  }
  /**
   * Open a `Staged` view at a specific commit (read-only timeline
   * navigation). Returns `null` if the commit doesn't exist. Optional
   * `branch` follows the underlying `Versioned.checkout` semantics.
   */
  async checkout(commitHash, opts = {}) {
    const v = await this.versioned.checkout(commitHash, opts);
    if (v === null) return null;
    return new _Staged(v, { encoder: this.encoder, decoder: this.decoder });
  }
  /** List all branch names in the underlying store. */
  async listBranches() {
    return this.versioned.listBranches();
  }
  /**
   * Delete a branch by name. Cannot delete the current branch — the
   * underlying `Versioned` enforces this and throws.
   */
  async deleteBranch(name) {
    return this.versioned.deleteBranch(name);
  }
  /**
   * Read a key from another branch's HEAD without switching to it.
   * Returns the decoded value, or `undefined` if the key is absent.
   *
   * Doesn't touch the read cache (the cache is keyed by *this* branch).
   */
  async peek(key, opts) {
    const raw = await this.versioned.peek(key, opts);
    if (raw === null) return void 0;
    return this.decoder(raw);
  }
  /**
   * Walk the commit chain from `commitHash` (or current HEAD) backward
   * through history. With `allParents: true`, also walks merge
   * second-parents. Pure pass-through to the underlying `Versioned`.
   */
  history(commitHash, opts = {}) {
    return this.versioned.history(commitHash, opts);
  }
  // --- Merge fn registry (user-level: decoded values) ---
  setMergeFn(key, fn) {
    this.userMergeFns.set(key, fn);
  }
  setDefaultMerge(fn) {
    this.userDefaultMerge = fn;
  }
  // --- Commit ---
  async commit(opts = {}) {
    const { keys: filterKeys } = opts;
    let encodedUpdates = null;
    let effectiveRemovals = null;
    if (filterKeys !== void 0) {
      const matchedUpdates = /* @__PURE__ */ new Map();
      for (const k of filterKeys) {
        if (this.updates.has(k)) matchedUpdates.set(k, this.updates.get(k));
      }
      if (matchedUpdates.size > 0) {
        encodedUpdates = /* @__PURE__ */ new Map();
        for (const [k, v] of matchedUpdates) {
          encodedUpdates.set(k, this.encoder(v));
        }
      }
      const matchedRemovals = /* @__PURE__ */ new Set();
      for (const k of filterKeys) {
        if (this.removals.has(k)) matchedRemovals.add(k);
      }
      if (matchedRemovals.size > 0) effectiveRemovals = matchedRemovals;
    } else {
      if (this.updates.size > 0) {
        encodedUpdates = /* @__PURE__ */ new Map();
        for (const [k, v] of this.updates) {
          encodedUpdates.set(k, this.encoder(v));
        }
      }
      if (this.removals.size > 0) effectiveRemovals = new Set(this.removals);
    }
    const effectiveFns = new Map(this.userMergeFns);
    if (opts.mergeFns) {
      for (const [k, fn] of opts.mergeFns) effectiveFns.set(k, fn);
    }
    const effectiveDefault = opts.defaultMerge ?? this.userDefaultMerge;
    let bytesMergeFns = null;
    if (effectiveFns.size > 0) {
      bytesMergeFns = /* @__PURE__ */ new Map();
      for (const [k, fn] of effectiveFns) {
        bytesMergeFns.set(k, this.wrapMergeFn(fn));
      }
    }
    const bytesDefault = effectiveDefault !== null && effectiveDefault !== void 0 ? this.wrapMergeFn(effectiveDefault) : null;
    const result = await this.versioned.commit({
      ...encodedUpdates !== null && { updates: encodedUpdates },
      ...effectiveRemovals !== null && { removals: effectiveRemovals },
      ...opts.onConflict !== void 0 && { onConflict: opts.onConflict },
      ...bytesMergeFns !== null && { mergeFns: bytesMergeFns },
      ...bytesDefault !== null && { defaultMerge: bytesDefault },
      ...opts.info !== void 0 && { info: opts.info }
    });
    if (result.merged) {
      if (filterKeys !== void 0) {
        for (const k of filterKeys) {
          this.updates.delete(k);
          this.removals.delete(k);
        }
      } else {
        this.updates.clear();
        this.removals.clear();
      }
      this.cache.clear();
    }
    return result;
  }
  /**
   * Wrap a user-level merge fn (decoded values) into a bytes-level fn
   * the `Versioned` layer can call. Encodes the merge result with the
   * configured encoder.
   */
  wrapMergeFn(fn) {
    const encoder = this.encoder;
    const decoder = this.decoder;
    return (oldB, oursB, theirsB) => {
      const oldV = oldB !== null ? decoder(oldB) : null;
      const ours = oursB !== null ? decoder(oursB) : null;
      const theirs = theirsB !== null ? decoder(theirsB) : null;
      return encoder(fn(oldV, ours, theirs));
    };
  }
};

// src/namespaced.ts
var Namespaced = class _Namespaced {
  /** The full prefix this view is namespaced under (without trailing slash). */
  namespace;
  store;
  constructor(store, namespace) {
    if (namespace.includes("/")) {
      throw new Error("Namespace names cannot contain '/'");
    }
    if (store instanceof _Namespaced) {
      this.namespace = `${store.namespace}/${namespace}`;
      this.store = store.store;
    } else {
      this.namespace = namespace;
      this.store = store;
    }
  }
  prefixed(key) {
    return `${this.namespace}/${key}`;
  }
  // --- Reads ---
  async get(key) {
    return this.store.get(this.prefixed(key));
  }
  async has(key) {
    return this.store.has(this.prefixed(key));
  }
  /** Direct child keys in this namespace (excluding nested sub-namespaces). */
  async *keys() {
    const prefix = `${this.namespace}/`;
    for await (const k of this.store.keys()) {
      if (!k.startsWith(prefix)) continue;
      const remainder = k.slice(prefix.length);
      if (remainder.length === 0 || remainder.includes("/")) continue;
      yield remainder;
    }
  }
  /** All keys under this namespace, including those in nested sub-namespaces. */
  async *descendantKeys() {
    const prefix = `${this.namespace}/`;
    for await (const k of this.store.keys()) {
      if (k.startsWith(prefix)) yield k.slice(prefix.length);
    }
  }
  // --- Writes ---
  set(key, value) {
    this.store.set(this.prefixed(key), value);
  }
  delete(key) {
    this.store.delete(this.prefixed(key));
  }
};

export { ConcurrencyError, Hamt, Keyset, MergeConflict, Namespaced, Staged, VersionedBase, VersionedKV, decodeEntry, diffKeysets, encodeEntry, jsonDecoder, jsonEncoder, resolveMerge, walkHistory };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map