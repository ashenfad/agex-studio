import { safeStringifyArgs } from './chunk-ZDNM4VPR.js';

// src/runtime/console-capture-shared.ts
var realConsole = globalThis.console;
function reflectBoundToReal(target, prop, receiver) {
  const value = Reflect.get(target, prop, receiver);
  return typeof value === "function" ? value.bind(realConsole) : value;
}
function makeHostFnContext(args) {
  const { outputs, signal } = args;
  const passConsole = args.passConsole === true;
  const target = { outputs};
  const make = (level) => (...callArgs) => {
    pushArgs(target, level, callArgs);
    if (passConsole) realConsole[level](...callArgs);
  };
  const ctxConsole = new Proxy(realConsole, {
    get(target2, prop, receiver) {
      if (prop === "log") return make("log");
      if (prop === "warn") return make("warn");
      if (prop === "error") return make("error");
      if (prop === "info") return make("info");
      return reflectBoundToReal(target2, prop, receiver);
    }
  });
  return { console: ctxConsole, signal };
}
function pushArgs(target, level, args) {
  const buf = [];
  const flushText = () => {
    if (buf.length === 0) return;
    const text = safeStringifyArgs(buf);
    const prefixed = level === "log" ? text : `[${level}] ${text}`;
    target.outputs.push({ type: "text", text: prefixed });
    buf.length = 0;
  };
  for (const a of args) {
    const img = detectImage(a);
    if (img !== null) {
      flushText();
      target.outputs.push({ type: "image", format: img.format, data: img.data });
    } else {
      buf.push(a);
    }
  }
  flushText();
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
      const declared = m[1];
      const payload = m[2];
      if (payload.length >= MIN_IMAGE_BASE64_LENGTH) {
        const prefix = decodeBase64Prefix(payload, 12);
        if (prefix !== null && detectMagicFormat(prefix) === declared) {
          return { format: declared, data: payload };
        }
      }
    }
  }
  if (value instanceof Uint8Array) {
    const fmt = detectMagicFormat(value);
    if (fmt !== null) return { format: fmt, data: bytesToBase64(value) };
  }
  return null;
}
var MIN_IMAGE_BASE64_LENGTH = 96;
function detectMagicFormat(b) {
  if (b.byteLength < 12) return null;
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return "png";
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return "jpeg";
  if (b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) {
    return "webp";
  }
  return null;
}
function decodeBase64Prefix(b64, byteCount) {
  const charsNeeded = Math.ceil(byteCount / 3) * 4;
  if (b64.length < charsNeeded) return null;
  const slice = b64.slice(0, charsNeeded);
  try {
    if (typeof Buffer !== "undefined") {
      const buf = Buffer.from(slice, "base64");
      return buf.byteLength >= byteCount ? new Uint8Array(buf.subarray(0, byteCount)) : null;
    }
    const binary = atob(slice);
    if (binary.length < byteCount) return null;
    const out = new Uint8Array(byteCount);
    for (let i = 0; i < byteCount; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}
function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }
  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
function _getRealConsoleForTests() {
  return realConsole;
}

export { _getRealConsoleForTests, bytesToBase64, detectImage, makeHostFnContext, pushArgs, realConsole, reflectBoundToReal };
//# sourceMappingURL=chunk-RDWADUN6.js.map
//# sourceMappingURL=chunk-RDWADUN6.js.map