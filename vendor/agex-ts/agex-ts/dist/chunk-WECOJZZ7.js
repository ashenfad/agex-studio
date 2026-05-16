// src/state/backend.ts
function isVersioned(backend) {
  return "commit" in backend && typeof backend.commit === "function";
}

// src/state/live.ts
var Live = class {
  #data = /* @__PURE__ */ new Map();
  async get(key) {
    return this.#data.get(key);
  }
  set(key, value) {
    this.#data.set(key, value);
  }
  delete(key) {
    this.#data.delete(key);
  }
  async has(key) {
    return this.#data.has(key);
  }
  async *keys() {
    for (const k of [...this.#data.keys()]) yield k;
  }
  /** Test/inspection helper — returns the current size without
   *  iterating. Not part of `StateBackend`. */
  get size() {
    return this.#data.size;
  }
};

// src/state/connect.ts
var SAFE_SESSION_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/;
function assertSafeSession(session) {
  if (typeof session !== "string" || session.length === 0 || !SAFE_SESSION_RE.test(session)) {
    throw new Error(
      `connectState: invalid session id ${JSON.stringify(session)} \u2014 must match /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/ to prevent path traversal in storage backends`
    );
  }
}
async function connectState(config = { type: "live" }) {
  if (config.type === "live") {
    const cache2 = /* @__PURE__ */ new Map();
    return {
      versioned: false,
      async resolve(session) {
        assertSafeSession(session);
        const cached = cache2.get(session);
        if (cached !== void 0) return cached;
        const fresh = new Live();
        cache2.set(session, fresh);
        return fresh;
      }
    };
  }
  const { Staged, VersionedKV } = await import('kvgit-ts');
  const { KvgitState: KvgitState2 } = await import('./kvgit-FGRBAI25.js');
  const { polymorphicDecoder: polyDecoder, polymorphicEncoder: polyEncoder } = await import('termish-ts/fs/kvgit');
  let makeStore;
  switch (config.storage) {
    case "memory": {
      const { Memory } = await import('kvgit-ts/backends/memory');
      makeStore = async () => new Memory();
      break;
    }
    case "indexeddb": {
      const { IndexedDB } = await import('kvgit-ts/backends/idb');
      makeStore = async (session) => IndexedDB.open({ dbName: `kvgit/${session}` });
      break;
    }
    case "sqlite": {
      if (config.path === void 0) {
        throw new Error('connectState: storage "sqlite" requires a `path` option');
      }
      const { Sqlite } = await import('kvgit-ts/backends/sqlite');
      const dir = config.path;
      makeStore = async (session) => Sqlite.open({ path: `${dir}/${session}.db` });
      break;
    }
    default: {
      const exhaustive = config.storage;
      throw new Error(`connectState: unknown storage type: ${exhaustive}`);
    }
  }
  const cache = /* @__PURE__ */ new Map();
  return {
    versioned: true,
    async resolve(session) {
      assertSafeSession(session);
      const cached = cache.get(session);
      if (cached !== void 0) return cached;
      const store = await makeStore(session);
      const vk = await VersionedKV.open(store);
      const staged = new Staged(vk, { encoder: polyEncoder, decoder: polyDecoder });
      const fresh = new KvgitState2(staged);
      cache.set(session, fresh);
      return fresh;
    }
  };
}

export { Live, connectState, isVersioned };
//# sourceMappingURL=chunk-WECOJZZ7.js.map
//# sourceMappingURL=chunk-WECOJZZ7.js.map