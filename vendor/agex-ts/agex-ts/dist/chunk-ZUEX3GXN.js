// src/runtime/wrap-fs.ts
var utf8Decoder = new TextDecoder("utf-8");
var utf8Encoder = new TextEncoder();
var SUPPORTED_ENCODINGS = /* @__PURE__ */ new Set(["utf8", "utf-8"]);
function decodeBytes(bytes, encoding) {
  const enc = encoding.toLowerCase();
  if (enc === "utf8" || enc === "utf-8") return utf8Decoder.decode(bytes);
  throw new Error(
    `fs.read: unsupported encoding '${encoding}' \u2014 supported: ${[...SUPPORTED_ENCODINGS].join(", ")}. For other encodings, read as bytes (omit the second argument) and decode manually with a TextDecoder.`
  );
}
function wrapAgentFs(fs) {
  const doRead = async (path, encoding) => {
    const bytes = await fs.read(path);
    if (encoding === void 0) return bytes;
    return decodeBytes(bytes, encoding);
  };
  const doWrite = async (path, content, mode) => {
    const bytes = typeof content === "string" ? utf8Encoder.encode(content) : content;
    return fs.write(path, bytes, mode);
  };
  const doReadText = (path) => doRead(path, "utf8");
  const doWriteText = (path, str, mode) => doWrite(path, str, mode);
  const aliases = {
    read: doRead,
    readFile: doRead,
    readText: doReadText,
    write: doWrite,
    writeFile: doWrite,
    writeText: doWriteText
  };
  return new Proxy(fs, {
    get(target, prop, receiver) {
      if (typeof prop === "string" && prop in aliases) {
        return aliases[prop];
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

export { wrapAgentFs };
//# sourceMappingURL=chunk-ZUEX3GXN.js.map
//# sourceMappingURL=chunk-ZUEX3GXN.js.map