// src/fs/path.ts
function normalize(path) {
  const segments = path.split("/").filter((s) => s !== "" && s !== ".");
  const out = [];
  for (const seg of segments) {
    if (seg === "..") {
      if (out.length > 0) out.pop();
    } else {
      out.push(seg);
    }
  }
  return `/${out.join("/")}`;
}
function resolve(path, cwd) {
  const combined = path.startsWith("/") ? path : `${cwd}/${path}`;
  return normalize(combined);
}
function dirname(path) {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}
function basename(path) {
  const idx = path.lastIndexOf("/");
  return path.slice(idx + 1);
}
function joinPath(parent, child) {
  if (parent === "/") return `/${child}`;
  return `${parent}/${child}`;
}

export { basename, dirname, joinPath, normalize, resolve };
//# sourceMappingURL=chunk-ARYRPIXS.js.map
//# sourceMappingURL=chunk-ARYRPIXS.js.map