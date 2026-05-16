// src/runtime/safe-stringify.ts
var DEFAULT_MAX_CHARS = 4e3;
function safeStringify(value, opts = {}) {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const raw = renderValue(value);
  return truncate(raw, maxChars);
}
function safeStringifyArgs(args, opts = {}) {
  return args.map((a) => safeStringify(a, opts)).join(" ");
}
function renderValue(value) {
  if (value === void 0) return "undefined";
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    const name = value.name;
    return `[Function${name ? `: ${name}` : ""}]`;
  }
  if (value instanceof Error) {
    const stack = value.stack ?? `${value.name}: ${value.message}`;
    return stack;
  }
  return safeJsonStringify(value);
}
function safeJsonStringify(value) {
  const seen = /* @__PURE__ */ new WeakSet();
  try {
    return JSON.stringify(value, (_key, v) => sanitizeForJson(v, seen)) ?? "undefined";
  } catch (e) {
    return `[unserializable: ${e instanceof Error ? e.message : String(e)}]`;
  }
}
function sanitizeForJson(value, seen) {
  if (value === void 0) return "<undefined>";
  if (typeof value === "bigint") return `${value.toString()}n`;
  if (typeof value === "symbol") return value.toString();
  if (typeof value === "function") {
    const name = value.name;
    return `[Function${name ? `: ${name}` : ""}]`;
  }
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "object" && value !== null) {
    if (seen.has(value)) return "[Circular]";
    seen.add(value);
  }
  return value;
}
function truncate(s, maxChars) {
  if (s.length <= maxChars) return s;
  const head = s.slice(0, maxChars);
  const dropped = s.length - maxChars;
  return `${head}\u2026 [truncated, ${dropped} more chars]`;
}

export { safeStringify, safeStringifyArgs };
//# sourceMappingURL=chunk-ZDNM4VPR.js.map
//# sourceMappingURL=chunk-ZDNM4VPR.js.map