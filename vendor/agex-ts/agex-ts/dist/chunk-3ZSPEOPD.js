// src/state/kvgit.ts
var KvgitState = class {
  #staged;
  constructor(staged) {
    this.#staged = staged;
  }
  /** Expose the underlying Staged so callers can reach kvgit-specific
   *  surface (branches, history walks, etc.). */
  get staged() {
    return this.#staged;
  }
  get currentCommit() {
    return this.#staged.currentCommit;
  }
  get hasChanges() {
    return this.#staged.hasChanges;
  }
  async get(key) {
    return this.#staged.get(key);
  }
  set(key, value) {
    this.#staged.set(key, value);
  }
  delete(key) {
    this.#staged.delete(key);
  }
  async has(key) {
    return this.#staged.has(key);
  }
  keys() {
    return this.#staged.keys();
  }
  async commit(opts = {}) {
    if (!this.#staged.hasChanges) return this.#staged.currentCommit;
    const result = await this.#staged.commit({
      ...opts.info !== void 0 && { info: opts.info }
    });
    return result.commit ?? this.#staged.currentCommit;
  }
  /** Pass through to the underlying VersionedKV. Returns commit
   *  metadata (info dict + parents) at `hash`, or current HEAD if
   *  omitted. Returns `null` if the hash doesn't exist. */
  async commitInfo(hash) {
    return this.#staged.versioned.commitInfo(hash);
  }
  /** Walk commit hashes from `hash` (or HEAD) backward through
   *  the history. Pass through to the underlying VersionedKV. */
  history(hash, opts = {}) {
    return this.#staged.versioned.history(hash, opts);
  }
  /** Open a read-only view at a historical commit. Returns the
   *  underlying `Versioned`; callers wrap with their own `Staged`
   *  if they need write semantics. */
  async checkoutAt(hash) {
    return this.#staged.versioned.checkout(hash);
  }
};

export { KvgitState };
//# sourceMappingURL=chunk-3ZSPEOPD.js.map
//# sourceMappingURL=chunk-3ZSPEOPD.js.map