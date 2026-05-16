import { INSTANCE_HANDLE_KEY } from './chunk-WYALNYZL.js';
import { wrapAgentFs } from 'agex-ts/wrap-fs';

var TaskSuccessSignal = class {
  constructor(value) {
    this.value = value;
  }
  value;
};
var TaskFailSignal = class extends Error {
  name = "TaskFailError";
};
var AsyncFunction = Object.getPrototypeOf(async () => void 0).constructor;
function post(msg) {
  self.postMessage(msg);
}
function makeConsole(executeId) {
  const emit = (level, args) => {
    const buf = [];
    const flush = () => {
      if (buf.length === 0) return;
      const text = buf.map(safeStringify).join(" ");
      const out = level === "log" ? text : `[${level}] ${text}`;
      post({ type: "output", executeId, part: { type: "text", text: out } });
      buf.length = 0;
    };
    for (const a of args) {
      const img = detectImage(a);
      if (img !== null) {
        flush();
        post({ type: "output", executeId, part: { type: "image", ...img } });
      } else {
        buf.push(a);
      }
    }
    flush();
  };
  const noop = () => {
  };
  return {
    log: (...a) => emit("log", a),
    info: (...a) => emit("info", a),
    warn: (...a) => emit("warn", a),
    error: (...a) => emit("error", a),
    debug: noop,
    trace: noop,
    dir: noop,
    table: noop,
    group: noop,
    groupCollapsed: noop,
    groupEnd: noop,
    assert: noop,
    count: noop,
    countReset: noop,
    time: noop,
    timeEnd: noop,
    timeLog: noop,
    clear: noop
    // biome-ignore lint/suspicious/noExplicitAny: Console has many optional members across realms
  };
}
var MAX_CAPTURE_BYTES = 5e4;
function _cap(s) {
  return s.length > MAX_CAPTURE_BYTES ? `${s.slice(0, MAX_CAPTURE_BYTES)}\u2026(truncated, original ${s.length} bytes)` : s;
}
function safeStringify(v) {
  if (v === null) return "null";
  if (v === void 0) return "undefined";
  const t = typeof v;
  if (t === "string") return _cap(v);
  if (t === "number" || t === "boolean" || t === "bigint") return String(v);
  if (t === "function") return "[function]";
  try {
    const json = JSON.stringify(v);
    if (json === void 0) return _cap(String(v));
    return _cap(json);
  } catch {
    try {
      return _cap(String(v));
    } catch {
      return "[unserializable]";
    }
  }
}
function detectImage(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Uint8Array)) {
    const v = value;
    if ((v.format === "png" || v.format === "jpeg" || v.format === "webp") && typeof v.data === "string" && v.data.length > 0) {
      return { format: v.format, data: v.data };
    }
  }
  if (typeof value === "string") {
    const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(value);
    if (m !== null && m[1] !== void 0 && m[2] !== void 0) {
      return { format: m[1], data: m[2] };
    }
  }
  if (value instanceof Uint8Array && value.byteLength >= 12) {
    if (value[0] === 137 && value[1] === 80 && value[2] === 78 && value[3] === 71) {
      return { format: "png", data: bytesToBase64(value) };
    }
    if (value[0] === 255 && value[1] === 216 && value[2] === 255) {
      return { format: "jpeg", data: bytesToBase64(value) };
    }
    if (value[0] === 82 && value[1] === 73 && value[2] === 70 && value[3] === 70 && value[8] === 87 && value[9] === 69 && value[10] === 66 && value[11] === 80) {
      return { format: "webp", data: bytesToBase64(value) };
    }
  }
  return null;
}
function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
var FS_METHODS = [
  "getcwd",
  "chdir",
  "read",
  "write",
  "exists",
  "isFile",
  "isDir",
  "stat",
  "mkdir",
  "remove",
  "rmdir",
  "rename",
  "list",
  "listDetailed"
];
var CACHE_METHODS = ["set", "get", "has", "delete", "keys"];
var BridgeChannel = class {
  constructor(executeId) {
    this.executeId = executeId;
  }
  executeId;
  nextCallId = 1;
  pending = /* @__PURE__ */ new Map();
  /** Tracks Proxies this channel created via `buildClass`, so we
   *  can recognize them when they appear in outbound args and
   *  replace with a wire marker the host can rehydrate. WeakMap
   *  keyed on the Proxy reference — entries auto-clear when the
   *  Proxy is no longer reachable (typically at execute settle
   *  when the agent's locals go out of scope). */
  trackedProxies = /* @__PURE__ */ new WeakMap();
  /** Build the worker-side `fs` or `cache` object. Each method is a
   *  thin wrapper that posts a `bridgeCall` and returns a Promise. */
  build(target, methods) {
    const out = {};
    for (const method of methods) {
      out[method] = (...args) => this.call(target, method, args);
    }
    return out;
  }
  /** Build a stub for a single registered fn — calling it posts a
   *  `bridgeCall` with `target: 'fn'` and `method: <name>`. */
  buildFn(name) {
    return (...args) => this.call("fn", name, args);
  }
  /** Build a namespace object: each visible member becomes a method
   *  that posts `bridgeCall` with the namespace name as `subject`
   *  so the host knows which surface to dispatch to. */
  buildNamespace(name, members) {
    const out = {};
    for (const member of members) {
      out[member] = (...args) => this.call("namespace", member, args, name);
    }
    return out;
  }
  /** Build the worker-side stub for a registered class. The returned
   *  function is what the agent sees as `MyClass`:
   *
   *    - Called with `new MyClass(...args)` → posts `newInstance`
   *      and returns a Proxy synchronously. The Proxy carries a
   *      pending-creation Promise; method calls on it await that
   *      Promise before posting `instanceCall`. The constructor
   *      *throws* if it's invoked without `new` or via subclass
   *      `super(...)` (`new.target !== WorkerStub`), since the
   *      host can't model an agent-defined subclass that adds its
   *      own state.
   *
   *    - Property access for static methods returns a stub function
   *      that posts a `bridgeCall { target: 'cls' }`. Same dispatch
   *      shape as namespace members — the host treats the class as
   *      a namespace for static dispatch.
   *
   *    - `instance instanceof WorkerStub` works because the Proxy's
   *      `getPrototypeOf` trap returns `WorkerStub.prototype` (a
   *      sentinel object we control). `instance.constructor`
   *      returns `WorkerStub`. Subclassing in agent code is not
   *      supported — see the `new.target` check inside the
   *      constructor below. */
  buildClass(spec) {
    const channel = this;
    const { name, instanceMethods, staticMethods } = spec;
    const instanceMethodSet = new Set(instanceMethods);
    const sentinelProto = /* @__PURE__ */ Object.create(null);
    function WorkerStub(...args) {
      if (new.target === void 0) {
        throw new TypeError(`Class constructor ${name} cannot be invoked without 'new'`);
      }
      if (new.target !== WorkerStub) {
        throw new Error(
          `Subclassing registered class '${name}' isn't supported in this runtime; instances live host-side and can't carry agent-defined state. Define worker-realm hierarchies in /helpers (or in a class you compose, not extend).`
        );
      }
      const idPromise = channel.newInstance(name, args);
      const proxy = new Proxy(Object.create(sentinelProto), {
        getPrototypeOf() {
          return sentinelProto;
        },
        get(_t, prop) {
          if (prop === "constructor") return WorkerStub;
          if (typeof prop !== "string") return void 0;
          if (!instanceMethodSet.has(prop)) return void 0;
          return (...callArgs) => {
            return idPromise.then((id) => channel.instanceCall(id, prop, callArgs));
          };
        }
      });
      channel.trackProxy(proxy, idPromise);
      return proxy;
    }
    Object.defineProperty(WorkerStub, "name", { value: name, configurable: true });
    Object.defineProperty(WorkerStub, "prototype", {
      value: sentinelProto,
      writable: false,
      enumerable: false,
      configurable: false
    });
    for (const m of staticMethods) {
      WorkerStub[m] = (...args) => this.call("cls", m, args, name);
    }
    return WorkerStub;
  }
  /** Register a Proxy this channel built so it can be recognized
   *  in later outbound args. The id Promise is stored (not the
   *  resolved id) because construction is async — when the Proxy
   *  is first passed as an arg, we await the id at that moment. */
  trackProxy(proxy, idPromise) {
    this.trackedProxies.set(proxy, idPromise);
  }
  /** Sync probe: does the args tree contain any tracked Proxy? If
   *  not, the args pass through structured-clone unchanged and we
   *  can avoid the async pack-then-post path entirely. Keeping the
   *  common case synchronous matters for orphan-call cancellation
   *  timing: when an agent fires `void slow()` then `taskSuccess`'s,
   *  the bridgeCall must reach the host *before* the result message
   *  for the host's per-execute listener to handle the response —
   *  deferring all posts behind an `await` shifts the orphan call
   *  past the listener teardown and the orphan never executes. */
  argsNeedPacking(args) {
    const seen = /* @__PURE__ */ new WeakSet();
    const probe = (v) => {
      if (v === null || typeof v !== "object") return false;
      if (this.trackedProxies.has(v)) return true;
      if (seen.has(v)) return false;
      seen.add(v);
      if (Array.isArray(v)) return v.some(probe);
      if (Object.getPrototypeOf(v) !== Object.prototype) return false;
      return Object.keys(v).some((k) => probe(v[k]));
    };
    return args.some(probe);
  }
  /** Walk an args array and replace any tracked Proxy (top-level,
   *  in arrays, or in plain objects) with an `INSTANCE_HANDLE_KEY`
   *  marker the host knows how to rehydrate. Non-plain objects
   *  (Uint8Array, Date, Map, etc.) pass through unchanged — they
   *  structured-clone fine on their own. Cycle protection via a
   *  visited WeakSet so a circular plain-object structure doesn't
   *  stack-overflow.
   *
   *  Awaits each tracked Proxy's id Promise lazily so this works
   *  even when the agent calls a method on `b` immediately after
   *  `new B()` — the id may still be pending host-side, but we
   *  serialize the wait into the call's own pre-post step rather
   *  than blocking arg construction. */
  async packArgs(args) {
    const visited = /* @__PURE__ */ new WeakSet();
    const pack = async (v) => {
      if (v === null || typeof v !== "object") return v;
      const tracked = this.trackedProxies.get(v);
      if (tracked !== void 0) {
        const id = await tracked;
        return { [INSTANCE_HANDLE_KEY]: { id } };
      }
      if (visited.has(v)) return v;
      visited.add(v);
      if (Array.isArray(v)) {
        const out2 = [];
        for (const e of v) out2.push(await pack(e));
        return out2;
      }
      if (Object.getPrototypeOf(v) !== Object.prototype) return v;
      const out = {};
      for (const k of Object.keys(v)) {
        out[k] = await pack(v[k]);
      }
      return out;
    };
    return Promise.all(args.map(pack));
  }
  /** Wrappers around `call()` that produce alternate outbound
   *  message shapes — `newInstance` and `instanceCall` aren't
   *  `bridgeCall` variants on the wire (the host needs to dispatch
   *  them differently), but they share the same callId/pending
   *  bookkeeping since responses come back as `bridgeResponse`
   *  regardless of which outbound shape created them. */
  newInstance(clsName, args) {
    return new Promise((resolve, reject) => {
      const callId = this.nextCallId++;
      this.pending.set(callId, {
        resolve: (v) => resolve(v.instanceId),
        reject
      });
      this.postWithArgs(callId, reject, args, (packed) => ({
        type: "newInstance",
        executeId: this.executeId,
        callId,
        clsName,
        args: packed
      }));
    });
  }
  instanceCall(instanceId, method, args) {
    return new Promise((resolve, reject) => {
      const callId = this.nextCallId++;
      this.pending.set(callId, { resolve, reject });
      this.postWithArgs(callId, reject, args, (packed) => ({
        type: "instanceCall",
        executeId: this.executeId,
        callId,
        instanceId,
        method,
        args: packed
      }));
    });
  }
  call(target, method, args, subject) {
    return new Promise((resolve, reject) => {
      const callId = this.nextCallId++;
      this.pending.set(callId, { resolve, reject });
      this.postWithArgs(callId, reject, args, (packed) => ({
        type: "bridgeCall",
        executeId: this.executeId,
        callId,
        target,
        ...subject !== void 0 && { subject },
        method,
        args: packed
      }));
    });
  }
  /** Common post path that respects the sync/async split:
   *
   *    - If `args` contain no tracked Proxies, skip packing entirely
   *      and post synchronously. This is the common case (primitives,
   *      Uint8Array, plain objects, etc.) and matters for orphan-
   *      call cancellation timing — the bridgeCall reaches the host
   *      *before* the per-execute listener tears down at execute
   *      settle, so cancelPending can correctly settle the orphan.
   *    - If `args` *do* contain tracked Proxies, pack them async
   *      (awaiting each Proxy's idPromise) and post when done. This
   *      branch is only used when the agent passes one Proxy
   *      instance as an argument to another instance's method.
   *
   *  In both branches a `postMessage` failure (typically
   *  DataCloneError on an arg) deletes the pending entry and
   *  rejects the caller's Promise. */
  postWithArgs(callId, reject, args, build) {
    const fail = (e) => {
      this.pending.delete(callId);
      reject(e instanceof Error ? e : new Error(String(e)));
    };
    if (!this.argsNeedPacking(args)) {
      try {
        post(build(args));
      } catch (e) {
        fail(e);
      }
      return;
    }
    this.packArgs(args).then(
      (packed) => {
        try {
          post(build(packed));
        } catch (e) {
          fail(e);
        }
      },
      (e) => fail(e)
    );
  }
  /** Called by the module-level message listener when a
   *  `bridgeResponse` arrives. Looks up the parked resolver and
   *  settles it.
   *
   *  We filter on **both** `executeId` and `callId`: the worker
   *  scope is reused across consecutive executes (one BridgeChannel
   *  per execute, but the same Worker), and `callId` resets to 1
   *  every new channel. A response from a previous execute whose
   *  bridged call finished *after* the execute settled (orphaned
   *  Promise — agent code dispatched a call without awaiting it,
   *  then `taskSuccess`'d) would otherwise collide on `callId`
   *  with a live pending call in the current execute and resolve
   *  it with the stale value. The `executeId` check drops those
   *  stale responses cleanly. */
  handleResponse(msg) {
    if (msg.executeId !== this.executeId) return;
    const slot = this.pending.get(msg.callId);
    if (slot === void 0) return;
    this.pending.delete(msg.callId);
    if (msg.ok) slot.resolve(msg.value);
    else slot.reject(rebuildError(msg.error));
  }
  /** Reject any still-pending calls with `reason`, then clear the
   *  pending map. Called when the owning `execute` settles so that
   *  Promises orphaned by user code (e.g. `void slow(); taskSuccess()`,
   *  or a `setTimeout` that fires after `taskSuccess`) don't pin the
   *  channel + their closures in memory across emissions. Without
   *  this, a never-resolved `await` in a `setTimeout` callback would
   *  retain a frame indefinitely until the worker is finally
   *  terminated. */
  cancelPending(reason) {
    if (this.pending.size === 0) return;
    const entries = [...this.pending.values()];
    this.pending.clear();
    for (const slot of entries) slot.reject(reason);
  }
  /** Number of bridge calls awaiting host responses. Used by the
   *  late-terminator-detection path to decide whether to drain
   *  before declaring an emission settled. */
  get pendingCount() {
    return this.pending.size;
  }
  /** Wait for the pending-bridge-calls map to drain (or hit the
   *  timeout). Polled because pending calls resolve asynchronously
   *  via `handleResponse` from the message listener — we just need
   *  yields back to the event loop for those messages to land.
   *
   *  Bounded so a runaway "agent fired infinite background work"
   *  case can't pin us forever. The host-side per-emission timeout
   *  bounds the total wait independently. */
  async drain(timeoutMs) {
    const start = performance.now();
    while (this.pending.size > 0) {
      if (performance.now() - start > timeoutMs) return;
      await new Promise((r) => setTimeout(r, 5));
    }
  }
};
function rebuildError(s) {
  const e = new Error(s.message);
  e.name = s.name;
  if (s.stack !== void 0) e.stack = s.stack;
  return e;
}
function serializeError(e) {
  if (e instanceof Error) {
    const out = { name: e.name, message: e.message };
    if (e.stack !== void 0) return { ...out, stack: e.stack };
    return out;
  }
  return { name: "Error", message: safeStringify(e) };
}
var activeBridge = null;
var currentExecuteId = null;
var configured = null;
var urlSpecs = /* @__PURE__ */ new Map();
var urlPromiseCache = /* @__PURE__ */ new Map();
var rawImport = new Function("url", "return import(url)");
var pendingResolveCalls = /* @__PURE__ */ new Map();
var nextResolveCallId = 1;
function resolveNamespaceViaHost(executeId, specifier) {
  const callId = nextResolveCallId++;
  return new Promise((resolve) => {
    pendingResolveCalls.set(callId, resolve);
    post({ type: "resolveNamespace", executeId, callId, specifier });
  });
}
function handleResolveNamespaceResponse(msg) {
  const resolver = pendingResolveCalls.get(msg.callId);
  if (resolver === void 0) return;
  pendingResolveCalls.delete(msg.callId);
  resolver(msg.url);
}
function handleConfigure(msg) {
  configured = msg;
  urlSpecs.clear();
  urlPromiseCache.clear();
  for (const spec of msg.urlModules) {
    urlSpecs.set(spec.name, {
      url: spec.url,
      ...spec.export !== void 0 && { export: spec.export }
    });
  }
  if (msg.routeFetchToVfs !== void 0) {
    installFetchShim(msg.routeFetchToVfs);
  }
}
var _originalFetch = globalThis.fetch.bind(globalThis);
var _fetchShimInstalled = false;
function installFetchShim(routing) {
  if (_fetchShimInstalled) {
    _activeRouting = routing;
    return;
  }
  _activeRouting = routing;
  _fetchShimInstalled = true;
  globalThis.fetch = async function patchedFetch(input, init) {
    const decision = decideFetchRoute(input, init, _activeRouting);
    if (decision === "passthrough") return _originalFetch(input, init);
    if (decision === "not-in-prefix-vfs") {
      return new Response(null, { status: 404, statusText: "Not Found in VFS" });
    }
    const path = decision.path;
    if (activeBridge === null) {
      return _originalFetch(input, init);
    }
    try {
      const fs = activeBridge.build("fs", FS_METHODS);
      const bytes = await fs.read(path);
      return new Response(bytes, {
        status: 200,
        headers: { "content-type": inferContentType(path) }
      });
    } catch (e) {
      if (Array.isArray(_activeRouting)) {
        return new Response(null, { status: 404, statusText: "Not Found in VFS" });
      }
      return _originalFetch(input, init);
    }
  };
}
var _activeRouting = false;
function decideFetchRoute(input, init, routing) {
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method !== "GET" && method !== "HEAD") return "passthrough";
  const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (!urlStr.startsWith("/") || urlStr.startsWith("//")) return "passthrough";
  const noQuery = urlStr.split("#")[0]?.split("?")[0] ?? urlStr;
  const path = noQuery;
  if (routing === true) return { path };
  if (Array.isArray(routing)) {
    const matches = routing.some((prefix) => path.startsWith(prefix));
    if (!matches) return "passthrough";
    return { path };
  }
  return "passthrough";
}
function inferContentType(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return "application/octet-stream";
  const ext = path.slice(dot + 1).toLowerCase();
  switch (ext) {
    case "csv":
      return "text/csv";
    case "json":
      return "application/json";
    case "txt":
    case "md":
      return "text/plain";
    case "html":
    case "htm":
      return "text/html";
    case "xml":
      return "application/xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "parquet":
      return "application/vnd.apache.parquet";
    case "arrow":
      return "application/vnd.apache.arrow.stream";
    default:
      return "application/octet-stream";
  }
}
function __load(name) {
  const cached = urlPromiseCache.get(name);
  if (cached !== void 0) return cached;
  const spec = urlSpecs.get(name);
  if (spec !== void 0) {
    const p2 = (async () => {
      try {
        const mod = await rawImport(spec.url);
        const value = spec.export === void 0 ? mod : mod[spec.export];
        if (value === void 0) {
          const e = new Error(
            `Could not load registered module '${name}' (${spec.url}): module has no '${spec.export}' export (named exports: ${Object.keys(mod).join(", ") || "<none>"})`
          );
          e.name = "ImportError";
          throw e;
        }
        return value;
      } catch (raw) {
        if (raw instanceof Error && raw.name === "ImportError") throw raw;
        const reason = raw instanceof Error ? raw.message : String(raw);
        const wrapped = new Error(
          `Could not load registered module '${name}' (${spec.url}): ${reason}`
        );
        wrapped.name = "ImportError";
        throw wrapped;
      }
    })();
    urlPromiseCache.set(name, p2);
    p2.catch(() => void 0);
    return p2;
  }
  const p = (async () => {
    if (configured?.hasNamespaceResolver === true && currentExecuteId !== null) {
      const url = await resolveNamespaceViaHost(currentExecuteId, name);
      if (url !== null) {
        urlSpecs.set(name, { url });
        return await rawImport(url);
      }
    }
    throw new Error(`Cannot find module '${name}'`);
  })();
  urlPromiseCache.set(name, p);
  p.catch(() => void 0);
  return p;
}
async function handleExecute(msg) {
  const { code, executeId } = msg;
  let lateTerminator = null;
  const taskSuccess = (value) => {
    if (lateTerminator === null) lateTerminator = { kind: "success", value };
    throw new TaskSuccessSignal(value);
  };
  const taskFail = (message) => {
    if (lateTerminator === null) lateTerminator = { kind: "fail", message };
    throw new TaskFailSignal(message);
  };
  const bridge = new BridgeChannel(executeId);
  activeBridge = bridge;
  currentExecuteId = executeId;
  const injected = {
    taskSuccess,
    taskFail,
    console: makeConsole(executeId),
    // Node-fs-style ergonomic wrapper around the bridged proxy. The
    // agent can write `await fs.read(path, 'utf8')` to get a string
    // back, or `await fs.write(path, 'hello')` to encode-and-write —
    // matches the conventional Node fs surface they were trained on.
    // Bytes-form still works unchanged. The wrapper proxies all
    // other methods through to the bridged fs.
    fs: wrapAgentFs(bridge.build("fs", FS_METHODS)),
    cache: bridge.build("cache", CACHE_METHODS),
    // Always present in the agent's scope — set to the validated task
    // input when the host forwarded one, else `undefined`. Mirrors the
    // eval-runtime behavior so `const value = inputs` never throws a
    // ReferenceError just because the task had no inputs.
    inputs: msg.inputs,
    // Lazy loader for URL-shipped registrations. The agent's emitted
    // code calls this via the rewriter's `await __load('name')`
    // expansion of `import { ... } from 'name'`. First call per name
    // per worker lifetime fires the dynamic import; subsequent calls
    // hit the per-name promise cache.
    __load
  };
  if (configured !== null) {
    for (const fnName of configured.fns) {
      if (fnName in injected) continue;
      injected[fnName] = bridge.buildFn(fnName);
    }
    for (const ns of configured.namespaces) {
      if (ns.name in injected) continue;
      injected[ns.name] = bridge.buildNamespace(ns.name, ns.members);
    }
    for (const cls of configured.classes) {
      if (cls.name in injected) continue;
      injected[cls.name] = bridge.buildClass(cls);
    }
  }
  const __modules = {};
  const __registered = {};
  if (configured !== null) {
    for (const fnName of configured.fns) __registered[fnName] = bridge.buildFn(fnName);
    for (const ns of configured.namespaces)
      __registered[ns.name] = bridge.buildNamespace(ns.name, ns.members);
    for (const cls of configured.classes) __registered[cls.name] = bridge.buildClass(cls);
  }
  if (msg.helpers !== void 0 && msg.helpers.length > 0) {
    try {
      for (const h of msg.helpers) {
        const fn = new AsyncFunction("__exports", "__modules", "__registered", "__load", h.body);
        const exports$1 = {};
        await fn(exports$1, __modules, __registered, __load);
        __modules[h.path] = exports$1;
      }
    } catch (e) {
      activeBridge = null;
      currentExecuteId = null;
      post({
        type: "result",
        executeId,
        outcome: { kind: "continue" },
        error: serializeError(e)
      });
      return;
    }
  }
  injected.__modules = __modules;
  const names = Object.keys(injected);
  const values = names.map((n) => injected[n]);
  let outcome = { kind: "continue" };
  let error = null;
  try {
    const fn = new AsyncFunction(...names, code);
    await fn(...values);
  } catch (e) {
    if (e instanceof TaskSuccessSignal) {
      outcome = { kind: "success", value: e.value };
    } else if (e instanceof TaskFailSignal) {
      outcome = { kind: "fail", message: e.message };
    } else {
      error = serializeError(e);
    }
  }
  if (outcome.kind === "continue" && error === null && bridge.pendingCount > 0) {
    const onUnhandled = (ev) => {
      const reason = ev.reason;
      if (reason instanceof TaskSuccessSignal || reason instanceof TaskFailSignal) {
        ev.preventDefault();
      }
    };
    self.addEventListener("unhandledrejection", onUnhandled);
    try {
      await bridge.drain(2e3);
    } finally {
      self.removeEventListener("unhandledrejection", onUnhandled);
    }
    if (lateTerminator !== null) {
      error = serializeError(makeMissingAwaitError(lateTerminator));
    }
  }
  bridge.cancelPending(makeCancelledError("execute settled with pending bridge calls"));
  activeBridge = null;
  currentExecuteId = null;
  post({ type: "result", executeId, outcome, error });
}
function makeMissingAwaitError(late) {
  const kind = late.kind === "success" ? "taskSuccess" : "taskFail";
  const e = new Error(
    `${kind}() was called from an async function that wasn't awaited at the top level \u2014 the terminator fired AFTER ts_action returned, so this turn produced no observable outcome. Add \`await\` before the call (e.g. \`await generateReport()\`) so the terminator unwinds before the action returns. If you genuinely meant to fire-and-forget, prefix the call with \`void\` (the standard JS/TS idiom for intentionally discarding a Promise).`
  );
  e.name = "MissingAwaitError";
  return e;
}
function makeCancelledError(message) {
  const e = new Error(message);
  e.name = "CancelledError";
  return e;
}
self.addEventListener("message", (ev) => {
  const msg = ev.data;
  if (msg?.type === "configure") {
    handleConfigure(msg);
    return;
  }
  if (msg?.type === "execute") {
    void handleExecute(msg);
    return;
  }
  if (msg?.type === "bridgeResponse") {
    activeBridge?.handleResponse(msg);
    return;
  }
  if (msg?.type === "resolveNamespaceResponse") {
    handleResolveNamespaceResponse(msg);
    return;
  }
});
post({ type: "ready" });
//# sourceMappingURL=worker.js.map
//# sourceMappingURL=worker.js.map