import { RegistrationError } from './chunk-V7QM2ZJ3.js';
import { globMatch } from 'termish-ts/glob';

var NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
var RELAXED_NAME_RE = /^[^\s\p{Cc}]+$/u;
var PolicyBuilder = class {
  #fns = /* @__PURE__ */ new Map();
  #classes = /* @__PURE__ */ new Map();
  #namespaces = /* @__PURE__ */ new Map();
  #skills = /* @__PURE__ */ new Map();
  #terminals = /* @__PURE__ */ new Map();
  // -- Mutators -----------------------------------------------------------
  registerFn(name, opts) {
    this.#assertNameValid(name, "fn", opts.url !== void 0);
    this.#assertNameAvailable(name);
    this.#assertHostXorUrl(name, "fn", opts.fn !== void 0, opts.url);
    if (opts.url !== void 0 && opts.paramsSchema !== void 0) {
      throw new RegistrationError(
        `fn '${name}': paramsSchema can't be combined with { url } \u2014 URL-shipped fns are called natively in the worker realm where the host-side schema check doesn't apply. If you need validation, fold it into the imported function.`
      );
    }
    if (opts.url !== void 0 && opts.wantsContext === true) {
      throw new RegistrationError(
        `fn '${name}': wantsContext can't be combined with { url } \u2014 URL-shipped fns are called natively in the worker realm; host-side ctx injection has no hook there.`
      );
    }
    this.#fns.set(name, omitUndefined({ kind: "fn", name, ...opts }));
  }
  registerCls(name, opts) {
    this.#assertNameValid(name, "cls", opts.url !== void 0);
    this.#assertNameAvailable(name);
    this.#assertHostXorUrl(name, "cls", opts.cls !== void 0, opts.url);
    if (opts.url !== void 0) {
      this.#assertNoFiltersWithUrl(name, "cls", opts);
      if (opts.constructable === false) {
        throw new RegistrationError(
          `cls '${name}': constructable: false can't be combined with { url } \u2014 the URL-shipped class is constructable in the worker realm regardless. Pre-wrap the export in a non-constructable facade if you want the agent locked out.`
        );
      }
    }
    this.#classes.set(name, omitUndefined({ kind: "cls", name, ...opts }));
  }
  registerNamespace(name, opts) {
    this.#assertNameValid(name, "namespace", opts.url !== void 0);
    this.#assertNameAvailable(name);
    this.#assertHostXorUrl(name, "namespace", opts.target !== void 0, opts.url);
    if (opts.url !== void 0) {
      this.#assertNoFiltersWithUrl(name, "namespace", opts);
    }
    this.#namespaces.set(name, omitUndefined({ kind: "namespace", name, ...opts }));
  }
  registerSkill(name, content) {
    this.#assertNameValid(name, "skill", true);
    this.#assertNameAvailable(name);
    if (typeof content !== "string") {
      throw new RegistrationError(`skill ${name}: content must be a string`);
    }
    this.#skills.set(name, { kind: "skill", name, content });
  }
  registerTerminal(name, opts) {
    this.#assertNameValid(name, "terminal");
    this.#assertNameAvailable(name);
    if (opts.description === void 0 || opts.description.length === 0) {
      throw new RegistrationError(`terminal ${name}: description is required`);
    }
    if (typeof opts.handler !== "function") {
      throw new RegistrationError(`terminal ${name}: handler must be a function`);
    }
    this.#terminals.set(
      name,
      omitUndefined({ kind: "terminal", name, ...opts })
    );
  }
  // -- View ---------------------------------------------------------------
  snapshot() {
    return {
      fns: this.#fns,
      classes: this.#classes,
      namespaces: this.#namespaces,
      skills: this.#skills,
      terminals: this.#terminals
    };
  }
  /** Hash-style fingerprint of the current policy. Cheap to compute;
   *  any registration mutation changes the value. The agent uses
   *  this to invalidate cached primer/dependency snapshots. */
  fingerprint() {
    const parts = [];
    for (const m of [this.#fns, this.#classes, this.#namespaces, this.#skills, this.#terminals]) {
      for (const k of [...m.keys()].sort()) parts.push(`${k}@${m.size}`);
    }
    return parts.join("|");
  }
  // -- Internal -----------------------------------------------------------
  #assertNameValid(name, kind, relaxed = false) {
    if (typeof name !== "string" || name.length === 0) {
      throw new RegistrationError(`${kind}: name must be a non-empty string`);
    }
    if (relaxed) {
      if (!RELAXED_NAME_RE.test(name)) {
        throw new RegistrationError(
          `${kind} '${name}': name must be non-empty with no whitespace or control characters. Accepts hyphens, scopes, subpaths, and dots \u2014 e.g. 'apache-arrow', '@scope/pkg', 'interactive-app'.`
        );
      }
      return;
    }
    if (!NAME_RE.test(name)) {
      throw new RegistrationError(
        `${kind} ${name}: name must match /^[A-Za-z_][A-Za-z0-9_]*$/ (valid JS identifier)`
      );
    }
  }
  /** Enforce mutual exclusivity between host-bound and URL-shipped
   *  forms. Exactly one must be present — registering an fn / cls /
   *  namespace with both a live value and a `url` (or with neither)
   *  is a programming error. */
  #assertHostXorUrl(name, kind, hasHost, url) {
    const hasUrl = url !== void 0;
    if (hasHost && hasUrl) {
      throw new RegistrationError(
        `${kind} '${name}': pass either the live value or { url, export? }, not both`
      );
    }
    if (!hasHost && !hasUrl) {
      throw new RegistrationError(
        `${kind} '${name}': missing the registered value (pass a function / class / object, or a { url, export? } spec)`
      );
    }
    if (hasUrl && url.length === 0) {
      throw new RegistrationError(`${kind} '${name}': url must be a non-empty string`);
    }
  }
  /** Per-method visibility filters (`include` / `exclude` /
   *  `configure`) only make sense for host-bound registrations.
   *  URL-shipped modules ship into the worker realm whole — there
   *  is no per-export gating point on the host side. Ban the
   *  combination at registration time so the embedder gets a
   *  clear error instead of silently ignored options. */
  #assertNoFiltersWithUrl(name, kind, opts) {
    const offending = [];
    if (opts.include !== void 0) offending.push("include");
    if (opts.exclude !== void 0) offending.push("exclude");
    if (opts.configure !== void 0) offending.push("configure");
    if (offending.length > 0) {
      throw new RegistrationError(
        `${kind} '${name}': ${offending.join(" / ")} can't be combined with { url } \u2014 URL-shipped registrations are exposed whole. Pre-wrap the export in a thinner module if you need a narrower surface.`
      );
    }
  }
  #assertNameAvailable(name) {
    const found = this.#fns.has(name) && "fn" || this.#classes.has(name) && "cls" || this.#namespaces.has(name) && "namespace" || this.#skills.has(name) && "skill" || this.#terminals.has(name) && "terminal";
    if (found) {
      throw new RegistrationError(`name "${name}" already registered as a ${found}`);
    }
  }
};
function memberAllowed(name, include, exclude) {
  if (exclude !== void 0 && matchesFilter(name, exclude)) return false;
  if (include === void 0) return true;
  return matchesFilter(name, include);
}
function matchesFilter(name, filter) {
  if (typeof filter === "function") return filter(name);
  if (typeof filter === "string") return globMatch(filter, name);
  for (const f of filter) {
    if (globMatch(f, name)) return true;
  }
  return false;
}
function omitUndefined(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== void 0) out[k] = v;
  }
  return out;
}

export { PolicyBuilder, memberAllowed };
//# sourceMappingURL=chunk-MUU37UMN.js.map
//# sourceMappingURL=chunk-MUU37UMN.js.map