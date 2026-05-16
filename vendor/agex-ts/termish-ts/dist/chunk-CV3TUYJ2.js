import { normalize, resolve, joinPath } from './chunk-ARYRPIXS.js';

// src/glob.ts
function hasGlobChars(pattern) {
  return /[*?[]/.test(pattern);
}
function compileGlob(pattern) {
  let re = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*" && pattern[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (pattern[i] === "/") i++;
      continue;
    }
    if (c === "*") {
      re += "[^/]*";
      i++;
      continue;
    }
    if (c === "?") {
      re += "[^/]";
      i++;
      continue;
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 1);
      if (end === -1) {
        re += "\\[";
        i++;
        continue;
      }
      const cls = pattern.slice(i + 1, end);
      const translated = cls.startsWith("!") ? `^${cls.slice(1)}` : cls;
      re += `[${translated}]`;
      i = end + 1;
      continue;
    }
    re += c.replace(/[.+^${}()|\\]/g, "\\$&");
    i++;
  }
  return new RegExp(`^${re}$`);
}
function globMatch(pattern, path) {
  return compileGlob(pattern).test(path);
}
async function glob(pattern, fs) {
  if (!hasGlobChars(pattern)) {
    return await fs.exists(pattern) ? [pattern] : [];
  }
  const isAbsolute = pattern.startsWith("/");
  const cwd = fs.getcwd();
  const segments = pattern.split("/");
  const baseSegments = [];
  let firstGlobIdx = 0;
  for (; firstGlobIdx < segments.length; firstGlobIdx++) {
    if (hasGlobChars(segments[firstGlobIdx])) break;
    baseSegments.push(segments[firstGlobIdx]);
  }
  const baseRel = baseSegments.join("/");
  const baseAbs = isAbsolute ? normalize(baseRel.length > 0 ? baseRel : "/") : resolve(baseRel.length > 0 ? baseRel : ".", cwd);
  const relPattern = segments.slice(firstGlobIdx).join("/");
  const needsRecursion = relPattern.includes("**") || relPattern.includes("/");
  let entries;
  try {
    entries = await fs.list(baseAbs, { recursive: needsRecursion });
  } catch {
    return [];
  }
  const regex = compileGlob(relPattern);
  const matches = [];
  for (const entry of entries) {
    if (regex.test(entry)) {
      if (isAbsolute) {
        matches.push(joinPath(baseAbs, entry));
      } else {
        matches.push(baseRel.length > 0 ? joinPath(baseRel, entry) : entry);
      }
    }
  }
  return matches.sort();
}

export { compileGlob, glob, globMatch, hasGlobChars };
//# sourceMappingURL=chunk-CV3TUYJ2.js.map
//# sourceMappingURL=chunk-CV3TUYJ2.js.map