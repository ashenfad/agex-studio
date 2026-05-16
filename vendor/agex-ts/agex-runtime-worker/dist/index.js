import { INSTANCE_HANDLE_KEY } from './chunk-WYALNYZL.js';
import tsBlankSpace from 'ts-blank-space';
import { installConsoleProxy, runWithCapture, makeHostFnContext } from 'agex-ts/console-capture';
import { CancelledError } from 'agex-ts/errors';
import { prepareScriptForWire } from 'agex-ts/module-loader';
import { memberAllowed } from 'agex-ts/policy';

var defaultTransform = (code) => tsBlankSpace(code);
var FS_METHODS = /* @__PURE__ */ new Set([
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
]);
var CACHE_METHODS = /* @__PURE__ */ new Set(["set", "get", "has", "delete", "keys"]);
function workerRuntime(opts = {}) {
  installConsoleProxy();
  const transform = opts.transform ?? defaultTransform;
  const timeoutMs = opts.timeoutMs ?? 5e3;
  const workerUrl = opts.workerUrl ?? new URL("./worker.js", import.meta.url);
  let worker = null;
  let readyPromise = null;
  let nextExecuteId = 1;
  let disposed = false;
  let activeExecute = null;
  let policyRef = null;
  let configurePayload = null;
  let namespaceResolver;
  function spawn() {
    const w = new Worker(workerUrl, { type: "module" });
    worker = w;
    readyPromise = new Promise((resolve, reject) => {
      const onMsg = (ev) => {
        if (ev.data?.type === "ready") {
          w.removeEventListener("message", onMsg);
          w.removeEventListener("error", onErr);
          if (configurePayload !== null) w.postMessage(configurePayload);
          resolve();
        }
      };
      const onErr = (ev) => {
        w.removeEventListener("message", onMsg);
        w.removeEventListener("error", onErr);
        reject(new Error(`worker failed during boot: ${ev.message}`));
      };
      w.addEventListener("message", onMsg);
      w.addEventListener("error", onErr);
    });
  }
  function killWorker() {
    if (worker !== null) {
      worker.terminate();
      worker = null;
      readyPromise = null;
    }
  }
  return {
    async init(policy, initOpts = {}) {
      policyRef = policy;
      namespaceResolver = initOpts.namespaceResolver;
      configurePayload = buildConfigure(
        policy,
        opts.routeFetchToVfs,
        namespaceResolver !== void 0
      );
    },
    async execute(code, ctx) {
      const start = performance.now();
      if (ctx.signal.aborted) {
        return {
          outcome: { kind: "continue" },
          outputs: [],
          error: new CancelledError(),
          elapsedMs: 0
        };
      }
      if (disposed) {
        throw new Error("workerRuntime: execute() called after dispose()");
      }
      if (activeExecute !== null) {
        throw new Error(
          "workerRuntime: concurrent execute() not supported \u2014 previous emission is still running. The agent loop calls execute() sequentially per emission; if you hit this, the embedder is calling the adapter directly from multiple concurrent task calls against the same runtime instance."
        );
      }
      activeExecute = { settle: () => {
      } };
      let transformed;
      try {
        transformed = await transform(code);
      } catch (e) {
        activeExecute = null;
        return {
          outcome: { kind: "continue" },
          outputs: [],
          error: e instanceof Error ? e : new Error(String(e)),
          elapsedMs: performance.now() - start
        };
      }
      let preparedCode;
      let helpers;
      try {
        const registeredNames = /* @__PURE__ */ new Set();
        const urlNames = /* @__PURE__ */ new Set();
        if (policyRef !== null) {
          for (const [n, reg] of policyRef.fns) {
            registeredNames.add(n);
            if (reg.url !== void 0) urlNames.add(n);
          }
          for (const [n, reg] of policyRef.namespaces) {
            registeredNames.add(n);
            if (reg.url !== void 0) urlNames.add(n);
          }
          for (const [n, reg] of policyRef.classes) {
            registeredNames.add(n);
            if (reg.url !== void 0) urlNames.add(n);
          }
        }
        const prepared = await prepareScriptForWire(
          transformed,
          ctx.fs,
          transform,
          registeredNames,
          urlNames
        );
        preparedCode = prepared.code;
        helpers = prepared.helpers;
      } catch (e) {
        activeExecute = null;
        return {
          outcome: { kind: "continue" },
          outputs: [],
          error: e instanceof Error ? e : new Error(String(e)),
          elapsedMs: performance.now() - start
        };
      }
      if (worker === null) spawn();
      const w = worker;
      const ready = readyPromise;
      try {
        await ready;
      } catch (e) {
        activeExecute = null;
        killWorker();
        return {
          outcome: { kind: "continue" },
          outputs: [],
          error: e instanceof Error ? e : new Error(String(e)),
          elapsedMs: performance.now() - start
        };
      }
      const executeId = nextExecuteId++;
      const outputs = [];
      const instances = /* @__PURE__ */ new Map();
      const instanceClasses = /* @__PURE__ */ new Map();
      let nextInstanceId = 1;
      let outcome = { kind: "continue" };
      let error = null;
      await new Promise((resolve) => {
        let settled = false;
        const settle = (reason) => {
          if (settled) return;
          settled = true;
          if (reason !== void 0) error = reason;
          w.removeEventListener("message", onMsg);
          w.removeEventListener("error", onErr);
          ctx.signal.removeEventListener("abort", onAbort);
          clearTimeout(timer);
          activeExecute = null;
          instances.clear();
          instanceClasses.clear();
          resolve();
        };
        activeExecute = { settle };
        const onMsg = (ev) => {
          const m = ev.data;
          if (m?.type === "output" && m.executeId === executeId) {
            outputs.push(m.part);
            return;
          }
          if (m?.type === "bridgeCall" && m.executeId === executeId) {
            void handleBridgeCall(m, ctx, policyRef, instances, w, outputs);
            return;
          }
          if (m?.type === "newInstance" && m.executeId === executeId) {
            void handleNewInstance(
              m,
              policyRef,
              instances,
              instanceClasses,
              () => nextInstanceId++,
              w
            );
            return;
          }
          if (m?.type === "instanceCall" && m.executeId === executeId) {
            void handleInstanceCall(m, instances, instanceClasses, w);
            return;
          }
          if (m?.type === "resolveNamespace" && m.executeId === executeId) {
            void handleResolveNamespace(m, namespaceResolver, w);
            return;
          }
          if (m?.type === "result" && m.executeId === executeId) {
            outcome = m.outcome;
            if (m.error !== null) error = rebuildError(m.error);
            settle();
          }
        };
        const onErr = (ev) => {
          error = new Error(`worker error: ${ev.message}`);
          killWorker();
          settle();
        };
        const onAbort = () => {
          error = new CancelledError();
          killWorker();
          settle();
        };
        const timer = setTimeout(() => {
          error = new Error(`emission exceeded ${timeoutMs}ms timeout`);
          killWorker();
          settle();
        }, timeoutMs);
        w.addEventListener("message", onMsg);
        w.addEventListener("error", onErr);
        ctx.signal.addEventListener("abort", onAbort);
        const out = {
          type: "execute",
          code: preparedCode,
          executeId,
          ...helpers.length > 0 && { helpers },
          ...ctx.inputs !== void 0 && { inputs: ctx.inputs },
          ...ctx.emissionId !== void 0 && { emissionId: ctx.emissionId }
        };
        w.postMessage(out);
      });
      return {
        outcome,
        outputs,
        error,
        elapsedMs: performance.now() - start
      };
    },
    async dispose() {
      disposed = true;
      if (activeExecute !== null) {
        activeExecute.settle(new CancelledError("runtime disposed"));
      }
      killWorker();
    },
    primerAddendum() {
      const route = opts.routeFetchToVfs;
      if (route === void 0 || route === false) return void 0;
      const scope = Array.isArray(route) ? `under these prefixes: ${route.map((p) => `\`${p}\``).join(", ")}` : "for any path-absolute URL";
      const examplePath = Array.isArray(route) ? `${route[0] ?? "/"}foo.csv` : "/data/foo.csv";
      const arrayCaveat = Array.isArray(route) ? "  Path-absolute URLs that DO NOT match a listed prefix pass through to the network unchanged \u2014 that namespace is the host's, not yours." : "";
      return [
        "## Filesystem is fetch-accessible",
        "",
        `This runtime routes \`fetch(...)\` calls to your VFS ${scope} (GET/HEAD only).  That means library functions that internally call \`fetch\` \u2014 Arquero's \`loadCSV\`, Plotly's loaders, JSON/URL fetchers in any data lib \u2014 read from the same VFS your \`fs.read\` reaches, without an explicit bytes-shuttling step.  Mental model: when a registered library asks you for a "URL", a path like \`${examplePath}\` resolves against the VFS first.  Absolute URLs (\`https://...\`) and relative URLs (\`./foo\`) are unaffected \u2014 they go to the network as usual.${arrayCaveat}`
      ].join("\n");
    }
  };
}
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
  return { name: "Error", message: String(e) };
}
async function handleBridgeCall(msg, ctx, policy, instances, w, outputs) {
  const { executeId, callId } = msg;
  let value;
  let error = null;
  try {
    value = await dispatch(msg, ctx, policy, instances, outputs);
  } catch (e) {
    error = serializeError(e);
  }
  try {
    if (error !== null) {
      w.postMessage({ type: "bridgeResponse", executeId, callId, ok: false, error });
    } else {
      w.postMessage({ type: "bridgeResponse", executeId, callId, ok: true, value });
    }
  } catch (cloneErr) {
    try {
      w.postMessage({
        type: "bridgeResponse",
        executeId,
        callId,
        ok: false,
        error: serializeError(cloneErr)
      });
    } catch {
    }
  }
}
async function dispatch(msg, ctx, policy, instances, outputs) {
  const { target, method } = msg;
  const args = unpackArgs(msg.args, instances);
  switch (target) {
    case "fs":
    case "cache": {
      const allowed = target === "fs" ? FS_METHODS : CACHE_METHODS;
      if (!allowed.has(method)) {
        throw new Error(`workerRuntime bridge: method '${method}' not allowed on '${target}'`);
      }
      const surface = target === "fs" ? ctx.fs : ctx.cache;
      const fn = surface[method];
      if (typeof fn !== "function") {
        throw new Error(
          `workerRuntime bridge: '${target}.${method}' is not callable on this context`
        );
      }
      return await fn.apply(surface, args);
    }
    case "fn": {
      if (policy === null) {
        throw new Error("workerRuntime bridge: 'fn' call before init() / policy unavailable");
      }
      const reg = policy.fns.get(method);
      if (reg === void 0) {
        throw new Error(`workerRuntime bridge: no registered fn named '${method}'`);
      }
      if (reg.fn === void 0) {
        throw new Error(
          `workerRuntime bridge: fn '${method}' is URL-shipped; should not see RPC traffic`
        );
      }
      const fn = reg.fn;
      return await runWithCapture({ outputs, passConsole: false }, async () => {
        if (reg.wantsContext === true) {
          const hostCtx = makeHostFnContext({ outputs, signal: ctx.signal });
          return await fn(...args, hostCtx);
        }
        return await fn(...args);
      });
    }
    case "namespace": {
      if (policy === null) {
        throw new Error("workerRuntime bridge: 'namespace' call before init() / policy unavailable");
      }
      const subject = msg.subject;
      if (subject === void 0) {
        throw new Error("workerRuntime bridge: 'namespace' call missing required `subject`");
      }
      const reg = policy.namespaces.get(subject);
      if (reg === void 0) {
        throw new Error(`workerRuntime bridge: no registered namespace named '${subject}'`);
      }
      if (reg.target === void 0) {
        throw new Error(
          `workerRuntime bridge: namespace '${subject}' is URL-shipped; should not see RPC traffic`
        );
      }
      const visible = visibleNamespaceMembers(reg);
      if (!visible.has(method)) {
        throw new Error(
          `workerRuntime bridge: member '${method}' not visible on namespace '${subject}'`
        );
      }
      const target2 = reg.target;
      const fn = target2[method];
      if (typeof fn !== "function") {
        throw new Error(
          `workerRuntime bridge: '${subject}.${method}' is not callable (non-function members aren't bridged in this PR)`
        );
      }
      return await fn.apply(target2, args);
    }
    case "cls": {
      if (policy === null) {
        throw new Error("workerRuntime bridge: 'cls' call before init() / policy unavailable");
      }
      const subject = msg.subject;
      if (subject === void 0) {
        throw new Error("workerRuntime bridge: 'cls' call missing required `subject`");
      }
      const reg = policy.classes.get(subject);
      if (reg === void 0) {
        throw new Error(`workerRuntime bridge: no registered class named '${subject}'`);
      }
      if (reg.cls === void 0) {
        throw new Error(
          `workerRuntime bridge: class '${subject}' is URL-shipped; should not see RPC traffic`
        );
      }
      const visible = visibleClassStatics(reg);
      if (!visible.has(method)) {
        throw new Error(
          `workerRuntime bridge: static member '${method}' not visible on class '${subject}'`
        );
      }
      const cls = reg.cls;
      const fn = cls[method];
      if (typeof fn !== "function") {
        throw new Error(
          `workerRuntime bridge: '${subject}.${method}' is not callable (non-function statics aren't bridged in this PR)`
        );
      }
      return await fn.apply(cls, args);
    }
  }
}
async function handleNewInstance(msg, policy, instances, instanceClasses, nextId, w) {
  const { executeId, callId, clsName } = msg;
  let value = null;
  let error = null;
  try {
    if (policy === null) {
      throw new Error("workerRuntime bridge: 'newInstance' before init() / policy unavailable");
    }
    const reg = policy.classes.get(clsName);
    if (reg === void 0) {
      throw new Error(`workerRuntime bridge: no registered class named '${clsName}'`);
    }
    if (reg.constructable === false) {
      throw new Error(
        `workerRuntime bridge: class '${clsName}' is registered with constructable: false`
      );
    }
    if (reg.cls === void 0) {
      throw new Error(
        `workerRuntime bridge: class '${clsName}' is URL-shipped; should not see RPC traffic`
      );
    }
    const Cls = reg.cls;
    const args = unpackArgs(msg.args, instances);
    const instance = new Cls(...args);
    const instanceId = nextId();
    instances.set(instanceId, instance);
    instanceClasses.set(instanceId, reg);
    value = { instanceId };
  } catch (e) {
    error = serializeError(e);
  }
  postBridgeResponse(w, executeId, callId, value, error);
}
async function handleResolveNamespace(msg, resolver, w) {
  const { executeId, callId, specifier } = msg;
  let url = null;
  if (resolver !== void 0) {
    try {
      url = await Promise.resolve(resolver(specifier)) ?? null;
    } catch {
      url = null;
    }
  }
  try {
    w.postMessage({ type: "resolveNamespaceResponse", executeId, callId, url });
  } catch {
  }
}
async function handleInstanceCall(msg, instances, instanceClasses, w) {
  const { executeId, callId, instanceId, method } = msg;
  let value;
  let error = null;
  try {
    const instance = instances.get(instanceId);
    const reg = instanceClasses.get(instanceId);
    if (instance === void 0 || reg === void 0) {
      throw new Error(
        `workerRuntime bridge: no live instance with id ${instanceId} (was it created in a different emission?)`
      );
    }
    const visible = visibleClassInstanceMethods(reg);
    if (!visible.has(method)) {
      throw new Error(
        `workerRuntime bridge: instance method '${method}' not visible on class '${reg.name}'`
      );
    }
    const target = instance;
    const fn = target[method];
    if (typeof fn !== "function") {
      throw new Error(`workerRuntime bridge: instance method '${method}' is not callable`);
    }
    const args = unpackArgs(msg.args, instances);
    value = await fn.apply(target, args);
  } catch (e) {
    error = serializeError(e);
  }
  postBridgeResponse(w, executeId, callId, value, error);
}
function unpackArgs(args, instances) {
  const visited = /* @__PURE__ */ new WeakSet();
  const unpack = (v) => {
    if (v === null || typeof v !== "object") return v;
    if (Object.getPrototypeOf(v) === Object.prototype) {
      const handle = v[INSTANCE_HANDLE_KEY];
      if (handle !== void 0 && typeof handle === "object" && handle !== null && typeof handle.id === "number") {
        const id = handle.id;
        const inst = instances.get(id);
        if (inst === void 0) {
          throw new Error(
            `workerRuntime bridge: stale instance handle id=${id} (created in a prior emission, or fabricated)`
          );
        }
        return inst;
      }
    }
    if (visited.has(v)) return v;
    visited.add(v);
    if (Array.isArray(v)) return v.map(unpack);
    if (Object.getPrototypeOf(v) !== Object.prototype) return v;
    const out = {};
    for (const k of Object.keys(v)) {
      out[k] = unpack(v[k]);
    }
    return out;
  };
  return args.map(unpack);
}
function postBridgeResponse(w, executeId, callId, value, error) {
  try {
    if (error !== null) {
      w.postMessage({ type: "bridgeResponse", executeId, callId, ok: false, error });
    } else {
      w.postMessage({ type: "bridgeResponse", executeId, callId, ok: true, value });
    }
  } catch (cloneErr) {
    try {
      w.postMessage({
        type: "bridgeResponse",
        executeId,
        callId,
        ok: false,
        error: serializeError(cloneErr)
      });
    } catch {
    }
  }
}
function buildConfigure(policy, routeFetchToVfs, hasNamespaceResolver) {
  const fns = [];
  const namespaces = [];
  const classes = [];
  const urlModules = [];
  for (const [name, reg] of policy.fns) {
    if (reg.url !== void 0) {
      urlModules.push(urlSpec(name, reg.url, reg.export ?? name));
      continue;
    }
    fns.push(name);
  }
  for (const [name, reg] of policy.namespaces) {
    if (reg.url !== void 0) {
      urlModules.push(urlSpec(name, reg.url, reg.export));
      continue;
    }
    if (reg.target === void 0) continue;
    const visible = visibleNamespaceMembers(reg);
    const target = reg.target;
    const callable = [...visible].filter((m) => {
      const v = target[m];
      return typeof v === "function";
    });
    namespaces.push({ name, members: callable });
  }
  for (const [name, reg] of policy.classes) {
    if (reg.url !== void 0) {
      urlModules.push(urlSpec(name, reg.url, reg.export ?? name));
      continue;
    }
    if (reg.cls === void 0) continue;
    const cls = reg.cls;
    const instanceMethods = [...visibleClassInstanceMethods(reg)].filter((m) => {
      return typeof cls.prototype[m] === "function";
    });
    const staticMethods = [...visibleClassStatics(reg)].filter((m) => {
      return typeof cls[m] === "function";
    });
    classes.push({ name, instanceMethods, staticMethods });
  }
  return {
    type: "configure",
    fns,
    namespaces,
    classes,
    urlModules,
    ...routeFetchToVfs !== void 0 && routeFetchToVfs !== false && { routeFetchToVfs },
    ...hasNamespaceResolver && { hasNamespaceResolver: true }
  };
}
function urlSpec(name, url, exportName) {
  return exportName !== void 0 ? { name, url, export: exportName } : { name, url };
}
function visibleClassInstanceMethods(reg) {
  if (reg.cls === void 0) return /* @__PURE__ */ new Set();
  return walkPrototypeChain(reg.cls.prototype, reg.include, reg.exclude);
}
function visibleClassStatics(reg) {
  const seen = /* @__PURE__ */ new Set();
  if (reg.cls === void 0) return seen;
  const skip = /* @__PURE__ */ new Set(["prototype", "name", "length"]);
  const test = (k) => {
    if (skip.has(k)) return false;
    return memberAllowed(k, reg.include, reg.exclude);
  };
  let level = reg.cls;
  while (level !== null && level !== Function.prototype && level !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(level)) {
      if (test(k)) seen.add(k);
    }
    level = Object.getPrototypeOf(level);
  }
  return seen;
}
function visibleNamespaceMembers(reg) {
  if (reg.target === void 0) return /* @__PURE__ */ new Set();
  return walkPrototypeChain(reg.target, reg.include, reg.exclude);
}
function walkPrototypeChain(root, include, exclude) {
  const seen = /* @__PURE__ */ new Set();
  const test = (k) => {
    if (k === "constructor") return false;
    return memberAllowed(k, include, exclude);
  };
  for (const k of Object.getOwnPropertyNames(root)) {
    if (test(k)) seen.add(k);
  }
  let proto = Object.getPrototypeOf(root);
  while (proto !== null && proto !== Object.prototype) {
    for (const k of Object.getOwnPropertyNames(proto)) {
      if (test(k)) seen.add(k);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return seen;
}

export { defaultTransform, workerRuntime };
//# sourceMappingURL=index.js.map
//# sourceMappingURL=index.js.map