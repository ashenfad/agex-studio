import { installConsoleProxy, runWithCapture } from '../chunk-AD24MQXN.js';
import { makeHostFnContext } from '../chunk-RDWADUN6.js';
import { prepareScript } from '../chunk-37F76RJV.js';
import { wrapAgentFs } from '../chunk-ZUEX3GXN.js';
import '../chunk-ZDNM4VPR.js';
import { CancelledError, isTaskControlError, TaskFailError } from '../chunk-V7QM2ZJ3.js';
import tsBlankSpace from 'ts-blank-space';

var AsyncFunction = Object.getPrototypeOf(async () => void 0).constructor;
function evalRuntime(opts = {}) {
  installConsoleProxy();
  let policy = null;
  let resolver;
  const timeoutMs = opts.timeoutMs ?? 5e3;
  const urlSpecs = /* @__PURE__ */ new Map();
  const urlPromiseCache = /* @__PURE__ */ new Map();
  function __load(name) {
    const cached = urlPromiseCache.get(name);
    if (cached !== void 0) return cached;
    const spec = urlSpecs.get(name);
    if (spec !== void 0) {
      const p2 = (async () => {
        try {
          const mod = await import(spec.url);
          const value = spec.key === void 0 ? mod : mod[spec.key];
          if (value === void 0) {
            const e = new Error(
              `Could not load registered module '${name}' (${spec.url}): module has no '${spec.key}' export (named exports: ${Object.keys(mod).join(", ") || "<none>"})`
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
      if (resolver !== void 0) {
        let url = null;
        try {
          url = await Promise.resolve(resolver(name));
        } catch {
          url = null;
        }
        if (url !== null) {
          urlSpecs.set(name, { url, key: void 0 });
          return await import(url);
        }
      }
      throw new Error(`Cannot find module '${name}'`);
    })();
    urlPromiseCache.set(name, p);
    p.catch(() => void 0);
    return p;
  }
  return {
    async init(p, initOpts = {}) {
      policy = p;
      resolver = initOpts.namespaceResolver;
      urlSpecs.clear();
      urlPromiseCache.clear();
      for (const [name, reg] of p.fns) {
        if (reg.url !== void 0) urlSpecs.set(name, { url: reg.url, key: reg.export ?? name });
      }
      for (const [name, reg] of p.namespaces) {
        if (reg.url !== void 0) urlSpecs.set(name, { url: reg.url, key: reg.export });
      }
      for (const [name, reg] of p.classes) {
        if (reg.url !== void 0) urlSpecs.set(name, { url: reg.url, key: reg.export ?? name });
      }
    },
    async execute(code, ctx) {
      if (policy === null) {
        throw new Error("evalRuntime: execute() called before init()");
      }
      const outputs = [];
      const passConsole = opts.passConsole === true;
      let outcome = { kind: "continue" };
      let lateTerminator = null;
      let bodySettled = false;
      const recordLate = (slot) => {
        if (lateTerminator === null) lateTerminator = slot;
      };
      const taskSuccess = (value) => {
        recordLate({ kind: "success", value });
        if (bodySettled) return void 0;
        throw new TaskFailErrorButForSuccess(value);
      };
      const taskFail = (message) => {
        recordLate({ kind: "fail", message });
        if (bodySettled) return void 0;
        throw new TaskFailError(message);
      };
      const __agexBodyDone = () => {
        bodySettled = true;
      };
      const injected = {
        taskSuccess,
        taskFail,
        cache: ctx.cache,
        // Node-fs-style ergonomic wrapper. The agent can write
        // `await fs.read(path, 'utf8')` to get a string back, or
        // `await fs.write(path, 'hello')` to encode-and-write —
        // matches the conventional Node fs surface they were
        // trained on. Bytes-form still works unchanged.
        fs: wrapAgentFs(ctx.fs),
        // No `console` injection — the global ALS-gated proxy (installed
        // in `evalRuntime()`) captures `console.log` etc. from the
        // AsyncFunction body AND from any registered host fn dispatched
        // on this call chain, all routed via the same `runWithCapture`
        // context below.
        inputs: ctx.inputs,
        // Lazy loader for URL-shipped registrations. The agent's
        // emitted code calls this via the rewriter's
        // `await __load('name')` expansion of
        // `import { ... } from 'name'`. First call per name per
        // runtime lifetime fires the dynamic import; subsequent calls
        // hit the per-name promise cache.
        __load,
        __agexBodyDone
      };
      const start = performance.now();
      let error = null;
      const ac = new AbortController();
      let cachedHostCtx = null;
      const getHostCtx = () => {
        if (cachedHostCtx === null) {
          cachedHostCtx = makeHostFnContext({ outputs, signal: ac.signal, passConsole });
        }
        return cachedHostCtx;
      };
      for (const [name, reg] of policy.fns) {
        if (reg.fn === void 0) continue;
        if (reg.wantsContext === true) {
          const fn = reg.fn;
          injected[name] = (...args) => fn(...args, getHostCtx());
        } else {
          injected[name] = reg.fn;
        }
      }
      for (const [name, reg] of policy.namespaces) {
        if (reg.target !== void 0) injected[name] = reg.target;
      }
      for (const [name, reg] of policy.classes) {
        if (reg.cls !== void 0) injected[name] = reg.cls;
      }
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const linkedAbort = () => ac.abort();
      ctx.signal.addEventListener("abort", linkedAbort);
      try {
        const erased = tsBlankSpace(code);
        const registeredValues = /* @__PURE__ */ new Map();
        for (const [n, reg] of policy.fns) {
          if (reg.fn !== void 0) registeredValues.set(n, reg.fn);
        }
        for (const [n, reg] of policy.namespaces) {
          if (reg.target !== void 0) registeredValues.set(n, reg.target);
        }
        for (const [n, reg] of policy.classes) {
          if (reg.cls !== void 0) registeredValues.set(n, reg.cls);
        }
        const urlNames = new Set(urlSpecs.keys());
        const prepared = await prepareScript(erased, ctx.fs, registeredValues, {
          urlNames,
          load: __load
        });
        injected.__modules = prepared.modules;
        const names = Object.keys(injected);
        const annotated = `try {
${prepared.code}
} finally { __agexBodyDone() }
//# sourceURL=<ts_action>
`;
        const fn = new AsyncFunction(...names, annotated);
        await runWithCapture({ outputs, passConsole }, async () => {
          const userPromise = fn(...names.map((n) => injected[n]));
          const cancellation = new Promise((_, reject) => {
            ac.signal.addEventListener(
              "abort",
              () => reject(new CancelledError(`evalRuntime: aborted after ${timeoutMs}ms`))
            );
          });
          await Promise.race([userPromise, cancellation]);
        });
      } catch (e) {
        if (e instanceof TaskFailErrorButForSuccess) {
          outcome = { kind: "success", value: e.value };
        } else if (isTaskControlError(e)) {
          if (e.name === "TaskFailError") outcome = { kind: "fail", message: e.message };
          else if (e.name === "CancelledError") error = e;
        } else {
          error = e instanceof Error ? e : new Error(String(e));
        }
      } finally {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", linkedAbort);
      }
      if (outcome.kind === "continue" && error === null && !ac.signal.aborted) {
        for (let i = 0; i < 16 && lateTerminator === null; i++) {
          await Promise.resolve();
        }
        if (lateTerminator !== null) {
          error = makeMissingAwaitError(lateTerminator);
        }
      }
      return {
        outcome,
        outputs,
        error,
        elapsedMs: performance.now() - start
      };
    },
    async dispose() {
      policy = null;
    }
  };
}
function makeMissingAwaitError(late) {
  const kind = late.kind === "success" ? "taskSuccess" : late.kind === "fail" ? "taskFail" : "task terminator";
  const e = new Error(
    `${kind}() was called from an async function that wasn't awaited at the top level \u2014 the terminator fired AFTER ts_action returned, so this turn produced no observable outcome. Add \`await\` before the call (e.g. \`await generateReport()\`) so the terminator unwinds before the action returns. If you genuinely meant to fire-and-forget, prefix the call with \`void\` (the standard JS/TS idiom for intentionally discarding a Promise).`
  );
  e.name = "MissingAwaitError";
  return e;
}
var TaskFailErrorButForSuccess = class extends Error {
  constructor(value) {
    super("taskSuccess");
    this.value = value;
    this.name = "TaskSuccessSignal";
  }
  value;
};

export { evalRuntime };
//# sourceMappingURL=eval.js.map
//# sourceMappingURL=eval.js.map