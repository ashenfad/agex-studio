import tsBlankSpace from 'ts-blank-space';

// src/runtime/module-loader.ts
var AsyncFunction = Object.getPrototypeOf(async () => void 0).constructor;
async function prepareScript(source, fs, registeredValues = /* @__PURE__ */ new Map(), opts = {}) {
  const urlNames = opts.urlNames ?? /* @__PURE__ */ new Set();
  const registeredNames = /* @__PURE__ */ new Set([...registeredValues.keys(), ...urlNames]);
  const __load = opts.load ?? (async (name) => registeredValues.get(name));
  const prepared = await prepareScriptForWire(source, fs, tsBlankSpace, registeredNames, urlNames);
  if (prepared.helpers.length === 0) return { code: prepared.code, modules: {} };
  const modules = {};
  const __registered = {};
  for (const [k, v] of registeredValues) __registered[k] = v;
  for (const h of prepared.helpers) {
    const fn = new AsyncFunction("__exports", "__modules", "__registered", "__load", h.body);
    const exports$1 = {};
    await fn(exports$1, modules, __registered, __load);
    modules[h.path] = exports$1;
  }
  return { code: prepared.code, modules };
}
async function prepareScriptForWire(source, fs, transform, registeredNames = /* @__PURE__ */ new Set(), urlNames = /* @__PURE__ */ new Set()) {
  const imports = parseImports(source);
  if (imports.length === 0) return { code: source, helpers: [] };
  const helpers = [];
  const compiled = /* @__PURE__ */ new Set();
  const inFlight = /* @__PURE__ */ new Set();
  async function walk(importPath, baseDir) {
    const resolved = resolveVfsPath(importPath, baseDir);
    if (compiled.has(resolved)) return;
    if (inFlight.has(resolved)) {
      throw new Error(
        `module loader: cyclic helper import \u2014 '${resolved}' is already being loaded. Helper cycles are unsupported; refactor the shared bits into a third file.`
      );
    }
    inFlight.add(resolved);
    const sourcePath = await findFile(resolved, fs);
    const bytes = await fs.read(sourcePath);
    const raw = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const stripped = await transform(raw);
    const subImports = parseImports(stripped);
    const dirOfHelper = dirname(sourcePath);
    for (const sub of subImports) {
      if (!isVfsPath(sub.path) && !sub.path.startsWith(".")) continue;
      await walk(sub.path, dirOfHelper);
    }
    const body = compileHelperBody(stripped, sourcePath, dirOfHelper, registeredNames, urlNames);
    helpers.push({ path: resolved, body });
    compiled.add(resolved);
    if (sourcePath !== resolved && !compiled.has(sourcePath)) {
      helpers.push({ path: sourcePath, body: aliasBody(resolved) });
      compiled.add(sourcePath);
    }
    inFlight.delete(resolved);
  }
  for (const imp of imports) {
    if (!isVfsPath(imp.path)) continue;
    await walk(imp.path, "/");
  }
  let out = source;
  for (const imp of [...imports].reverse()) {
    if (isVfsPath(imp.path)) {
      if (imp.isReexport) {
        out = `${out.slice(0, imp.start)}/* re-export skipped */${out.slice(imp.end)}`;
        continue;
      }
      const resolved = resolveVfsPath(imp.path, "/");
      if (!compiled.has(resolved)) continue;
      const replacement2 = rewriteAsLookup(imp.binding, resolved);
      out = out.slice(0, imp.start) + replacement2 + out.slice(imp.end);
      continue;
    }
    if (imp.isReexport) {
      out = `${out.slice(0, imp.start)}/* re-export skipped */${out.slice(imp.end)}`;
      continue;
    }
    const isHostBound = registeredNames.has(imp.path) && !urlNames.has(imp.path);
    const replacement = isHostBound ? rewriteAsRegisteredAccess(imp.binding, imp.path) : rewriteAsUrlLoad(imp.binding, imp.path);
    out = out.slice(0, imp.start) + replacement + out.slice(imp.end);
  }
  return { code: out, helpers };
}
function aliasBody(primaryPath, aliasPath) {
  return `Object.assign(__exports, __modules[${JSON.stringify(primaryPath)}]); return __exports;
`;
}
function compileHelperBody(stripped, sourcePath, dirOfHelper, registeredNames, urlNames) {
  const reexported = rewriteHelperReexports(stripped, dirOfHelper);
  const { code, exportNames } = rewriteHelperExports(reexported);
  const imports = parseImports(code);
  let body = code;
  for (const imp of [...imports].reverse()) {
    if (imp.isReexport) continue;
    if (isVfsPath(imp.path) || imp.path.startsWith(".")) {
      const resolved = resolveVfsPath(imp.path, dirOfHelper);
      const replacement = rewriteAsLookup(imp.binding, resolved);
      body = body.slice(0, imp.start) + replacement + body.slice(imp.end);
      continue;
    }
    if (registeredNames.has(imp.path)) {
      const replacement = urlNames.has(imp.path) ? rewriteAsUrlLoad(imp.binding, imp.path) : rewriteAsRegisteredAccess(imp.binding, imp.path, true);
      body = body.slice(0, imp.start) + replacement + body.slice(imp.end);
    }
  }
  const exportAssignments = exportNames.map((n) => `__exports[${JSON.stringify(n)}] = ${n};`).join("\n");
  return `${body}
${exportAssignments}
return __exports;
//# sourceURL=${sourcePath}
`;
}
function rewriteHelperReexports(code, dirOfHelper) {
  let out = code;
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, inside, path) => {
      const resolved = isVfsPath(path) || path.startsWith(".") ? resolveVfsPath(path, dirOfHelper) : path;
      const key = JSON.stringify(resolved);
      const lines = [];
      for (const part of inside.split(",")) {
        const t = part.trim();
        if (t.length === 0) continue;
        const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
        const sourceName = aliased !== null ? aliased[1] : t;
        const exportName = aliased !== null ? aliased[2] : t;
        lines.push(
          `__exports[${JSON.stringify(exportName)}] = __modules[${key}][${JSON.stringify(sourceName)}];`
        );
      }
      return lines.join("\n");
    }
  );
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, name, path) => {
      const resolved = isVfsPath(path) || path.startsWith(".") ? resolveVfsPath(path, dirOfHelper) : path;
      return `__exports[${JSON.stringify(name)}] = __modules[${JSON.stringify(resolved)}];`;
    }
  );
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s*\*\s*from\s*['"]([^'"]+)['"][ \t]*;?/gm,
    (_m, path) => {
      const resolved = isVfsPath(path) || path.startsWith(".") ? resolveVfsPath(path, dirOfHelper) : path;
      return `Object.assign(__exports, __modules[${JSON.stringify(resolved)}]);`;
    }
  );
  return out;
}
function rewriteHelperExports(code) {
  const exportNames = [];
  let out = code;
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s+default\s+([\s\S]*?)(?=$|\n)/gm,
    (_m, expr) => `__exports.default = ${expr.trim()}`
  );
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s+(async\s+function\b|function\b|class\b)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      if (!exportNames.includes(name)) exportNames.push(name);
      return `${kind} ${name}`;
    }
  );
  out = out.replace(
    /(?<=^|[\n;])[ \t]*export\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gm,
    (_m, kind, name) => {
      if (!exportNames.includes(name)) exportNames.push(name);
      return `${kind} ${name}`;
    }
  );
  out = out.replace(/(?<=^|[\n;])[ \t]*export\s*\{([^}]*)\}[ \t]*;?/gm, (_m, inside) => {
    const lines = [];
    for (const part of inside.split(",")) {
      const t = part.trim();
      if (t.length === 0) continue;
      const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
      if (aliased !== null) {
        const local = aliased[1];
        const exported = aliased[2];
        if (!exportNames.includes(exported)) exportNames.push(exported);
        lines.push(`__exports[${JSON.stringify(exported)}] = ${local};`);
      } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
        if (!exportNames.includes(t)) exportNames.push(t);
      }
    }
    return lines.join("\n");
  });
  return { code: out, exportNames };
}
function parseImports(source) {
  const out = [];
  const importRe = /^[ \t]*import\b((?:[\s\S](?!^[ \t]*(?:import|export)\b))*?)['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
  for (const m of source.matchAll(importRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const middle = (m[1] ?? "").trim();
    const path = m[2] ?? "";
    out.push({
      start,
      end,
      path,
      binding: parseClause(middle),
      isReexport: false
    });
  }
  const reexportRe = /^[ \t]*export\b((?:[\s\S](?!^[ \t]*(?:import|export)\b))*?)\bfrom\b[\s]*['"]([^'"]+)['"][ \t]*;?[ \t]*$/gm;
  for (const m of source.matchAll(reexportRe)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    const path = m[2] ?? "";
    out.push({
      start,
      end,
      path,
      binding: { kind: "sideEffect" },
      isReexport: true
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
function parseClause(clause) {
  const trimmed = clause.replace(/from\s*$/, "").trim();
  if (trimmed.length === 0) return { kind: "sideEffect" };
  const ns = trimmed.match(/^\*\s+as\s+([A-Za-z_$][\w$]*)$/);
  if (ns !== null) return { kind: "namespace", local: ns[1] };
  const mixed = trimmed.match(/^([A-Za-z_$][\w$]*)\s*,\s*\{([\s\S]*)\}$/);
  if (mixed !== null) {
    return {
      kind: "mixed",
      defaultLocal: mixed[1],
      entries: parseNamedEntries(mixed[2])
    };
  }
  const named = trimmed.match(/^\{([\s\S]*)\}$/);
  if (named !== null) {
    return { kind: "named", entries: parseNamedEntries(named[1]) };
  }
  if (/^[A-Za-z_$][\w$]*$/.test(trimmed)) {
    return { kind: "default", local: trimmed };
  }
  return { kind: "sideEffect" };
}
function parseNamedEntries(inside) {
  const entries = [];
  for (const part of inside.split(",")) {
    const t = part.trim();
    if (t.length === 0) continue;
    const aliased = t.match(/^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/);
    if (aliased !== null) {
      entries.push({ source: aliased[1], local: aliased[2] });
    } else if (/^[A-Za-z_$][\w$]*$/.test(t)) {
      entries.push({ source: t, local: t });
    }
  }
  return entries;
}
function rewriteAsUrlLoad(binding, name) {
  const target = `(await __load(${JSON.stringify(name)}))`;
  switch (binding.kind) {
    case "sideEffect":
      return `await __load(${JSON.stringify(name)});`;
    case "namespace":
      return `const ${binding.local} = ${target};`;
    case "default":
      return `const ${binding.local} = ${target}.default;`;
    case "named": {
      if (binding.entries.length === 0) return `await __load(${JSON.stringify(name)});`;
      if (binding.entries.length === 1 && binding.entries[0]?.source === name && binding.entries[0]?.local === name) {
        return `const ${name} = ${target};`;
      }
      const dest = binding.entries.map((e) => e.source === e.local ? e.source : `${e.source}: ${e.local}`).join(", ");
      return `const { ${dest} } = ${target};`;
    }
    case "mixed": {
      const named = binding.entries.map((e) => e.source === e.local ? e.source : `${e.source}: ${e.local}`).join(", ");
      return `const ${binding.defaultLocal} = ${target}.default; const { ${named} } = ${target};`;
    }
  }
}
function rewriteAsRegisteredAccess(binding, name, helperContext = false) {
  const target = helperContext ? `__registered[${JSON.stringify(name)}]` : name;
  switch (binding.kind) {
    case "sideEffect":
      return `/* import '${name}' (already in scope) */`;
    case "namespace":
      if (binding.local === name && !helperContext) return `/* import * as ${name} */`;
      return `const ${binding.local} = ${target};`;
    case "default":
      if (binding.local === name && !helperContext) return `/* import ${name} (already in scope) */`;
      return `const ${binding.local} = ${target}.default;`;
    case "named": {
      if (binding.entries.length === 1 && binding.entries[0]?.source === name && binding.entries[0]?.local === name) {
        if (!helperContext) return `/* import { ${name} } from '${name}' (already in scope) */`;
        return `const ${name} = ${target};`;
      }
      if (binding.entries.length === 0) return `/* import '${name}' */`;
      const dest = binding.entries.map((e) => e.source === e.local ? e.source : `${e.source}: ${e.local}`).join(", ");
      return `const { ${dest} } = ${target};`;
    }
    case "mixed": {
      const named = binding.entries.map((e) => e.source === e.local ? e.source : `${e.source}: ${e.local}`).join(", ");
      const defaultPart = binding.defaultLocal === name && !helperContext ? "" : `const ${binding.defaultLocal} = ${target}.default;`;
      const namedPart = `const { ${named} } = ${target};`;
      return defaultPart === "" ? namedPart : `${defaultPart}
${namedPart}`;
    }
  }
}
function rewriteAsLookup(binding, resolvedPath) {
  const key = JSON.stringify(resolvedPath);
  switch (binding.kind) {
    case "sideEffect":
      return `/* import ${resolvedPath} */`;
    case "namespace":
      return `const ${binding.local} = __modules[${key}];`;
    case "default":
      return `const { default: ${binding.local} } = __modules[${key}];`;
    case "named": {
      if (binding.entries.length === 0) return `/* import ${resolvedPath} */`;
      const dest = binding.entries.map((e) => e.source === e.local ? e.source : `${e.source}: ${e.local}`).join(", ");
      return `const { ${dest} } = __modules[${key}];`;
    }
    case "mixed": {
      const named = binding.entries.map((e) => e.source === e.local ? e.source : `${e.source}: ${e.local}`).join(", ");
      return `const { default: ${binding.defaultLocal}, ${named} } = __modules[${key}];`;
    }
  }
}
function isVfsPath(p) {
  return p.startsWith("/");
}
function resolveVfsPath(path, base) {
  if (path.startsWith("/")) return normalize(path);
  const baseDir = base.endsWith("/") ? base : `${base}/`;
  return normalize(`${baseDir}${path}`);
}
function normalize(path) {
  const out = [];
  for (const seg of path.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      out.pop();
      continue;
    }
    out.push(seg);
  }
  return `/${out.join("/")}`;
}
function dirname(path) {
  const slash = path.lastIndexOf("/");
  if (slash <= 0) return "/";
  return path.slice(0, slash);
}
async function findFile(resolved, fs) {
  if (await fs.exists(resolved)) return resolved;
  for (const ext of [".ts", ".js", ".mjs"]) {
    const candidate = `${resolved}${ext}`;
    if (await fs.exists(candidate)) return candidate;
  }
  throw new Error(
    `module loader: helper not found in VFS \u2014 '${resolved}' (also tried .ts, .js, .mjs extensions)`
  );
}

export { parseImports, prepareScript, prepareScriptForWire };
//# sourceMappingURL=chunk-37F76RJV.js.map
//# sourceMappingURL=chunk-37F76RJV.js.map