import { realConsole, pushArgs, reflectBoundToReal } from './chunk-RDWADUN6.js';
import { AsyncLocalStorage } from 'async_hooks';

var als = new AsyncLocalStorage();
var installed = false;
function installConsoleProxy() {
  if (installed) return;
  installed = true;
  globalThis.console = new Proxy(realConsole, {
    get(target, prop, receiver) {
      if (prop === "log" || prop === "warn" || prop === "error" || prop === "info") {
        const level = prop;
        return (...args) => {
          const t = als.getStore();
          if (t !== void 0) {
            pushArgs(t, level, args);
            if (t.passConsole) target[level](...args);
          } else {
            target[level](...args);
          }
        };
      }
      return reflectBoundToReal(target, prop, receiver);
    }
  });
}
function runWithCapture(target, fn) {
  return als.run(target, fn);
}

export { installConsoleProxy, runWithCapture };
//# sourceMappingURL=chunk-AD24MQXN.js.map
//# sourceMappingURL=chunk-AD24MQXN.js.map