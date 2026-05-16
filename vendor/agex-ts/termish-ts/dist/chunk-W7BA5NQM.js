import { glob, globMatch } from './chunk-CV3TUYJ2.js';
import { basename, joinPath, resolve, normalize, dirname } from './chunk-ARYRPIXS.js';

// src/errors.ts
var TerminalError = class extends Error {
  name = "TerminalError";
  /** Whatever was written to stdout before the failure, captured so
   *  the host can still surface partial pipeline output. */
  partialOutput;
  constructor(message, partialOutput = "") {
    super(message);
    this.partialOutput = partialOutput;
  }
};
var ParseError = class extends Error {
  name = "ParseError";
};

// src/builtins/_argparse.ts
function parseArgs(args, spec, prog) {
  const flagsByAlias = /* @__PURE__ */ new Map();
  const flags = {};
  for (const [name, def] of Object.entries(spec.flags ?? {})) {
    if (def.multi === true) flags[name] = [];
    else if (def.takesValue !== true) flags[name] = false;
    for (const alias of def.aliases) flagsByAlias.set(alias, [name, def]);
  }
  const positional = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    i++;
    if (arg === "--") {
      while (i < args.length) positional.push(args[i++]);
      break;
    }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      const name = eqIdx === -1 ? arg : arg.slice(0, eqIdx);
      const inlineValue = eqIdx === -1 ? null : arg.slice(eqIdx + 1);
      const entry = flagsByAlias.get(name);
      if (entry === void 0) {
        throw new TerminalError(`${prog}: unknown option: ${name}`);
      }
      const [canonical, def] = entry;
      if (def.takesValue === true || def.multi === true) {
        let value;
        if (inlineValue !== null) {
          value = inlineValue;
        } else {
          if (i >= args.length) {
            throw new TerminalError(`${prog}: option ${name} requires a value`);
          }
          value = args[i++];
        }
        if (def.multi === true) {
          flags[canonical].push(value);
        } else {
          flags[canonical] = value;
        }
      } else {
        if (inlineValue !== null) {
          throw new TerminalError(`${prog}: option ${name} does not take a value`);
        }
        flags[canonical] = true;
      }
      continue;
    }
    if (arg.startsWith("-") && arg.length > 1) {
      const chars = arg.slice(1);
      let chi = 0;
      while (chi < chars.length) {
        const ch = chars[chi];
        const flagName = `-${ch}`;
        const entry = flagsByAlias.get(flagName);
        if (entry === void 0) {
          throw new TerminalError(`${prog}: unknown option: ${flagName}`);
        }
        const [canonical, def] = entry;
        if (def.takesValue === true || def.multi === true) {
          const remaining = chars.slice(chi + 1);
          let value;
          if (remaining.length > 0) {
            value = remaining;
            chi = chars.length;
          } else {
            if (i >= args.length) {
              throw new TerminalError(`${prog}: option ${flagName} requires a value`);
            }
            value = args[i++];
            chi = chars.length;
          }
          if (def.multi === true) {
            flags[canonical].push(value);
          } else {
            flags[canonical] = value;
          }
        } else {
          flags[canonical] = true;
          chi++;
        }
      }
      continue;
    }
    positional.push(arg);
  }
  if (spec.minPositional !== void 0 && positional.length < spec.minPositional) {
    throw new TerminalError(`${prog}: missing operand`);
  }
  if (spec.maxPositional !== void 0 && positional.length > spec.maxPositional) {
    throw new TerminalError(`${prog}: too many arguments`);
  }
  return { flags, positional };
}

// src/builtins/_tar.ts
var BLOCK = 512;
var ZERO_BLOCK = new Uint8Array(BLOCK);
function readTar(bytes) {
  const entries = [];
  let offset = 0;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (isZero(header)) break;
    const name = readString(header, 0, 100);
    const prefix = readString(header, 345, 155);
    const fullName = prefix.length > 0 ? `${prefix}/${name}` : name;
    const mode = readOctal(header, 100, 8);
    const size = readOctal(header, 124, 12);
    const mtime = readOctal(header, 136, 12);
    const typeflag = String.fromCharCode(header[156]);
    const type = typeflag === "5" ? "dir" : typeflag === "0" || typeflag === "\0" ? "file" : "other";
    const contentStart = offset + BLOCK;
    const content = bytes.subarray(contentStart, contentStart + size);
    entries.push({ name: fullName, type, content, mode, mtime });
    offset = contentStart + roundUp(size, BLOCK);
  }
  return entries;
}
function writeTar(entries) {
  const blocks = [];
  for (const e of entries) {
    blocks.push(buildHeader(e));
    if (e.type === "file" && e.content.length > 0) {
      blocks.push(e.content);
      const pad = roundUp(e.content.length, BLOCK) - e.content.length;
      if (pad > 0) blocks.push(new Uint8Array(pad));
    }
  }
  blocks.push(ZERO_BLOCK);
  blocks.push(ZERO_BLOCK);
  let total = 0;
  for (const b of blocks) total += b.length;
  const out = new Uint8Array(total);
  let pos = 0;
  for (const b of blocks) {
    out.set(b, pos);
    pos += b.length;
  }
  return out;
}
function buildHeader(entry) {
  const header = new Uint8Array(BLOCK);
  let name = entry.name;
  if (entry.type === "dir" && !name.endsWith("/")) name = `${name}/`;
  if (name.length > 100) {
    throw new Error(`tar: name too long (>100 chars): ${name}`);
  }
  writeString(header, name, 0, 100);
  writeOctal(header, entry.mode & 4095, 100, 8);
  writeOctal(header, 0, 108, 8);
  writeOctal(header, 0, 116, 8);
  writeOctal(header, entry.type === "file" ? entry.content.length : 0, 124, 12);
  writeOctal(header, entry.mtime, 136, 12);
  for (let i = 148; i < 156; i++) header[i] = 32;
  header[156] = entry.type === "dir" ? 53 : 48;
  const magic = encoder.encode("ustar\x0000");
  header.set(magic, 257);
  let sum = 0;
  for (const b of header) sum += b;
  writeOctal(header, sum, 148, 7);
  header[155] = 32;
  return header;
}
var encoder = new TextEncoder();
var decoder = new TextDecoder("utf-8", { fatal: false });
function readString(buf, offset, length) {
  const end = (() => {
    for (let i = offset; i < offset + length; i++) {
      if (buf[i] === 0) return i;
    }
    return offset + length;
  })();
  return decoder.decode(buf.subarray(offset, end));
}
function readOctal(buf, offset, length) {
  let s = "";
  for (let i = offset; i < offset + length; i++) {
    const c = buf[i];
    if (c === 0 || c === 32) {
      if (s.length > 0) break;
      continue;
    }
    s += String.fromCharCode(c);
  }
  if (s.length === 0) return 0;
  return Number.parseInt(s, 8);
}
function writeString(buf, s, offset, length) {
  const enc = encoder.encode(s);
  const n = Math.min(enc.length, length);
  for (let i = 0; i < n; i++) buf[offset + i] = enc[i];
}
function writeOctal(buf, n, offset, length) {
  const s = n.toString(8).padStart(length - 1, "0");
  for (let i = 0; i < length - 1; i++) buf[offset + i] = s.charCodeAt(i);
  buf[offset + length - 1] = 0;
}
function isZero(buf) {
  for (const b of buf) if (b !== 0) return false;
  return true;
}
function roundUp(n, mod) {
  return Math.ceil(n / mod) * mod;
}

// src/builtins/archive.ts
var decoder2 = new TextDecoder("utf-8", { fatal: false });
var latin1 = new TextDecoder("latin1");
new TextEncoder();
var _fflate = null;
async function loadFflate() {
  if (_fflate === null) _fflate = await import('fflate');
  return _fflate;
}
var gzip = async (ctx) => {
  const { gunzipSync, gzipSync } = await loadFflate();
  let level = 9;
  const filtered = [];
  for (const a of ctx.args) {
    if (/^-[1-9]$/.test(a)) level = Number.parseInt(a.slice(1), 10);
    else filtered.push(a);
  }
  const parsed = parseArgs(
    filtered,
    {
      flags: {
        decompress: { aliases: ["-d", "--decompress"] },
        keep: { aliases: ["-k", "--keep"] },
        force: { aliases: ["-f", "--force"] },
        toStdout: { aliases: ["-c", "--stdout"] }
      }
    },
    "gzip"
  );
  if (parsed.positional.length === 0) throw new TerminalError("gzip: no files specified");
  for (const path of parsed.positional) {
    const decompress = parsed.flags.decompress === true;
    const keep = parsed.flags.keep === true;
    const force = parsed.flags.force === true;
    const toStdout = parsed.flags.toStdout === true;
    let content;
    try {
      content = await ctx.fs.read(path);
    } catch (e) {
      throw new TerminalError(`gzip: ${path}: ${describeError(e)}`);
    }
    if (decompress) {
      if (!path.endsWith(".gz")) {
        throw new TerminalError(`gzip: ${path}: unknown suffix -- ignored`);
      }
      let result;
      try {
        result = gunzipSync(content);
      } catch (e) {
        throw new TerminalError(`gzip: ${path}: ${describeError(e)}`);
      }
      if (toStdout) {
        ctx.stdout.write(decoder2.decode(result));
      } else {
        const outPath = path.slice(0, -3);
        if (await ctx.fs.exists(outPath) && !force) {
          throw new TerminalError(`gzip: ${outPath} already exists; use -f to overwrite`);
        }
        await ctx.fs.write(outPath, result);
        if (!keep) await ctx.fs.remove(path);
      }
    } else {
      if (path.endsWith(".gz")) {
        throw new TerminalError(`gzip: ${path} already has .gz suffix -- unchanged`);
      }
      const result = gzipSync(content, { level });
      if (toStdout) {
        ctx.stdout.write(latin1.decode(result));
      } else {
        const outPath = `${path}.gz`;
        if (await ctx.fs.exists(outPath) && !force) {
          throw new TerminalError(`gzip: ${outPath} already exists; use -f to overwrite`);
        }
        await ctx.fs.write(outPath, result);
        if (!keep) await ctx.fs.remove(path);
      }
    }
  }
};
var gunzip = async (ctx) => {
  return gzip({ ...ctx, args: ["-d", ...ctx.args] });
};
var tar = async (ctx) => {
  const { gunzipSync, gzipSync } = await loadFflate();
  let args = ctx.args;
  if (args.length > 0) {
    const first = args[0];
    if (!first.startsWith("-") && /[cxt]/.test(first)) {
      args = [`-${first}`, ...args.slice(1)];
    }
  }
  const parsed = parseArgs(
    args,
    {
      flags: {
        create: { aliases: ["-c", "--create"] },
        extract: { aliases: ["-x", "--extract"] },
        list: { aliases: ["-t", "--list"] },
        file: { aliases: ["-f", "--file"], takesValue: true },
        gzipFlag: { aliases: ["-z", "--gzip"] },
        verbose: { aliases: ["-v", "--verbose"] },
        directory: { aliases: ["-C", "--directory"], takesValue: true },
        stripComponents: { aliases: ["--strip-components"], takesValue: true }
      }
    },
    "tar"
  );
  const modeCount = (parsed.flags.create === true ? 1 : 0) + (parsed.flags.extract === true ? 1 : 0) + (parsed.flags.list === true ? 1 : 0);
  if (modeCount !== 1) {
    throw new TerminalError("tar: exactly one of -c, -x, -t must be specified");
  }
  const file = parsed.flags.file;
  if (file === void 0) throw new TerminalError("tar: -f option is required");
  const useGzip = parsed.flags.gzipFlag === true;
  const verbose = parsed.flags.verbose === true;
  const chdir = parsed.flags.directory;
  const stripStr = parsed.flags.stripComponents;
  const strip = stripStr === void 0 ? 0 : Number.parseInt(stripStr, 10);
  if (parsed.flags.create === true) {
    if (parsed.positional.length === 0) {
      throw new TerminalError("tar: no files specified for archive");
    }
    const entries2 = [];
    for (const p of parsed.positional) {
      const lookup = normalize(joinPath(chdir ?? "", p));
      await collectTarEntries(ctx.fs, lookup, p, entries2, verbose, ctx.stdout);
    }
    let bytes2 = writeTar(entries2);
    if (useGzip) bytes2 = gzipSync(bytes2);
    await ctx.fs.write(file, bytes2);
    return;
  }
  const targetDir = chdir ?? ctx.fs.getcwd();
  let bytes;
  try {
    bytes = await ctx.fs.read(file);
  } catch (e) {
    throw new TerminalError(`tar: ${file}: ${describeError(e)}`);
  }
  if (useGzip || isGzipMagic(bytes)) {
    try {
      bytes = gunzipSync(bytes);
    } catch (e) {
      throw new TerminalError(`tar: error reading archive: ${describeError(e)}`);
    }
  }
  let entries;
  try {
    entries = readTar(bytes);
  } catch (e) {
    throw new TerminalError(`tar: error reading archive: ${describeError(e)}`);
  }
  if (parsed.flags.list === true) {
    for (const e of entries) ctx.stdout.write(`${e.name}
`);
    return;
  }
  for (const e of entries) {
    if (e.name.split("/").includes("..")) {
      throw new TerminalError(`tar: ${e.name}: path traversal detected, skipping`);
    }
    let safe = e.name.replace(/^\/+/, "");
    if (safe.length === 0) continue;
    if (strip > 0) {
      const parts = safe.split("/");
      const stripped = parts.slice(strip);
      if (stripped.length === 0 || stripped.length === 1 && stripped[0] === "") continue;
      safe = stripped.join("/");
    }
    if (basename(safe).startsWith("._")) continue;
    const outPath = joinPath(targetDir, safe);
    if (e.type === "dir") {
      await ctx.fs.mkdir(outPath, { parents: true, existOk: true });
    } else if (e.type === "file") {
      const parent = dirname(outPath);
      if (parent !== "/" && parent !== "") {
        await ctx.fs.mkdir(parent, { parents: true, existOk: true });
      }
      await ctx.fs.write(outPath, e.content);
    }
    if (verbose) ctx.stdout.write(`${e.name}
`);
  }
};
async function collectTarEntries(fs, filePath, arcname, out, verbose, stdout) {
  if (!await fs.exists(filePath)) {
    throw new TerminalError(`tar: ${filePath}: No such file or directory`);
  }
  const isDir = await fs.isDir(filePath);
  if (isDir) {
    out.push({
      name: `${arcname.replace(/\/$/, "")}/`,
      type: "dir",
      content: new Uint8Array(0),
      mode: 493,
      mtime: 0
    });
    if (verbose) stdout.write(`${arcname}/
`);
    const children = await fs.list(filePath);
    for (const name of children) {
      await collectTarEntries(
        fs,
        joinPath(filePath, name),
        joinPath(arcname, name),
        out,
        verbose,
        stdout
      );
    }
  } else {
    const content = await fs.read(filePath);
    out.push({ name: arcname, type: "file", content, mode: 420, mtime: 0 });
    if (verbose) stdout.write(`${arcname}
`);
  }
}
function isGzipMagic(bytes) {
  return bytes.length >= 2 && bytes[0] === 31 && bytes[1] === 139;
}
var zip = async (ctx) => {
  const { zipSync } = await loadFflate();
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        recurse: { aliases: ["-r", "--recurse-paths"] }
      },
      minPositional: 1
    },
    "zip"
  );
  if (parsed.positional.length < 2) throw new TerminalError("zip: no files specified");
  let archivePath = parsed.positional[0];
  if (!archivePath.endsWith(".zip")) archivePath += ".zip";
  const files = parsed.positional.slice(1);
  const recursive = parsed.flags.recurse === true;
  const tree = {};
  for (const p of files) await collectZipEntries(ctx.fs, p, p, recursive, tree);
  const bytes = zipSync(tree);
  await ctx.fs.write(archivePath, bytes);
};
async function collectZipEntries(fs, filePath, arcname, recursive, tree) {
  if (!await fs.exists(filePath)) {
    throw new TerminalError(`zip: ${filePath}: No such file or directory`);
  }
  if (await fs.isDir(filePath)) {
    if (!recursive) throw new TerminalError(`zip: ${filePath}: is a directory (use -r to include)`);
    tree[`${arcname.replace(/\/$/, "")}/`] = new Uint8Array(0);
    const children = await fs.list(filePath);
    for (const name of children) {
      await collectZipEntries(
        fs,
        joinPath(filePath, name),
        joinPath(arcname, name),
        recursive,
        tree
      );
    }
  } else {
    tree[arcname] = await fs.read(filePath);
  }
}
var unzip = async (ctx) => {
  const { unzipSync } = await loadFflate();
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        list: { aliases: ["-l", "--list"] },
        directory: { aliases: ["-d", "--directory"], takesValue: true },
        overwrite: { aliases: ["-o", "--overwrite"] }
      },
      minPositional: 1
    },
    "unzip"
  );
  const archivePath = parsed.positional[0];
  const targetDir = parsed.flags.directory ?? ctx.fs.getcwd();
  const wantedFiles = new Set(parsed.positional.slice(1));
  let bytes;
  try {
    bytes = await ctx.fs.read(archivePath);
  } catch {
    throw new TerminalError(`unzip: cannot find ${archivePath}`);
  }
  let entries;
  try {
    entries = unzipSync(bytes);
  } catch {
    throw new TerminalError(`unzip: ${archivePath}: not a valid zip file`);
  }
  const list = parsed.flags.list === true;
  if (list) {
    ctx.stdout.write(`Archive:  ${archivePath}
`);
    ctx.stdout.write("  Length      Name\n");
    ctx.stdout.write("---------  ----\n");
    let total = 0;
    let count = 0;
    for (const [name, data] of Object.entries(entries)) {
      ctx.stdout.write(`${data.length.toString().padStart(9, " ")}  ${name}
`);
      total += data.length;
      count++;
    }
    ctx.stdout.write("---------  ----\n");
    ctx.stdout.write(`${total.toString().padStart(9, " ")}  ${count} files
`);
    return;
  }
  for (const [name, data] of Object.entries(entries)) {
    if (wantedFiles.size > 0 && !wantedFiles.has(name)) continue;
    if (name.split("/").includes("..")) {
      throw new TerminalError(`unzip: ${name}: path traversal detected, skipping`);
    }
    const safe = name.replace(/^\/+/, "");
    if (safe.length === 0) continue;
    if (basename(safe).startsWith("._")) continue;
    const outPath = joinPath(targetDir, safe);
    const isDir = name.endsWith("/");
    if (isDir) {
      await ctx.fs.mkdir(outPath, { parents: true, existOk: true });
    } else {
      const parent = dirname(outPath);
      if (parent !== "/" && parent !== "") {
        await ctx.fs.mkdir(parent, { parents: true, existOk: true });
      }
      if (await ctx.fs.exists(outPath) && parsed.flags.overwrite !== true) {
        ctx.stdout.write(`  skipping: ${safe} (already exists)
`);
        continue;
      }
      await ctx.fs.write(outPath, data);
      ctx.stdout.write(`  inflating: ${safe}
`);
    }
  }
};
function describeError(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/builtins/diff.ts
var decoder3 = new TextDecoder("utf-8", { fatal: false });
var diff = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        unified: { aliases: ["-u", "--unified"] },
        unifiedContext: { aliases: ["-U", "--unified-context"], takesValue: true },
        context: { aliases: ["-c", "--context"] },
        brief: { aliases: ["-q", "--brief"] },
        ignoreBlankLines: { aliases: ["-B", "--ignore-blank-lines"] },
        ignoreAllSpace: { aliases: ["-w", "--ignore-all-space"] },
        ignoreSpaceChange: { aliases: ["-b", "--ignore-space-change"] },
        ignoreCase: { aliases: ["-i", "--ignore-case"] },
        recursive: { aliases: ["-r", "--recursive"] }
      },
      maxPositional: 2
    },
    "diff"
  );
  if (parsed.positional.length < 2) {
    throw new TerminalError("diff: requires two file arguments (e.g., diff file1.txt file2.txt)");
  }
  const [file1, file2] = parsed.positional;
  const opts = {
    brief: parsed.flags.brief === true,
    context: parsed.flags.context === true,
    unifiedContext: numericFlag(parsed.flags.unifiedContext, 3),
    ignoreBlankLines: parsed.flags.ignoreBlankLines === true,
    ignoreAllSpace: parsed.flags.ignoreAllSpace === true,
    ignoreSpaceChange: parsed.flags.ignoreSpaceChange === true,
    ignoreCase: parsed.flags.ignoreCase === true
  };
  if (parsed.flags.recursive === true && await ctx.fs.isDir(file1) && await ctx.fs.isDir(file2)) {
    await diffRecursive(file1, file2, opts, ctx.fs, ctx.stdout);
    return;
  }
  await diffPair(file1, file2, opts, ctx.fs, ctx.stdout);
};
async function diffPair(path1, path2, opts, fs, stdout) {
  const file1Lines = await readLines(path1, fs);
  const file2Lines = await readLines(path2, fs);
  const needsPreprocess = opts.ignoreBlankLines || opts.ignoreAllSpace || opts.ignoreSpaceChange || opts.ignoreCase;
  const cmp1 = needsPreprocess ? preprocess(file1Lines, opts) : file1Lines;
  const cmp2 = needsPreprocess ? preprocess(file2Lines, opts) : file2Lines;
  if (opts.brief) {
    if (!arraysEqual(cmp1, cmp2)) {
      stdout.write(`Files ${path1} and ${path2} differ
`);
    }
    return;
  }
  const ops = computeEditScript(cmp1, cmp2);
  if (ops.every((op) => op.type === "equal")) return;
  const hunks = groupIntoHunks(ops, opts.unifiedContext);
  let displayCmp1 = cmp1;
  let displayCmp2 = cmp2;
  if (needsPreprocess) {
    displayCmp1 = file1Lines;
    displayCmp2 = file2Lines;
  }
  if (opts.context) {
    formatContextDiff(hunks, ops, displayCmp1, displayCmp2, path1, path2, stdout);
  } else {
    formatUnifiedDiff(hunks, ops, displayCmp1, displayCmp2, path1, path2, stdout);
  }
}
async function readLines(path, fs) {
  let bytes;
  try {
    bytes = await fs.read(path);
  } catch (e) {
    throw new TerminalError(`diff: ${path}: ${describeError2(e)}`);
  }
  return splitLinesKeepEnds(decoder3.decode(bytes));
}
function preprocess(lines, opts) {
  let out = [...lines];
  if (opts.ignoreBlankLines) {
    out = out.filter((line) => line.trim().length > 0);
  }
  if (opts.ignoreAllSpace) {
    out = out.map((line) => line.replaceAll(" ", "").replaceAll("	", ""));
  } else if (opts.ignoreSpaceChange) {
    out = out.map((line) => {
      const hasNl = line.endsWith("\n");
      const stripped = line.replace(/[ \t]+/g, " ").replace(/[ \t]+$/, "");
      return hasNl ? `${stripped}
` : stripped;
    });
  }
  if (opts.ignoreCase) {
    out = out.map((line) => line.toLowerCase());
  }
  return out;
}
async function diffRecursive(dir1, dir2, opts, fs, stdout) {
  const d1 = dir1.replace(/\/$/, "");
  const d2 = dir2.replace(/\/$/, "");
  const files1 = await collectFilesRel(fs, d1);
  const files2 = await collectFilesRel(fs, d2);
  const all = /* @__PURE__ */ new Set([...files1, ...files2]);
  for (const rel of [...all].sort()) {
    const p1 = `${d1}/${rel}`;
    const p2 = `${d2}/${rel}`;
    if (!files1.has(rel)) {
      stdout.write(`Only in ${d2}: ${rel}
`);
    } else if (!files2.has(rel)) {
      stdout.write(`Only in ${d1}: ${rel}
`);
    } else {
      await diffPair(p1, p2, opts, fs, stdout);
    }
  }
}
async function collectFilesRel(fs, root) {
  const result = /* @__PURE__ */ new Set();
  let items;
  try {
    items = await fs.listDetailed(root, { recursive: true });
  } catch {
    return result;
  }
  const stripped = root === "/" ? "" : root.replace(/\/$/, "");
  for (const item of items) {
    if (!item.isDir) {
      let rel = item.path;
      if (rel.startsWith(`${stripped}/`)) rel = rel.slice(stripped.length + 1);
      result.add(rel);
    }
  }
  return result;
}
function computeEditScript(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = [];
  for (let i2 = 0; i2 <= m; i2++) dp.push(new Array(n + 1).fill(0));
  for (let i2 = 1; i2 <= m; i2++) {
    for (let j2 = 1; j2 <= n; j2++) {
      if (a[i2 - 1] === b[j2 - 1]) {
        dp[i2][j2] = dp[i2 - 1][j2 - 1] + 1;
      } else {
        dp[i2][j2] = Math.max(
          dp[i2 - 1][j2],
          dp[i2][j2 - 1]
        );
      }
    }
  }
  const ops = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      ops.push({ type: "equal", i: i - 1, j: j - 1 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ type: "insert", j: j - 1 });
      j--;
    } else {
      ops.push({ type: "delete", i: i - 1 });
      i--;
    }
  }
  ops.reverse();
  return ops;
}
function groupIntoHunks(ops, contextN) {
  const hunks = [];
  const n = ops.length;
  let i = 0;
  while (i < n) {
    if (ops[i]?.type === "equal") {
      i++;
      continue;
    }
    let start = i;
    let backCtx = 0;
    while (start > 0 && ops[start - 1]?.type === "equal" && backCtx < contextN) {
      start--;
      backCtx++;
    }
    let end = i;
    while (end < n) {
      if (ops[end]?.type !== "equal") {
        end++;
        continue;
      }
      let runEnd = end;
      while (runEnd < n && ops[runEnd]?.type === "equal") runEnd++;
      const runLen = runEnd - end;
      const hasMoreChanges = runEnd < n;
      if (hasMoreChanges && runLen <= 2 * contextN) {
        end = runEnd;
        continue;
      }
      const take = Math.min(contextN, runLen);
      end = end + take;
      break;
    }
    if (end > n) end = n;
    let aStart = -1;
    let bStart = -1;
    let aCount = 0;
    let bCount = 0;
    for (let k = start; k < end; k++) {
      const op = ops[k];
      if (op.type === "equal") {
        if (aStart < 0 && op.i !== void 0) aStart = op.i;
        if (bStart < 0 && op.j !== void 0) bStart = op.j;
        aCount++;
        bCount++;
      } else if (op.type === "delete") {
        if (aStart < 0 && op.i !== void 0) aStart = op.i;
        aCount++;
      } else {
        if (bStart < 0 && op.j !== void 0) bStart = op.j;
        bCount++;
      }
    }
    hunks.push({
      startOp: start,
      endOp: end - 1,
      aStart: Math.max(0, aStart),
      aCount,
      bStart: Math.max(0, bStart),
      bCount
    });
    i = end;
  }
  return hunks;
}
function formatUnifiedDiff(hunks, ops, a, b, pathA, pathB, stdout) {
  if (hunks.length === 0) return;
  stdout.write(`--- ${pathA}
`);
  stdout.write(`+++ ${pathB}
`);
  for (const h of hunks) {
    const aHdr = h.aCount === 1 ? `${h.aStart + 1}` : `${h.aStart + 1},${h.aCount}`;
    const bHdr = h.bCount === 1 ? `${h.bStart + 1}` : `${h.bStart + 1},${h.bCount}`;
    stdout.write(`@@ -${aHdr} +${bHdr} @@
`);
    for (let k = h.startOp; k <= h.endOp; k++) {
      const op = ops[k];
      const line = op.type === "insert" ? b[op.j] : a[op.i];
      const prefix = op.type === "equal" ? " " : op.type === "insert" ? "+" : "-";
      stdout.write(`${prefix}${ensureNewline(line)}`);
    }
  }
}
function formatContextDiff(hunks, ops, a, b, pathA, pathB, stdout) {
  if (hunks.length === 0) return;
  stdout.write(`*** ${pathA}
`);
  stdout.write(`--- ${pathB}
`);
  for (const h of hunks) {
    stdout.write("***************\n");
    const aFrom = h.aStart + 1;
    const aTo = h.aStart + h.aCount;
    stdout.write(`*** ${aFrom},${aTo} ****
`);
    for (let k = h.startOp; k <= h.endOp; k++) {
      const op = ops[k];
      if (op.type === "insert") continue;
      const prefix = op.type === "equal" ? "  " : "- ";
      stdout.write(`${prefix}${ensureNewline(a[op.i])}`);
    }
    const bFrom = h.bStart + 1;
    const bTo = h.bStart + h.bCount;
    stdout.write(`--- ${bFrom},${bTo} ----
`);
    for (let k = h.startOp; k <= h.endOp; k++) {
      const op = ops[k];
      if (op.type === "delete") continue;
      const prefix = op.type === "equal" ? "  " : "+ ";
      stdout.write(`${prefix}${ensureNewline(b[op.j])}`);
    }
  }
}
function splitLinesKeepEnds(text) {
  if (text.length === 0) return [];
  const lines = [];
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      lines.push(text.slice(lineStart, i + 1));
      i++;
      lineStart = i;
    } else if (c === "\r") {
      const end = text[i + 1] === "\n" ? i + 2 : i + 1;
      lines.push(text.slice(lineStart, end));
      i = end;
      lineStart = end;
    } else {
      i++;
    }
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart));
  return lines;
}
function ensureNewline(line) {
  return line.endsWith("\n") ? line : `${line}
`;
}
function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
function numericFlag(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}
function describeError2(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/builtins/_util.ts
function humanSize(size) {
  let n = size;
  const units = ["B", "K", "M", "G", "T"];
  for (const unit of units) {
    if (Math.abs(n) < 1024) {
      return unit === "B" ? `${Math.round(n)}${unit}` : `${n.toFixed(1)}${unit}`;
    }
    n /= 1024;
  }
  return `${n.toFixed(1)}P`;
}
function formatLsTime(modifiedAt) {
  if (!modifiedAt) return " ".repeat(16);
  return modifiedAt.slice(0, 16).replace("T", " ");
}
function padLeft(s, width) {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

// src/builtins/filesystem.ts
var pwd = async (ctx) => {
  ctx.stdout.write(`${ctx.fs.getcwd()}
`);
};
var cd = async (ctx) => {
  const path = ctx.args.length === 0 ? "/" : ctx.args[0];
  try {
    await ctx.fs.chdir(path);
  } catch (e) {
    throw new TerminalError(`cd: ${describeError3(e, path)}`);
  }
};
var mkdir = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: { parents: { aliases: ["-p", "--parents"] } },
      minPositional: 1
    },
    "mkdir"
  );
  for (const path of parsed.positional) {
    try {
      await ctx.fs.mkdir(path, {
        parents: parsed.flags.parents === true,
        existOk: parsed.flags.parents === true
      });
    } catch (e) {
      throw new TerminalError(`mkdir: cannot create directory '${path}': ${describeError3(e)}`);
    }
  }
};
var ls = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        long: { aliases: ["-l"] },
        all: { aliases: ["-a"] },
        recursive: { aliases: ["-R"] },
        humanReadable: { aliases: ["-h", "--human-readable"] },
        time: { aliases: ["-t"] },
        size: { aliases: ["-S"] },
        reverse: { aliases: ["-r"] },
        directory: { aliases: ["-d", "--directory"] },
        classify: { aliases: ["-F", "--classify"] },
        onePerLine: { aliases: ["-1"] }
      }
    },
    "ls"
  );
  const paths = parsed.positional.length > 0 ? parsed.positional : ["."];
  const fs = ctx.fs;
  const classified = [];
  for (const p of paths) {
    if (await fs.isFile(p)) classified.push({ path: p, kind: "file" });
    else if (await fs.isDir(p)) classified.push({ path: p, kind: "dir" });
    else classified.push({ path: p, kind: "missing" });
  }
  const dirCount = classified.filter((c) => c.kind === "dir").length;
  const fileCount = classified.filter((c) => c.kind === "file").length;
  const showHeaders = dirCount > 1 || dirCount >= 1 && fileCount >= 1;
  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const kind = classified[i]?.kind ?? "missing";
    if (showHeaders && kind === "dir") ctx.stdout.write(`${path}:
`);
    try {
      if (parsed.flags.directory === true && await fs.isDir(path)) {
        if (parsed.flags.long === true) {
          const meta = await fs.stat(path);
          const sz = parsed.flags.humanReadable === true ? padLeft(humanSize(meta.size), 6) : padLeft(`${meta.size}`, 8);
          const time = formatLsTime(meta.modifiedAt);
          ctx.stdout.write(`drw-r--r-- 1 agent agent ${sz} ${time} ${path}
`);
        } else {
          ctx.stdout.write(`${path}
`);
        }
        maybeSeparator(ctx, classified, i);
        continue;
      }
      if (await fs.isFile(path)) {
        if (parsed.flags.long === true) {
          const meta = await fs.stat(path);
          const sz = parsed.flags.humanReadable === true ? padLeft(humanSize(meta.size), 6) : padLeft(`${meta.size}`, 8);
          const time = formatLsTime(meta.modifiedAt);
          ctx.stdout.write(`-rw-r--r-- 1 agent agent ${sz} ${time} ${path}
`);
        } else {
          ctx.stdout.write(`${path}
`);
        }
        maybeSeparator(ctx, classified, i);
        continue;
      }
      const needsDetailed = parsed.flags.long === true || parsed.flags.time === true || parsed.flags.size === true || parsed.flags.classify === true;
      const recursive = parsed.flags.recursive === true;
      let items;
      if (needsDetailed) {
        items = await fs.listDetailed(path, { recursive });
        if (parsed.flags.all !== true) {
          items = items.filter((it) => !basename(it.path).startsWith("."));
        }
        if (parsed.flags.size === true) {
          items = [...items].sort((a, b) => b.size - a.size);
        } else if (parsed.flags.time === true) {
          items = [...items].sort((a, b) => (b.modifiedAt ?? "").localeCompare(a.modifiedAt ?? ""));
        }
        if (parsed.flags.reverse === true) items = [...items].reverse();
        if (parsed.flags.long === true) {
          for (const it of items) {
            const typeChar = it.isDir ? "d" : "-";
            const sz = parsed.flags.humanReadable === true ? padLeft(humanSize(it.size), 6) : padLeft(`${it.size}`, 8);
            const time = formatLsTime(it.modifiedAt);
            const suffix = parsed.flags.classify === true && it.isDir ? "/" : "";
            ctx.stdout.write(
              `${typeChar}rw-r--r-- 1 agent agent ${sz} ${time} ${it.path}${suffix}
`
            );
          }
        } else {
          const lines = items.map(
            (it) => `${it.path}${parsed.flags.classify === true && it.isDir ? "/" : ""}`
          );
          if (lines.length > 0) ctx.stdout.write(`${lines.join("\n")}
`);
        }
      } else {
        const names = await fs.list(path, { recursive });
        let filtered = names.filter(
          (p) => parsed.flags.all === true || !(basename(p) || p).startsWith(".")
        );
        if (parsed.flags.reverse === true) filtered = [...filtered].reverse();
        if (filtered.length > 0) ctx.stdout.write(`${filtered.join("\n")}
`);
      }
    } catch (e) {
      throw new TerminalError(`ls: cannot access '${path}': ${describeError3(e)}`);
    }
    maybeSeparator(ctx, classified, i);
  }
};
function maybeSeparator(ctx, classified, i) {
  if (i >= classified.length - 1) return;
  const here = classified[i]?.kind;
  const next = classified[i + 1]?.kind;
  if (here === "dir" && next === "dir") ctx.stdout.write("\n");
}
var touch = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: { noCreate: { aliases: ["-c", "--no-create"] } },
      minPositional: 1
    },
    "touch"
  );
  for (const path of parsed.positional) {
    try {
      const exists = await ctx.fs.exists(path);
      if (!exists) {
        if (parsed.flags.noCreate === true) continue;
        await ctx.fs.write(path, new Uint8Array(0));
      } else {
        const content = await ctx.fs.read(path);
        await ctx.fs.write(path, content);
      }
    } catch (e) {
      throw new TerminalError(`touch: ${describeError3(e, path)}`);
    }
  }
};
var cp = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        recursive: { aliases: ["-r", "-R"] },
        archive: { aliases: ["-a", "--archive"] }
      },
      minPositional: 2
    },
    "cp"
  );
  const sources = parsed.positional.slice(0, -1);
  const dst = parsed.positional[parsed.positional.length - 1];
  const recursive = parsed.flags.recursive === true || parsed.flags.archive === true;
  if (sources.length > 1 && !await ctx.fs.isDir(dst)) {
    throw new TerminalError(`cp: target '${dst}' is not a directory`);
  }
  for (const src of sources) {
    try {
      if (await ctx.fs.isDir(src)) {
        if (!recursive) {
          throw new TerminalError(`cp: -r not specified; omitting directory '${src}'`);
        }
        const targetPath = await ctx.fs.isDir(dst) ? joinPath(dst.replace(/\/$/, ""), basename(src.replace(/\/$/, ""))) : dst;
        const srcAbs = resolve(src, ctx.fs.getcwd());
        const dstAbs = resolve(targetPath, ctx.fs.getcwd());
        if (dstAbs === srcAbs || dstAbs.startsWith(`${srcAbs}/`)) {
          throw new TerminalError(`cp: cannot copy '${src}' into itself`);
        }
        await copyRecursive(src, targetPath, ctx.fs);
      } else {
        const content = await ctx.fs.read(src);
        const targetPath = await ctx.fs.isDir(dst) ? joinPath(dst.replace(/\/$/, ""), basename(src)) : dst;
        await ctx.fs.write(targetPath, content);
      }
    } catch (e) {
      if (e instanceof TerminalError) throw e;
      throw new TerminalError(`cp: cannot stat '${src}': ${describeError3(e)}`);
    }
  }
};
async function copyRecursive(src, dst, fs) {
  if (!await fs.exists(dst)) await fs.mkdir(dst);
  for (const item of await fs.listDetailed(src)) {
    const name = basename(item.path.replace(/\/$/, ""));
    const srcChild = joinPath(src.replace(/\/$/, ""), name);
    const dstChild = joinPath(dst.replace(/\/$/, ""), name);
    if (item.isDir) {
      await copyRecursive(srcChild, dstChild, fs);
    } else {
      const content = await fs.read(srcChild);
      await fs.write(dstChild, content);
    }
  }
}
var mv = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        force: { aliases: ["-f", "--force"] },
        noClobber: { aliases: ["-n", "--no-clobber"] }
      },
      minPositional: 2
    },
    "mv"
  );
  const sources = parsed.positional.slice(0, -1);
  const dstArg = parsed.positional[parsed.positional.length - 1];
  const force = parsed.flags.force === true;
  const noClobber = !force && parsed.flags.noClobber === true;
  const dstIsDir = await ctx.fs.isDir(dstArg);
  const trailingSlash = dstArg.endsWith("/") && dstArg !== "/";
  if (trailingSlash && !dstIsDir) {
    throw new TerminalError(`mv: target '${dstArg}': Not a directory`);
  }
  if (sources.length > 1 && !dstIsDir) {
    throw new TerminalError(`mv: target '${dstArg}' is not a directory`);
  }
  const dstNormalized = trailingSlash ? dstArg.slice(0, -1) : dstArg;
  for (const src of sources) {
    const target = dstIsDir ? joinPath(dstNormalized, basename(src.replace(/\/$/, ""))) : dstArg;
    if (dstIsDir) {
      const srcAbs = resolve(src, ctx.fs.getcwd());
      const targetAbs = resolve(target, ctx.fs.getcwd());
      if (targetAbs === srcAbs || targetAbs.startsWith(`${srcAbs}/`)) {
        throw new TerminalError(`mv: cannot move '${src}' to a subdirectory of itself, '${target}'`);
      }
    }
    if (noClobber && await ctx.fs.exists(target)) continue;
    try {
      await ctx.fs.rename(src, target);
    } catch (e) {
      throw new TerminalError(`mv: cannot stat '${src}': ${describeError3(e)}`);
    }
  }
};
var rm = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        recursive: { aliases: ["-r", "-R"] },
        force: { aliases: ["-f", "--force"] }
      },
      minPositional: 1
    },
    "rm"
  );
  for (const path of parsed.positional) {
    try {
      if (await ctx.fs.isDir(path)) {
        if (parsed.flags.recursive !== true) {
          throw new TerminalError(`rm: cannot remove '${path}': Is a directory (use -r to remove)`);
        }
        const abs = resolve(path, ctx.fs.getcwd());
        if (abs === "/" || abs === "") {
          throw new TerminalError("rm: cannot remove root directory");
        }
        await removeRecursive(path, ctx.fs);
      } else if (await ctx.fs.exists(path)) {
        await ctx.fs.remove(path);
      } else if (parsed.flags.force !== true) {
        throw new TerminalError(`rm: cannot remove '${path}': No such file or directory`);
      }
    } catch (e) {
      if (e instanceof TerminalError) throw e;
      throw new TerminalError(`rm: ${path}: ${describeError3(e)}`);
    }
  }
};
async function removeRecursive(path, fs) {
  for (const item of await fs.listDetailed(path)) {
    const name = basename(item.path.replace(/\/$/, ""));
    const childPath = joinPath(path.replace(/\/$/, ""), name);
    if (item.isDir) {
      await removeRecursive(childPath, fs);
    } else {
      await fs.remove(childPath);
    }
  }
  await fs.rmdir(path);
}
var basename2 = async (ctx) => {
  if (ctx.args.length === 0) throw new TerminalError("basename: missing operand");
  const path = ctx.args[0];
  const stripped = path.replace(/\/$/, "");
  let name = stripped.includes("/") ? stripped.split("/").pop() : stripped;
  if (ctx.args.length > 1) {
    const suffix = ctx.args[1];
    if (name !== suffix && name.endsWith(suffix)) {
      name = name.slice(0, name.length - suffix.length);
    }
  }
  ctx.stdout.write(`${name}
`);
};
var dirname2 = async (ctx) => {
  if (ctx.args.length === 0) throw new TerminalError("dirname: missing operand");
  const path = ctx.args[0];
  if (!path.includes("/")) {
    ctx.stdout.write(".\n");
    return;
  }
  const parent = path.replace(/\/$/, "").split("/").slice(0, -1).join("/");
  ctx.stdout.write(`${parent.length > 0 ? parent : "/"}
`);
};
function describeError3(e, contextPath) {
  const msg = e instanceof Error ? e.message : String(e);
  if (contextPath !== void 0 && !msg.includes(contextPath)) {
    return `${contextPath}: ${msg}`;
  }
  return msg;
}

// src/builtins/io.ts
var decoder4 = new TextDecoder("utf-8", { fatal: false });
var encoder3 = new TextEncoder();
var echo = async (ctx) => {
  let newline = true;
  let interpretEscapes = false;
  let textStart = 0;
  for (let i = 0; i < ctx.args.length; i++) {
    const arg = ctx.args[i];
    if (arg === "-n") {
      newline = false;
      textStart = i + 1;
    } else if (arg === "-e") {
      interpretEscapes = true;
      textStart = i + 1;
    } else if (arg === "-ne" || arg === "-en") {
      newline = false;
      interpretEscapes = true;
      textStart = i + 1;
    } else {
      break;
    }
  }
  let text = ctx.args.slice(textStart).join(" ");
  if (interpretEscapes) text = expandEscapes(text);
  ctx.stdout.write(text + (newline ? "\n" : ""));
};
function expandEscapes(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "	";
          break;
        case "\\":
          out += "\\";
          break;
        case "a":
          out += "\x07";
          break;
        case "b":
          out += "\b";
          break;
        default:
          out += `\\${next}`;
      }
      i++;
    } else {
      out += c;
    }
  }
  return out;
}
var printf = async (ctx) => {
  if (ctx.args.length === 0) {
    throw new TerminalError("printf: usage: printf format [arguments]");
  }
  const format = expandPrintfEscapes(ctx.args[0]);
  const args = ctx.args.slice(1);
  let cursor = 0;
  let producedAny = false;
  while (cursor < args.length || !producedAny) {
    const before = cursor;
    const { text, consumed } = applyPrintfFormat(format, args, cursor);
    ctx.stdout.write(text);
    cursor += consumed;
    producedAny = true;
    if (consumed === 0 || cursor === before) break;
  }
};
function expandPrintfEscapes(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      switch (next) {
        case "n":
          out += "\n";
          break;
        case "t":
          out += "	";
          break;
        case "r":
          out += "\r";
          break;
        case "\\":
          out += "\\";
          break;
        case "a":
          out += "\x07";
          break;
        case "b":
          out += "\b";
          break;
        case "0":
          out += "\0";
          break;
        default:
          out += `\\${next}`;
      }
      i++;
    } else {
      out += c;
    }
  }
  return out;
}
function applyPrintfFormat(format, args, cursor) {
  let out = "";
  let consumed = 0;
  let i = 0;
  while (i < format.length) {
    const c = format[i];
    if (c !== "%") {
      out += c;
      i++;
      continue;
    }
    let j = i + 1;
    let leftAlign = false;
    if (format[j] === "-") {
      leftAlign = true;
      j++;
    }
    let widthStr = "";
    while (j < format.length && /\d/.test(format[j])) {
      widthStr += format[j];
      j++;
    }
    const conv = format[j];
    if (conv === void 0) {
      out += format.slice(i);
      break;
    }
    const width = widthStr === "" ? 0 : Number.parseInt(widthStr, 10);
    if (conv === "%") {
      out += "%";
      i = j + 1;
      continue;
    }
    const arg = args[cursor + consumed];
    const formatted = formatPrintfConv(conv, arg, width, leftAlign);
    if (formatted === null) {
      out += format.slice(i, j + 1);
    } else {
      out += formatted;
      consumed++;
    }
    i = j + 1;
  }
  return { text: out, consumed };
}
function formatPrintfConv(conv, arg, width, leftAlign) {
  let body;
  switch (conv) {
    case "s":
      body = arg ?? "";
      break;
    case "d":
    case "i": {
      const n = Number.parseInt(arg ?? "0", 10);
      body = String(Number.isNaN(n) ? 0 : n);
      break;
    }
    case "x":
    case "X": {
      const n = Number.parseInt(arg ?? "0", 10);
      const hex = (Number.isNaN(n) ? 0 : n).toString(16);
      body = conv === "X" ? hex.toUpperCase() : hex;
      break;
    }
    case "o": {
      const n = Number.parseInt(arg ?? "0", 10);
      body = (Number.isNaN(n) ? 0 : n).toString(8);
      break;
    }
    case "c":
      body = (arg ?? "").slice(0, 1);
      break;
    default:
      return null;
  }
  if (width > body.length) {
    return leftAlign ? body.padEnd(width, " ") : body.padStart(width, " ");
  }
  return body;
}
var cat = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        showAll: { aliases: ["-A", "--show-all"] },
        showEnds: { aliases: ["-e"] },
        showTabs: { aliases: ["-T", "--show-tabs"] },
        number: { aliases: ["-n", "--number"] }
      }
    },
    "cat"
  );
  const showEnds = parsed.flags.showEnds === true || parsed.flags.showAll === true;
  const showTabs = parsed.flags.showTabs === true || parsed.flags.showAll === true;
  const showNumbers = parsed.flags.number === true;
  const formatting = showEnds || showTabs || showNumbers;
  const format = (content) => formatting ? formatCatContent(content, { showEnds, showTabs, showNumbers }) : content;
  if (parsed.positional.length === 0) {
    ctx.stdout.write(format(ctx.stdin));
    return;
  }
  for (const path of parsed.positional) {
    if (path === "-") {
      ctx.stdout.write(format(ctx.stdin));
      continue;
    }
    if (ctx.signal.aborted) throw new TerminalError("cat: aborted");
    let bytes;
    try {
      bytes = await ctx.fs.read(path);
    } catch (e) {
      throw new TerminalError(`cat: ${path}: ${describeError4(e)}`);
    }
    if (ctx.agentSink && looksLikeBinary(bytes)) {
      throw new TerminalError(
        `cat: ${path}: appears to be binary (${bytes.byteLength} bytes) \u2014 use 'xxd', 'hexdump', or 'head -c' for a controlled peek`
      );
    }
    ctx.stdout.write(format(decoder4.decode(bytes)));
  }
};
function looksLikeBinary(bytes) {
  if (bytes.byteLength === 0) return false;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 4096));
  let suspect = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) return true;
    if (b < 32 && b !== 9 && b !== 10 && b !== 13 || b === 127) {
      suspect++;
    }
  }
  return suspect / sample.length > 0.01;
}
function formatCatContent(content, opts) {
  const lines = splitLinesKeepEnds2(content);
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const hasNewline = original.endsWith("\n");
    let line = hasNewline ? original.slice(0, -1) : original;
    if (opts.showTabs) line = line.replaceAll("	", "^I");
    if (opts.showEnds) line = `${line}$`;
    if (opts.showNumbers) line = `${`${i + 1}`.padStart(6, " ")}  ${line}`;
    if (hasNewline) line = `${line}
`;
    result.push(line);
  }
  return result.join("");
}
var head = async (ctx) => {
  const args = preprocessLineShorthand(ctx.args);
  const parsed = parseArgs(
    args,
    {
      flags: {
        lines: { aliases: ["-n", "--lines"], takesValue: true },
        bytes: { aliases: ["-c", "--bytes"], takesValue: true }
      }
    },
    "head"
  );
  const linesLimit = parseIntegerFlag(parsed.flags.lines, 10, "head", "-n");
  const bytesLimit = parseIntegerFlag(parsed.flags.bytes, 0, "head", "-c");
  const byteMode = bytesLimit > 0;
  const limit = byteMode ? bytesLimit : linesLimit;
  const writeFromContent = (content) => {
    if (byteMode) {
      ctx.stdout.write(content.slice(0, limit));
      return;
    }
    const lines = splitLinesKeepEnds2(content);
    for (let i = 0; i < Math.min(limit, lines.length); i++) {
      ctx.stdout.write(lines[i]);
    }
  };
  if (parsed.positional.length === 0) {
    writeFromContent(ctx.stdin);
    return;
  }
  for (let i = 0; i < parsed.positional.length; i++) {
    const path = parsed.positional[i];
    if (parsed.positional.length > 1) ctx.stdout.write(`==> ${path} <==
`);
    try {
      const bytes = await ctx.fs.read(path);
      writeFromContent(decoder4.decode(bytes));
    } catch (e) {
      throw new TerminalError(`head: cannot open '${path}': ${describeError4(e)}`);
    }
    if (i < parsed.positional.length - 1) ctx.stdout.write("\n");
  }
};
var tail = async (ctx) => {
  const args = preprocessLineShorthand(ctx.args);
  const parsed = parseArgs(
    args,
    {
      flags: {
        lines: { aliases: ["-n", "--lines"], takesValue: true },
        bytes: { aliases: ["-c", "--bytes"], takesValue: true }
      }
    },
    "tail"
  );
  const bytesLimit = parseIntegerFlag(parsed.flags.bytes, 0, "tail", "-c");
  const byteMode = bytesLimit > 0;
  const writeFromContent = (content) => {
    if (byteMode) {
      ctx.stdout.write(content.slice(-bytesLimit));
      return;
    }
    const linesValue = parsed.flags.lines ?? "10";
    const fromStart = linesValue.startsWith("+");
    const limit = Number.parseInt(fromStart ? linesValue.slice(1) : linesValue, 10);
    if (Number.isNaN(limit) || limit < 0) {
      throw new TerminalError(`tail: invalid number of lines: '${linesValue}'`);
    }
    const lines = splitLinesKeepEnds2(content);
    const selected = fromStart ? lines.slice(limit - 1) : lines.slice(-limit);
    for (const line of selected) ctx.stdout.write(line);
  };
  if (parsed.positional.length === 0) {
    writeFromContent(ctx.stdin);
    return;
  }
  for (let i = 0; i < parsed.positional.length; i++) {
    const path = parsed.positional[i];
    if (parsed.positional.length > 1) ctx.stdout.write(`==> ${path} <==
`);
    try {
      const bytes = await ctx.fs.read(path);
      writeFromContent(decoder4.decode(bytes));
    } catch (e) {
      throw new TerminalError(`tail: cannot open '${path}': ${describeError4(e)}`);
    }
    if (i < parsed.positional.length - 1) ctx.stdout.write("\n");
  }
};
var tee = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: { append: { aliases: ["-a", "--append"] } }
    },
    "tee"
  );
  const content = ctx.stdin;
  ctx.stdout.write(content);
  const mode = parsed.flags.append === true ? "a" : "w";
  for (const path of parsed.positional) {
    try {
      await ctx.fs.write(path, encoder3.encode(content), mode);
    } catch (e) {
      throw new TerminalError(`tee: ${path}: ${describeError4(e)}`);
    }
  }
};
function preprocessLineShorthand(args) {
  if (args.length === 0) return [...args];
  const first = args[0];
  if (first.startsWith("-") && first.length > 1 && /^\d+$/.test(first.slice(1))) {
    return ["-n", first.slice(1), ...args.slice(1)];
  }
  return [...args];
}
function parseIntegerFlag(raw, fallback, prog, flag) {
  if (raw === void 0 || typeof raw === "boolean" || Array.isArray(raw)) return fallback;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n)) throw new TerminalError(`${prog}: invalid value for ${flag}: '${raw}'`);
  return n;
}
function splitLinesKeepEnds2(text) {
  const lines = [];
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      lines.push(text.slice(lineStart, i + 1));
      i++;
      lineStart = i;
    } else if (c === "\r") {
      const end = text[i + 1] === "\n" ? i + 2 : i + 1;
      lines.push(text.slice(lineStart, end));
      i = end;
      lineStart = end;
    } else {
      i++;
    }
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart));
  return lines;
}
function describeError4(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/builtins/search.ts
var decoder5 = new TextDecoder("utf-8", { fatal: false });
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function breAlternationToEre(pattern) {
  let out = "";
  let i = 0;
  let inClass = false;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (inClass) {
      if (ch === "\\") {
        out += "\\\\";
        i++;
      } else if (ch === "]") {
        inClass = false;
        out += ch;
        i++;
      } else {
        out += ch;
        i++;
      }
    } else if (ch === "\\" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "|") {
        out += "|";
        i += 2;
      } else {
        out += pattern.slice(i, i + 2);
        i += 2;
      }
    } else if (ch === "[") {
      inClass = true;
      out += "[";
      i++;
      if (pattern[i] === "^") {
        out += "^";
        i++;
      }
      if (pattern[i] === "]") {
        out += "]";
        i++;
      }
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}
async function collectFiles(userDir, fs) {
  let entries;
  try {
    entries = await fs.listDetailed(userDir, { recursive: true });
  } catch (e) {
    throw new TerminalError(`grep: ${userDir}: ${describeError5(e)}`);
  }
  return entries.filter((e) => !e.isDir).map((e) => e.path);
}
var grep = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        ignoreCase: { aliases: ["-i", "--ignore-case"] },
        lineNumber: { aliases: ["-n", "--line-number"] },
        recursive: { aliases: ["-r", "-R", "--recursive"] },
        filesWithMatches: { aliases: ["-l", "--files-with-matches"] },
        filesWithoutMatch: { aliases: ["-L", "--files-without-match"] },
        invert: { aliases: ["-v", "--invert-match"] },
        fixed: { aliases: ["-F", "--fixed-strings"] },
        extended: { aliases: ["-E", "--extended-regexp"] },
        after: { aliases: ["-A", "--after-context"], takesValue: true },
        before: { aliases: ["-B", "--before-context"], takesValue: true },
        context: { aliases: ["-C", "--context"], takesValue: true },
        count: { aliases: ["-c", "--count"] },
        word: { aliases: ["-w", "--word-regexp"] },
        only: { aliases: ["-o", "--only-matching"] },
        quiet: { aliases: ["-q", "--quiet", "--silent"] },
        maxCount: { aliases: ["-m", "--max-count"], takesValue: true },
        include: { aliases: ["--include"], takesValue: true },
        exclude: { aliases: ["--exclude"], takesValue: true },
        excludeDir: { aliases: ["--exclude-dir"], takesValue: true },
        withFilename: { aliases: ["-H", "--with-filename"] },
        noFilename: { aliases: ["-h", "--no-filename"] },
        // -e PATTERN can repeat
        patterns: { aliases: ["-e"], multi: true }
      }
    },
    "grep"
  );
  const explicitPatterns = parsed.flags.patterns;
  let patternsRaw;
  let files;
  if (explicitPatterns.length > 0) {
    patternsRaw = explicitPatterns;
    files = [...parsed.positional];
  } else {
    if (parsed.positional.length === 0) {
      throw new TerminalError("grep: no pattern given");
    }
    patternsRaw = [parsed.positional[0]];
    files = parsed.positional.slice(1);
  }
  const beforeRaw = numericFlag2(parsed.flags.before, 0);
  const afterRaw = numericFlag2(parsed.flags.after, 0);
  const ctxN = numericFlag2(parsed.flags.context, 0);
  const before = ctxN > 0 ? Math.max(beforeRaw, ctxN) : beforeRaw;
  const after = ctxN > 0 ? Math.max(afterRaw, ctxN) : afterRaw;
  const hasContext = before > 0 || after > 0;
  const pieces = [];
  for (const raw of patternsRaw) {
    let p = raw;
    if (parsed.flags.fixed === true) {
      p = escapeRegex(p);
    } else if (parsed.flags.extended !== true) {
      p = breAlternationToEre(p);
    }
    if (parsed.flags.word === true) p = `\\b${p}\\b`;
    pieces.push(`(?:${p})`);
  }
  const combined = pieces.join("|");
  const flagsStr = parsed.flags.ignoreCase === true ? "i" : "";
  let regex;
  let regexGlobal;
  try {
    regex = new RegExp(combined, flagsStr);
    regexGlobal = new RegExp(combined, `${flagsStr}g`);
  } catch (e) {
    throw new TerminalError(`grep: invalid regex: ${describeError5(e)}`);
  }
  const quiet = parsed.flags.quiet === true;
  const maxCountRaw = numericFlag2(parsed.flags.maxCount, 0);
  const maxCount = quiet && maxCountRaw === 0 ? 1 : maxCountRaw;
  const onlyMatching = parsed.flags.only === true;
  const filesWithMatches = parsed.flags.filesWithMatches === true;
  const filesWithoutMatch = parsed.flags.filesWithoutMatch === true;
  const noFilename = parsed.flags.noFilename === true;
  const withFilename = parsed.flags.withFilename === true;
  const lineNumber = parsed.flags.lineNumber === true;
  const invert = parsed.flags.invert === true;
  const countMode = parsed.flags.count === true;
  const realStdout = ctx.stdout;
  const sinkStdout = { write: () => void 0 };
  const stdout = quiet || filesWithoutMatch ? sinkStdout : realStdout;
  const processContent2 = (content, label) => {
    const lines = splitLines(content);
    let fileMatches = 0;
    if (countMode) {
      let n = 0;
      for (const line of lines) {
        const isMatch = regex.test(line) !== invert;
        if (isMatch) n++;
      }
      stdout.write(`${label !== null ? `${label}:` : ""}${n}
`);
      return n;
    }
    if (onlyMatching) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        regexGlobal.lastIndex = 0;
        let m;
        while ((m = regexGlobal.exec(line)) !== null) {
          fileMatches++;
          if (filesWithMatches) {
            if (label !== null) stdout.write(`${label}
`);
            return fileMatches;
          }
          let prefix = "";
          if (label !== null) prefix += `${label}:`;
          if (lineNumber) prefix += `${i + 1}:`;
          stdout.write(`${prefix}${m[0]}
`);
          if (maxCount > 0 && fileMatches >= maxCount) return fileMatches;
          if (m.index === regexGlobal.lastIndex) regexGlobal.lastIndex++;
        }
      }
      return fileMatches;
    }
    if (hasContext) {
      const matchingLines = /* @__PURE__ */ new Set();
      for (let i = 0; i < lines.length; i++) {
        const isMatch = regex.test(lines[i]) !== invert;
        if (isMatch) {
          matchingLines.add(i);
          if (filesWithMatches) {
            if (label !== null) stdout.write(`${label}
`);
            return matchingLines.size;
          }
          if (maxCount > 0 && matchingLines.size >= maxCount) break;
        }
      }
      const contextLines = /* @__PURE__ */ new Set();
      for (const idx of matchingLines) {
        const lo = Math.max(0, idx - before);
        const hi = Math.min(lines.length - 1, idx + after);
        for (let j = lo; j <= hi; j++) {
          if (!matchingLines.has(j)) contextLines.add(j);
        }
      }
      const all = [...matchingLines, ...contextLines].sort((a, b) => a - b);
      let prevIdx = -2;
      for (const idx of all) {
        if (prevIdx >= 0 && idx > prevIdx + 1) stdout.write("--\n");
        prevIdx = idx;
        const isMatch = matchingLines.has(idx);
        const sep = isMatch ? ":" : "-";
        let prefix = "";
        if (label !== null) prefix += `${label}${sep}`;
        if (lineNumber) prefix += `${idx + 1}${sep}`;
        stdout.write(`${prefix}${lines[idx]}
`);
      }
      return matchingLines.size;
    }
    for (let i = 0; i < lines.length; i++) {
      const isMatch = regex.test(lines[i]) !== invert;
      if (!isMatch) continue;
      fileMatches++;
      if (filesWithMatches) {
        if (label !== null) stdout.write(`${label}
`);
        return fileMatches;
      }
      let prefix = "";
      if (label !== null) prefix += `${label}:`;
      if (lineNumber) prefix += `${i + 1}:`;
      stdout.write(`${prefix}${lines[i]}
`);
      if (maxCount > 0 && fileMatches >= maxCount) return fileMatches;
    }
    return fileMatches;
  };
  let filesToSearch;
  if (files.length === 0 && parsed.flags.recursive !== true) {
    processContent2(ctx.stdin, null);
    return;
  }
  if (files.length === 0) {
    filesToSearch = await collectFiles(".", ctx.fs);
  } else {
    filesToSearch = [];
    for (const path of files) {
      if (await ctx.fs.isDir(path)) {
        const collected = await collectFiles(path, ctx.fs);
        filesToSearch.push(...collected);
      } else {
        filesToSearch.push(path);
      }
    }
  }
  if (typeof parsed.flags.include === "string") {
    const pat = parsed.flags.include;
    filesToSearch = filesToSearch.filter((f) => globMatch(pat, basename3(f)));
  }
  if (typeof parsed.flags.exclude === "string") {
    const pat = parsed.flags.exclude;
    filesToSearch = filesToSearch.filter((f) => !globMatch(pat, basename3(f)));
  }
  if (typeof parsed.flags.excludeDir === "string") {
    const pat = parsed.flags.excludeDir;
    filesToSearch = filesToSearch.filter((f) => {
      const parts = f.split("/").slice(0, -1);
      return !parts.some((p) => globMatch(pat, p));
    });
  }
  const multipleFiles = filesToSearch.length > 1 || parsed.flags.recursive === true;
  for (const filepath of filesToSearch) {
    let content;
    try {
      const bytes = await ctx.fs.read(filepath);
      content = decoder5.decode(bytes);
    } catch (e) {
      throw new TerminalError(`grep: ${filepath}: ${describeError5(e)}`);
    }
    let label;
    if (noFilename) label = null;
    else if (withFilename) label = filepath;
    else if (multipleFiles || filesWithMatches || filesWithoutMatch) label = filepath;
    else label = null;
    const m = processContent2(content, label);
    if (filesWithoutMatch && m === 0) realStdout.write(`${filepath}
`);
  }
};
function basename3(p) {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}
function splitLines(text) {
  if (text.length === 0) return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}
function numericFlag2(raw, fallback) {
  if (typeof raw !== "string") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : n;
}
var NamePred = class {
  constructor(pattern) {
    this.pattern = pattern;
  }
  pattern;
  async matches(item) {
    return globMatch(this.pattern, item.name);
  }
};
var INamePred = class {
  pattern;
  constructor(pattern) {
    this.pattern = pattern.toLowerCase();
  }
  async matches(item) {
    return globMatch(this.pattern, item.name.toLowerCase());
  }
};
var PathPred = class {
  constructor(pattern) {
    this.pattern = pattern;
  }
  pattern;
  async matches(item) {
    return globMatch(this.pattern, item.path);
  }
};
var TypePred = class {
  constructor(kind) {
    this.kind = kind;
  }
  kind;
  async matches(item) {
    return this.kind === "f" ? !item.isDir : item.isDir;
  }
};
var EmptyPred = class {
  async matches(item, fs) {
    if (item.isDir) {
      try {
        const entries = await fs.list(item.path);
        return entries.length === 0;
      } catch {
        return false;
      }
    }
    return item.size === 0;
  }
};
var SizePred = class {
  threshold;
  compare;
  constructor(spec) {
    if (spec.length === 0) throw new TerminalError("find: -size requires an argument");
    let s = spec;
    let cmp = "eq";
    if (s.startsWith("+")) {
      cmp = "gt";
      s = s.slice(1);
    } else if (s.startsWith("-")) {
      cmp = "lt";
      s = s.slice(1);
    }
    const multipliers = { c: 1, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };
    let mult = 512;
    const last = s[s.length - 1];
    if (last !== void 0 && last in multipliers) {
      mult = multipliers[last];
      s = s.slice(0, -1);
    }
    const n = Number.parseInt(s, 10);
    if (Number.isNaN(n)) throw new TerminalError(`find: invalid size: ${spec}`);
    this.threshold = n * mult;
    this.compare = cmp;
  }
  async matches(item) {
    if (this.compare === "gt") return item.size > this.threshold;
    if (this.compare === "lt") return item.size < this.threshold;
    return item.size === this.threshold;
  }
};
var PrintPred = class {
  constructor(stdout) {
    this.stdout = stdout;
  }
  stdout;
  async matches(item) {
    this.stdout.write(`${item.path}
`);
    return true;
  }
};
var DeletePred = class {
  async matches(item, fs) {
    try {
      if (item.isDir) await fs.rmdir(item.path);
      else await fs.remove(item.path);
    } catch {
      return false;
    }
    return true;
  }
};
var ExecPred = class {
  constructor(cmdTokens, stdout, executor) {
    this.cmdTokens = cmdTokens;
    this.stdout = stdout;
    this.executor = executor;
  }
  cmdTokens;
  stdout;
  executor;
  async matches(item, fs) {
    const expanded = this.cmdTokens.map((t) => t.replaceAll("{}", item.path));
    const cmdStr = shellJoin(expanded);
    try {
      const output = await this.executor(cmdStr, fs);
      if (output.length > 0) this.stdout.write(output);
    } catch {
      return false;
    }
    return true;
  }
};
var ExecBatchPred = class {
  constructor(cmdTokens, stdout, executor) {
    this.cmdTokens = cmdTokens;
    this.stdout = stdout;
    this.executor = executor;
  }
  cmdTokens;
  stdout;
  executor;
  collected = [];
  async matches(item) {
    this.collected.push(item.path);
    return true;
  }
  async finalize(fs) {
    if (this.collected.length === 0) return;
    const expanded = [];
    for (const t of this.cmdTokens) {
      if (t === "{}") expanded.push(...this.collected);
      else expanded.push(t);
    }
    const cmdStr = shellJoin(expanded);
    try {
      const output = await this.executor(cmdStr, fs);
      if (output.length > 0) this.stdout.write(output);
    } catch {
    }
  }
};
var AndPred = class {
  constructor(left, right) {
    this.left = left;
    this.right = right;
  }
  left;
  right;
  async matches(item, fs) {
    if (!await this.left.matches(item, fs)) return false;
    return this.right.matches(item, fs);
  }
};
var OrPred = class {
  constructor(left, right) {
    this.left = left;
    this.right = right;
  }
  left;
  right;
  async matches(item, fs) {
    if (await this.left.matches(item, fs)) return true;
    return this.right.matches(item, fs);
  }
};
var NotPred = class {
  constructor(child) {
    this.child = child;
  }
  child;
  async matches(item, fs) {
    return !await this.child.matches(item, fs);
  }
};
var TruePred = class {
  async matches() {
    return true;
  }
};
function shellJoin(tokens) {
  return tokens.map((t) => {
    if (t.includes(" ") || t.includes("	")) {
      return `'${t.replaceAll("'", "'\\''")}'`;
    }
    return t;
  }).join(" ");
}
function hasAction(p) {
  if (p instanceof PrintPred || p instanceof DeletePred) return true;
  if (p instanceof ExecPred || p instanceof ExecBatchPred) return true;
  if (p instanceof AndPred || p instanceof OrPred) return hasAction(p.left) || hasAction(p.right);
  if (p instanceof NotPred) return hasAction(p.child);
  return false;
}
async function finalizeBatch(p, fs) {
  if (p instanceof ExecBatchPred) {
    await p.finalize(fs);
  } else if (p instanceof AndPred || p instanceof OrPred) {
    await finalizeBatch(p.left, fs);
    await finalizeBatch(p.right, fs);
  } else if (p instanceof NotPred) {
    await finalizeBatch(p.child, fs);
  }
}
function parseFindPredicates(tokens, parseCtx) {
  if (tokens.length === 0) return new TruePred();
  let pos = 0;
  const parsePrimary = () => {
    if (pos >= tokens.length) throw new TerminalError("find: expected expression");
    const tok = tokens[pos];
    if (tok === "(") {
      pos++;
      const node = parseOr();
      if (pos >= tokens.length || tokens[pos] !== ")") {
        throw new TerminalError("find: missing closing ')'");
      }
      pos++;
      return node;
    }
    if (tok === "-name") {
      pos++;
      if (pos >= tokens.length) throw new TerminalError("find: -name requires a pattern");
      return new NamePred(tokens[pos++]);
    }
    if (tok === "-iname") {
      pos++;
      if (pos >= tokens.length) throw new TerminalError("find: -iname requires a pattern");
      return new INamePred(tokens[pos++]);
    }
    if (tok === "-path") {
      pos++;
      if (pos >= tokens.length) throw new TerminalError("find: -path requires a pattern");
      return new PathPred(tokens[pos++]);
    }
    if (tok === "-print") {
      pos++;
      return new PrintPred(parseCtx.stdout);
    }
    if (tok === "-delete") {
      pos++;
      return new DeletePred();
    }
    if (tok === "-type") {
      pos++;
      if (pos >= tokens.length) throw new TerminalError("find: -type requires an argument");
      const kind = tokens[pos++];
      if (kind !== "f" && kind !== "d") {
        throw new TerminalError(`find: unknown type '${kind}' (use 'f' or 'd')`);
      }
      return new TypePred(kind);
    }
    if (tok === "-empty") {
      pos++;
      return new EmptyPred();
    }
    if (tok === "-size") {
      pos++;
      if (pos >= tokens.length) throw new TerminalError("find: -size requires an argument");
      let spec = tokens[pos++];
      if ((spec === "+" || spec === "-") && pos < tokens.length) {
        spec = spec + tokens[pos++];
      }
      return new SizePred(spec);
    }
    if (tok === "-exec") {
      pos++;
      const cmdTokens = [];
      while (pos < tokens.length && tokens[pos] !== ";" && tokens[pos] !== "+") {
        cmdTokens.push(tokens[pos++]);
      }
      if (pos >= tokens.length) {
        throw new TerminalError("find: -exec requires terminating ';' or '+'");
      }
      const batch = tokens[pos] === "+";
      pos++;
      if (cmdTokens.length === 0) throw new TerminalError("find: -exec requires a command");
      return batch ? new ExecBatchPred(cmdTokens, parseCtx.stdout, parseCtx.executor) : new ExecPred(cmdTokens, parseCtx.stdout, parseCtx.executor);
    }
    throw new TerminalError(`find: unknown predicate: ${tok}`);
  };
  const parseUnary = () => {
    if (pos >= tokens.length) throw new TerminalError("find: expected expression");
    const tok = tokens[pos];
    if (tok === "-not" || tok === "!") {
      pos++;
      return new NotPred(parseUnary());
    }
    return parsePrimary();
  };
  const parseAnd = () => {
    let left = parseUnary();
    while (pos < tokens.length) {
      const tok = tokens[pos];
      if (tok === "-a" || tok === "-and") {
        pos++;
        left = new AndPred(left, parseUnary());
      } else if (tok !== "-o" && tok !== "-or" && tok !== ")") {
        left = new AndPred(left, parseUnary());
      } else {
        break;
      }
    }
    return left;
  };
  const parseOr = () => {
    let left = parseAnd();
    while (pos < tokens.length && (tokens[pos] === "-o" || tokens[pos] === "-or")) {
      pos++;
      left = new OrPred(left, parseAnd());
    }
    return left;
  };
  const result = parseOr();
  if (pos < tokens.length) throw new TerminalError(`find: unexpected token: ${tokens[pos]}`);
  return result;
}
var find = async (ctx) => {
  let rootPath = ".";
  let maxdepth = null;
  let mindepth = null;
  const predicateTokens = [];
  const args = ctx.args;
  let i = 0;
  if (i < args.length) {
    const first = args[i];
    if (!first.startsWith("-") && first !== "(" && first !== "!") {
      rootPath = first;
      i++;
    }
  }
  while (i < args.length) {
    const tok = args[i];
    if (tok === "-maxdepth") {
      i++;
      if (i >= args.length) throw new TerminalError("find: -maxdepth requires an argument");
      const n = Number.parseInt(args[i++], 10);
      if (Number.isNaN(n)) throw new TerminalError("find: invalid argument to -maxdepth");
      maxdepth = n;
    } else if (tok === "-mindepth") {
      i++;
      if (i >= args.length) throw new TerminalError("find: -mindepth requires an argument");
      const n = Number.parseInt(args[i++], 10);
      if (Number.isNaN(n)) throw new TerminalError("find: invalid argument to -mindepth");
      mindepth = n;
    } else {
      predicateTokens.push(tok);
      i++;
    }
  }
  const executor = async (cmdStr, fs) => {
    const { execute: execute2 } = await import('./interpreter-I3RIZ375.js');
    return execute2(cmdStr, fs, { signal: ctx.signal, commands: ctx.commands });
  };
  const predicate = parseFindPredicates(predicateTokens, {
    stdout: ctx.stdout,
    executor
  });
  const actionPresent = hasAction(predicate);
  let items;
  try {
    items = await ctx.fs.listDetailed(rootPath, { recursive: true });
  } catch (e) {
    throw new TerminalError(`find: ${describeError5(e)}`);
  }
  const prefix = rootPath.replace(/\/$/, "");
  for (const item of items) {
    if (ctx.signal.aborted) throw new TerminalError("find: aborted");
    const rel = item.path.startsWith(`${prefix}/`) ? item.path.slice(prefix.length + 1) : item.name;
    const depth = rel.split("/").length;
    if (maxdepth !== null && depth > maxdepth) continue;
    if (mindepth !== null && depth < mindepth) continue;
    let matched;
    try {
      matched = await predicate.matches(item, ctx.fs);
    } catch (e) {
      if (e instanceof TerminalError) throw e;
      continue;
    }
    if (!matched) continue;
    if (!actionPresent) ctx.stdout.write(`${item.path}
`);
  }
  await finalizeBatch(predicate, ctx.fs);
};
function describeError5(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/builtins/sed.ts
var decoder6 = new TextDecoder("utf-8", { fatal: false });
var encoder4 = new TextEncoder();
function scanDelimited(text, pos, delim) {
  const out = [];
  let i = pos;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const next = text[i + 1];
      if (next === delim) {
        out.push(delim);
        i += 2;
      } else {
        out.push(ch + next);
        i += 2;
      }
    } else if (ch === delim) {
      return [out.join(""), i + 1];
    } else {
      out.push(ch);
      i++;
    }
  }
  throw new TerminalError("sed: unterminated 's' command");
}
function translateReplacement(repl) {
  const out = [];
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c === "\\" && i + 1 < repl.length) {
      const next = repl[i + 1];
      if (next === "&") {
        out.push("&");
      } else if (next === "n") {
        out.push("\n");
      } else if (next === "t") {
        out.push("	");
      } else if (next === "\\") {
        out.push("\\");
      } else if (/[1-9]/.test(next)) {
        out.push(`$${next}`);
      } else if (next === "$") {
        out.push("$$");
      } else {
        out.push(next);
      }
      i += 2;
    } else if (c === "&") {
      out.push("$&");
      i++;
    } else if (c === "$") {
      out.push("$$");
      i++;
    } else {
      out.push(c);
      i++;
    }
  }
  return out.join("");
}
function parseAddress(text, pos) {
  if (pos >= text.length) return [null, pos];
  const ch = text[pos];
  if (/\d/.test(ch)) {
    let end = pos;
    while (end < text.length && /\d/.test(text[end])) end++;
    return [{ line: Number.parseInt(text.slice(pos, end), 10) }, end];
  }
  if (ch === "$") return [{ last: true }, pos + 1];
  if (ch === "/") {
    const [content, newPos] = scanDelimited(text, pos + 1, "/");
    let regex;
    try {
      regex = new RegExp(content);
    } catch (e) {
      throw new TerminalError(`sed: invalid regex in address: ${describeError6(e)}`);
    }
    return [{ regex }, newPos];
  }
  return [null, pos];
}
function parseSubstitution(text, pos) {
  if (pos >= text.length) throw new TerminalError("sed: unterminated 's' command");
  const delim = text[pos];
  if (/[a-zA-Z0-9]/.test(delim) || delim === "\\" || delim === "\n") {
    throw new TerminalError(`sed: invalid delimiter '${delim}'`);
  }
  const [pattern, afterPat] = scanDelimited(text, pos + 1, delim);
  const [rawRepl, afterRepl] = scanDelimited(text, afterPat, delim);
  let i = afterRepl;
  let flags = "";
  while (i < text.length && /[gip]/.test(text[i])) {
    flags += text[i];
    i++;
  }
  if (pattern.length === 0) throw new TerminalError("sed: empty regex in substitution");
  let regex;
  try {
    const jsFlags = (flags.includes("i") ? "i" : "") + (flags.includes("g") ? "g" : "");
    regex = new RegExp(pattern, jsFlags);
  } catch (e) {
    throw new TerminalError(`sed: invalid regex: ${describeError6(e)}`);
  }
  return [regex, translateReplacement(rawRepl), flags, i];
}
function parseSingleCommand(rawText) {
  const text = rawText.trim();
  if (text.length === 0) throw new TerminalError("sed: empty command");
  let pos = 0;
  const [addr1, p1] = parseAddress(text, pos);
  pos = p1;
  let addr2 = null;
  if (addr1 !== null && pos < text.length && text[pos] === ",") {
    pos++;
    [addr2, pos] = parseAddress(text, pos);
    if (addr2 === null) throw new TerminalError("sed: invalid address range");
  }
  const addressRange = {
    ...addr1 !== null && { addr1 },
    ...addr2 !== null && { addr2 }
  };
  if (pos >= text.length) throw new TerminalError("sed: missing command");
  const cmdChar = text[pos];
  pos++;
  let cmd;
  if (cmdChar === "s") {
    const [pattern, replacement, subFlags, newPos] = parseSubstitution(text, pos);
    pos = newPos;
    cmd = { address: addressRange, command: "s", pattern, replacement, subFlags };
  } else if (cmdChar === "y") {
    if (pos >= text.length) throw new TerminalError("sed: unterminated 'y' command");
    const delim = text[pos];
    pos++;
    let set1;
    let set2;
    [set1, pos] = scanDelimited(text, pos, delim);
    [set2, pos] = scanDelimited(text, pos, delim);
    if (set1.length !== set2.length) {
      throw new TerminalError(
        `sed: 'y' command sets must be same length (${set1.length} vs ${set2.length})`
      );
    }
    cmd = { address: addressRange, command: "y", replacement: set1, subFlags: set2 };
  } else if (cmdChar === "p" || cmdChar === "d" || cmdChar === "q") {
    cmd = { address: addressRange, command: cmdChar };
  } else if (cmdChar === "a" || cmdChar === "i" || cmdChar === "c") {
    let rest = text.slice(pos);
    if (rest.startsWith("\\")) rest = rest.slice(1);
    else if (rest.startsWith(" ")) rest = rest.replace(/^ +/, "");
    rest = rest.replaceAll("\\n", "\n");
    cmd = { address: addressRange, command: cmdChar, text: rest };
    pos = text.length;
  } else {
    throw new TerminalError(`sed: unknown command: '${cmdChar}'`);
  }
  const trailing = text.slice(pos).trim();
  if (trailing.length > 0) throw new TerminalError(`sed: trailing characters: '${trailing}'`);
  return cmd;
}
function splitScript(script) {
  const parts = [];
  let current = "";
  let i = 0;
  let delimChar = "";
  let delimRemaining = 0;
  let inTextCmd = false;
  while (i < script.length) {
    const ch = script[i];
    if (inTextCmd) {
      if (ch === "\n") {
        const part = current.trim();
        if (part.length > 0) parts.push(part);
        current = "";
        inTextCmd = false;
        i++;
        continue;
      }
      current += ch;
      i++;
      continue;
    }
    if (delimRemaining > 0) {
      current += ch;
      if (ch === "\\" && i + 1 < script.length) {
        current += script[i + 1];
        i += 2;
        continue;
      }
      if (ch === delimChar) delimRemaining--;
      i++;
      continue;
    }
    if (ch === "s" || ch === "y") {
      current += ch;
      i++;
      if (i < script.length && !/[a-zA-Z0-9]/.test(script[i])) {
        delimChar = script[i];
        delimRemaining = 2;
        current += script[i];
        i++;
      }
      continue;
    }
    if ((ch === "a" || ch === "i" || ch === "c") && (current.length === 0 || "," === current[current.length - 1] || " " === current[current.length - 1])) {
      current += ch;
      i++;
      inTextCmd = true;
      continue;
    }
    if (ch === ";" || ch === "\n") {
      const part = current.trim();
      if (part.length > 0) parts.push(part);
      current = "";
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  const last = current.trim();
  if (last.length > 0) parts.push(last);
  return parts;
}
function parseSedScript(script) {
  return splitScript(script).map(parseSingleCommand);
}
function singleAddrMatches(addr, lineNum, totalLines, lineContent) {
  if (addr.last === true) return lineNum === totalLines;
  if (addr.line !== void 0) return lineNum === addr.line;
  if (addr.regex !== void 0) return addr.regex.test(lineContent);
  return false;
}
function checkAddress(addrRange, lineNum, totalLines, lineContent, rangeActive, idx) {
  if (addrRange.addr1 === void 0) return true;
  if (addrRange.addr2 === void 0) {
    return singleAddrMatches(addrRange.addr1, lineNum, totalLines, lineContent);
  }
  if (rangeActive[idx]) {
    if (singleAddrMatches(addrRange.addr2, lineNum, totalLines, lineContent)) {
      rangeActive[idx] = false;
    }
    return true;
  }
  if (singleAddrMatches(addrRange.addr1, lineNum, totalLines, lineContent)) {
    rangeActive[idx] = true;
    if (singleAddrMatches(addrRange.addr2, lineNum, totalLines, lineContent)) {
      rangeActive[idx] = false;
    }
    return true;
  }
  return false;
}
function processContent(content, commands, suppress) {
  if (content.length === 0) return "";
  const lines = splitLinesKeepEnds3(content);
  const hadTrailingNewline = content.endsWith("\n");
  if (lines.length > 0 && !lines[lines.length - 1].endsWith("\n")) {
    lines[lines.length - 1] = `${lines[lines.length - 1]}
`;
  }
  const totalLines = lines.length;
  const rangeActive = new Array(commands.length).fill(false);
  const outputLines = [];
  let quitAfter = false;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineNum = lineIdx + 1;
    let lineContent = lines[lineIdx].replace(/\n$/, "");
    let shouldPrint = !suppress;
    let deleted = false;
    const appendQueue = [];
    for (let cmdIdx = 0; cmdIdx < commands.length; cmdIdx++) {
      if (deleted) break;
      const cmd = commands[cmdIdx];
      if (!checkAddress(cmd.address, lineNum, totalLines, lineContent, rangeActive, cmdIdx)) {
        continue;
      }
      if (cmd.command === "s") {
        const flags = cmd.subFlags ?? "";
        const regex = cmd.pattern;
        const repl = cmd.replacement ?? "";
        let numSubs = 0;
        lineContent = lineContent.replace(regex, (match, ...rest) => {
          numSubs++;
          return applyReplacement(repl, match, rest);
        });
        if (numSubs > 0 && flags.includes("p")) {
          outputLines.push(`${lineContent}
`);
        }
      } else if (cmd.command === "y") {
        const set1 = cmd.replacement;
        const set2 = cmd.subFlags;
        const map = /* @__PURE__ */ new Map();
        for (let k = 0; k < set1.length; k++) {
          map.set(set1[k], set2[k]);
        }
        let translated = "";
        for (const c of lineContent) translated += map.get(c) ?? c;
        lineContent = translated;
      } else if (cmd.command === "p") {
        outputLines.push(`${lineContent}
`);
      } else if (cmd.command === "d") {
        deleted = true;
        shouldPrint = false;
      } else if (cmd.command === "a") {
        appendQueue.push(`${cmd.text ?? ""}
`);
      } else if (cmd.command === "i") {
        outputLines.push(`${cmd.text ?? ""}
`);
      } else if (cmd.command === "c") {
        outputLines.push(`${cmd.text ?? ""}
`);
        deleted = true;
        shouldPrint = false;
      } else if (cmd.command === "q") {
        if (shouldPrint) outputLines.push(`${lineContent}
`);
        quitAfter = true;
        shouldPrint = false;
        break;
      }
    }
    if (shouldPrint && !deleted) outputLines.push(`${lineContent}
`);
    for (const a of appendQueue) outputLines.push(a);
    if (quitAfter) break;
  }
  let result = outputLines.join("");
  if (!hadTrailingNewline && result.endsWith("\n")) {
    result = result.slice(0, -1);
  }
  return result;
}
function applyReplacement(repl, match, groups) {
  const captures = groups.slice(0, -2);
  let out = "";
  let i = 0;
  while (i < repl.length) {
    const c = repl[i];
    if (c === "$" && i + 1 < repl.length) {
      const next = repl[i + 1];
      if (next === "&") {
        out += match;
        i += 2;
        continue;
      }
      if (next === "$") {
        out += "$";
        i += 2;
        continue;
      }
      if (/[1-9]/.test(next)) {
        const idx = Number.parseInt(next, 10) - 1;
        out += captures[idx] ?? "";
        i += 2;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}
var sed = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        quiet: { aliases: ["-n", "--quiet", "--silent"] },
        inPlace: { aliases: ["-i", "--in-place"] },
        expression: { aliases: ["-e", "--expression"], multi: true },
        // -E/-r: extended regex; JS RegExp is ERE-flavored, so accept and ignore.
        extended: { aliases: ["-E", "-r", "--regexp-extended"] }
      }
    },
    "sed"
  );
  const explicitExprs = parsed.flags.expression;
  let expressions;
  let files;
  if (explicitExprs.length > 0) {
    expressions = explicitExprs;
    files = [...parsed.positional];
  } else {
    if (parsed.positional.length === 0) {
      throw new TerminalError("sed: no expression given");
    }
    expressions = [parsed.positional[0]];
    files = parsed.positional.slice(1);
  }
  const commands = [];
  for (const expr of expressions) {
    for (const c of parseSedScript(expr)) commands.push(c);
  }
  if (commands.length === 0) throw new TerminalError("sed: no expression given");
  const inPlace = parsed.flags.inPlace === true;
  if (inPlace && files.length === 0) {
    throw new TerminalError("sed: -i requires at least one file argument");
  }
  const quiet = parsed.flags.quiet === true;
  if (files.length === 0) {
    const result = processContent(ctx.stdin, commands, quiet);
    ctx.stdout.write(result);
    return;
  }
  for (const path of files) {
    let content;
    try {
      const bytes = await ctx.fs.read(path);
      content = decoder6.decode(bytes);
    } catch (e) {
      throw new TerminalError(`sed: ${path}: ${describeError6(e)}`);
    }
    const result = processContent(content, commands, quiet);
    if (inPlace) {
      await ctx.fs.write(path, encoder4.encode(result), "w");
    } else {
      ctx.stdout.write(result);
    }
  }
};
function splitLinesKeepEnds3(text) {
  if (text.length === 0) return [];
  const lines = [];
  let i = 0;
  let lineStart = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\n") {
      lines.push(text.slice(lineStart, i + 1));
      i++;
      lineStart = i;
    } else if (c === "\r") {
      const end = text[i + 1] === "\n" ? i + 2 : i + 1;
      lines.push(text.slice(lineStart, end));
      i = end;
      lineStart = end;
    } else {
      i++;
    }
  }
  if (lineStart < text.length) lines.push(text.slice(lineStart));
  return lines;
}
function describeError6(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/builtins/text.ts
var decoder7 = new TextDecoder("utf-8", { fatal: false });
var encoder5 = new TextEncoder();
var wc = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        lines: { aliases: ["-l", "--lines"] },
        words: { aliases: ["-w", "--words"] },
        bytes: { aliases: ["-c", "--bytes"] },
        chars: { aliases: ["-m", "--chars"] },
        maxLine: { aliases: ["-L", "--max-line-length"] }
      }
    },
    "wc"
  );
  let showLines = parsed.flags.lines === true;
  let showWords = parsed.flags.words === true;
  let showBytes = parsed.flags.bytes === true || parsed.flags.chars === true;
  const showMaxLine = parsed.flags.maxLine === true;
  if (!showLines && !showWords && !showBytes && !showMaxLine) {
    showLines = true;
    showWords = true;
    showBytes = true;
  }
  const totals = { lines: 0, words: 0, bytes: 0, maxLine: 0 };
  const results = [];
  const countContent = (content, name) => {
    const lines = content.split("\n");
    const linesNoEmptyTail = lines[lines.length - 1] === "" ? lines.slice(0, -1) : lines;
    let maxLine = 0;
    for (const line of linesNoEmptyTail) {
      if (line.length > maxLine) maxLine = line.length;
    }
    const counts = {
      lines: countOccurrences(content, "\n"),
      words: content.trim().length === 0 ? 0 : content.split(/\s+/).filter((w) => w.length > 0).length,
      bytes: encoder5.encode(content).byteLength,
      maxLine
    };
    results.push({ counts, name });
    totals.lines += counts.lines;
    totals.words += counts.words;
    totals.bytes += counts.bytes;
    if (counts.maxLine > totals.maxLine) totals.maxLine = counts.maxLine;
  };
  if (parsed.positional.length === 0) {
    countContent(ctx.stdin, "");
  } else {
    for (const path of parsed.positional) {
      try {
        const bytes = await ctx.fs.read(path);
        countContent(decoder7.decode(bytes), path);
      } catch (e) {
        throw new TerminalError(`wc: ${path}: ${describeError7(e)}`);
      }
    }
  }
  const maxVal = Math.max(totals.bytes, totals.words, totals.lines, totals.maxLine, 1);
  const width = `${maxVal}`.length;
  const formatLine = (c, name) => {
    const parts = [];
    if (showLines) parts.push(`${c.lines}`.padStart(width));
    if (showWords) parts.push(`${c.words}`.padStart(width));
    if (showBytes) parts.push(`${c.bytes}`.padStart(width));
    if (showMaxLine) parts.push(`${c.maxLine}`.padStart(width));
    let line = parts.join(" ");
    if (name.length > 0) line += ` ${name}`;
    return line;
  };
  for (const { counts, name } of results) ctx.stdout.write(`${formatLine(counts, name)}
`);
  if (results.length > 1) ctx.stdout.write(`${formatLine(totals, "total")}
`);
};
function countOccurrences(s, ch) {
  let n = 0;
  let i = s.indexOf(ch);
  while (i !== -1) {
    n++;
    i = s.indexOf(ch, i + 1);
  }
  return n;
}
var sort = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        reverse: { aliases: ["-r", "--reverse"] },
        numeric: { aliases: ["-n", "--numeric-sort"] },
        unique: { aliases: ["-u", "--unique"] },
        ignoreCase: { aliases: ["-f", "--ignore-case"] },
        // -k can appear multiple times; we record only the *last* one
        // here (parseArgs doesn't accumulate). Multi-key sorts would
        // need a parser extension — no current consumer needs it.
        key: { aliases: ["-k", "--key"], takesValue: true },
        sep: { aliases: ["-t", "--field-separator"], takesValue: true }
      }
    },
    "sort"
  );
  const lines = [];
  if (parsed.positional.length === 0) {
    pushLines(ctx.stdin, lines);
  } else {
    for (const path of parsed.positional) {
      try {
        const bytes = await ctx.fs.read(path);
        pushLines(decoder7.decode(bytes), lines);
      } catch (e) {
        throw new TerminalError(`sort: ${path}: ${describeError7(e)}`);
      }
    }
  }
  const sep = typeof parsed.flags.sep === "string" ? parsed.flags.sep : null;
  let fieldNum = null;
  if (typeof parsed.flags.key === "string") {
    const spec = parsed.flags.key;
    const parsedField = Number.parseInt(spec.split(",")[0]?.split(".")[0] ?? "", 10);
    if (Number.isNaN(parsedField)) {
      throw new TerminalError(`sort: invalid field specification: ${spec}`);
    }
    fieldNum = parsedField;
  }
  const ignoreCase = parsed.flags.ignoreCase === true;
  const numeric = parsed.flags.numeric === true;
  const keyOf = (line) => {
    let value = line;
    if (fieldNum !== null) {
      const fields = sep !== null ? line.split(sep) : line.split(/\s+/).filter((s) => s.length > 0);
      value = fields[fieldNum - 1] ?? "";
    }
    if (ignoreCase) value = value.toLowerCase();
    if (numeric) {
      const n = Number.parseFloat(value);
      if (Number.isFinite(n)) return [0, n];
      return [1, value];
    }
    return value;
  };
  const compareKeys = (a, b) => {
    if (typeof a === "string" && typeof b === "string") {
      return a < b ? -1 : a > b ? 1 : 0;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
      const av = a[1];
      const bv = b[1];
      if (typeof av === "number" && typeof bv === "number") return av - bv;
      const as = `${av}`;
      const bs = `${bv}`;
      return as < bs ? -1 : as > bs ? 1 : 0;
    }
    return 0;
  };
  const indexed = lines.map((line, idx) => ({ line, key: keyOf(line), idx }));
  indexed.sort((a, b) => {
    const c = compareKeys(a.key, b.key);
    if (c !== 0) return parsed.flags.reverse === true ? -c : c;
    return a.idx - b.idx;
  });
  let sorted = indexed.map((e) => e.line);
  if (parsed.flags.unique === true) {
    const seen = /* @__PURE__ */ new Set();
    const out = [];
    for (const line of sorted) {
      const k = stableSerialize(keyOf(line));
      if (!seen.has(k)) {
        seen.add(k);
        out.push(line);
      }
    }
    sorted = out;
  }
  for (const line of sorted) ctx.stdout.write(`${line}
`);
};
function pushLines(text, into) {
  const split = text.split("\n");
  if (split.length > 0 && split[split.length - 1] === "") split.pop();
  for (const line of split) into.push(line);
}
function stableSerialize(key) {
  if (typeof key === "string") return `s:${key}`;
  return `t:${key[0]}:${typeof key[1] === "number" ? `n:${key[1]}` : `x:${key[1]}`}`;
}
var uniq = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        count: { aliases: ["-c", "--count"] },
        repeated: { aliases: ["-d", "--repeated"] },
        unique: { aliases: ["-u", "--unique"] },
        ignoreCase: { aliases: ["-i", "--ignore-case"] }
      },
      maxPositional: 1
    },
    "uniq"
  );
  const lines = [];
  if (parsed.positional.length === 0) {
    pushLines(ctx.stdin, lines);
  } else {
    const path = parsed.positional[0];
    try {
      const bytes = await ctx.fs.read(path);
      pushLines(decoder7.decode(bytes), lines);
    } catch (e) {
      throw new TerminalError(`uniq: ${path}: ${describeError7(e)}`);
    }
  }
  if (lines.length === 0) return;
  const compareKey = (line) => parsed.flags.ignoreCase === true ? line.toLowerCase() : line;
  const groups = [];
  let currentLine = lines[0];
  let currentKey = compareKey(currentLine);
  let count = 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    const key = compareKey(line);
    if (key === currentKey) {
      count++;
    } else {
      groups.push({ count, line: currentLine });
      currentLine = line;
      currentKey = key;
      count = 1;
    }
  }
  groups.push({ count, line: currentLine });
  for (const { count: n, line } of groups) {
    if (parsed.flags.repeated === true && n === 1) continue;
    if (parsed.flags.unique === true && n > 1) continue;
    if (parsed.flags.count === true) {
      ctx.stdout.write(`${`${n}`.padStart(7, " ")} ${line}
`);
    } else {
      ctx.stdout.write(`${line}
`);
    }
  }
};
var cut = async (ctx) => {
  const parsed = parseArgs(
    ctx.args,
    {
      flags: {
        delimiter: { aliases: ["-d", "--delimiter"], takesValue: true },
        fields: { aliases: ["-f", "--fields"], takesValue: true },
        characters: { aliases: ["-c", "--characters"], takesValue: true },
        bytes: { aliases: ["-b", "--bytes"], takesValue: true },
        complement: { aliases: ["--complement"] },
        outputDelim: { aliases: ["--output-delimiter"], takesValue: true }
      }
    },
    "cut"
  );
  let delimiter = typeof parsed.flags.delimiter === "string" ? parsed.flags.delimiter : "	";
  delimiter = delimiter.replaceAll("\\t", "	").replaceAll("\\n", "\n");
  const fieldsSpec = parsed.flags.fields;
  const charsSpec = parsed.flags.characters;
  const bytesSpec = parsed.flags.bytes;
  if (typeof fieldsSpec !== "string" && typeof charsSpec !== "string" && typeof bytesSpec !== "string") {
    throw new TerminalError("cut: you must specify -f (fields), -c (characters), or -b (bytes)");
  }
  let mode;
  let spec;
  if (typeof fieldsSpec === "string") {
    mode = "fields";
    spec = fieldsSpec;
  } else if (typeof charsSpec === "string") {
    mode = "chars";
    spec = charsSpec;
  } else {
    mode = "chars";
    spec = bytesSpec;
  }
  const ranges = parseRanges(spec, mode);
  const outDelim = typeof parsed.flags.outputDelim === "string" ? parsed.flags.outputDelim : delimiter;
  const lines = [];
  if (parsed.positional.length === 0) {
    pushLines(ctx.stdin, lines);
  } else {
    for (const path of parsed.positional) {
      try {
        const bytes = await ctx.fs.read(path);
        pushLines(decoder7.decode(bytes), lines);
      } catch (e) {
        throw new TerminalError(`cut: ${path}: ${describeError7(e)}`);
      }
    }
  }
  const complement = parsed.flags.complement === true;
  for (const line of lines) {
    if (mode === "fields") {
      const fields = line.split(delimiter);
      const selected = selectItems(fields, ranges, complement);
      ctx.stdout.write(`${selected.join(outDelim)}
`);
    } else {
      const chars = [...line];
      const selected = selectItems(chars, ranges, complement);
      ctx.stdout.write(`${selected.join("")}
`);
    }
  }
};
function parseRanges(spec, modeForError) {
  const out = [];
  for (const partRaw of spec.split(",")) {
    const part = partRaw.trim();
    if (part.includes("-")) {
      const [startStr, endStr] = part.split("-", 2);
      const start = startStr === "" ? 1 : Number.parseInt(startStr, 10);
      const end = endStr === "" ? null : Number.parseInt(endStr, 10);
      if (Number.isNaN(start) || end !== null && Number.isNaN(end)) {
        throw new TerminalError(`cut: invalid ${modeForError} specification: ${spec}`);
      }
      out.push({ start, end });
    } else {
      const n = Number.parseInt(part, 10);
      if (Number.isNaN(n)) {
        throw new TerminalError(`cut: invalid ${modeForError} specification: ${spec}`);
      }
      out.push({ start: n, end: n });
    }
  }
  return out;
}
function selectItems(items, ranges, complement) {
  if (complement) {
    const excluded = /* @__PURE__ */ new Set();
    for (const { start, end } of ranges) {
      const upper = end ?? items.length;
      for (let i = start; i <= upper; i++) excluded.add(i);
    }
    const out2 = [];
    for (let i = 0; i < items.length; i++) {
      if (!excluded.has(i + 1)) out2.push(items[i]);
    }
    return out2;
  }
  const out = [];
  for (const { start, end } of ranges) {
    if (end === null) {
      for (let i = start - 1; i < items.length; i++) out.push(items[i]);
    } else {
      for (let i = start - 1; i < Math.min(end, items.length); i++) out.push(items[i]);
    }
  }
  return out;
}
var tr = async (ctx) => {
  let del = false;
  let squeeze = false;
  let complement = false;
  const positional = [];
  for (const arg of ctx.args) {
    if (arg.startsWith("-") && arg.length > 1 && positional.length === 0) {
      for (const ch of arg.slice(1)) {
        if (ch === "d") del = true;
        else if (ch === "s") squeeze = true;
        else if (ch === "c" || ch === "C") complement = true;
        else throw new TerminalError(`tr: unknown option: -${ch}`);
      }
    } else {
      positional.push(arg);
    }
  }
  if (positional.length === 0) throw new TerminalError("tr: missing operand");
  let set1 = expandTrSet(positional[0]);
  const set2 = positional.length > 1 ? expandTrSet(positional[1]) : "";
  const content = ctx.stdin;
  if (complement) {
    const set1Chars = new Set(set1);
    const allChars = [...new Set(content)].sort();
    set1 = allChars.filter((c) => !set1Chars.has(c)).join("");
  }
  let result;
  if (del) {
    const toDelete = new Set(set1);
    let kept = "";
    for (const c of content) if (!toDelete.has(c)) kept += c;
    if (squeeze && set2.length > 0) {
      kept = squeezeRuns(kept, new Set(set2));
    }
    result = kept;
  } else if (squeeze && set2.length === 0) {
    result = squeezeRuns(content, new Set(set1));
  } else {
    if (set2.length === 0) throw new TerminalError("tr: missing operand after SET1");
    let padded = set2;
    if (padded.length < set1.length) {
      const last = padded[padded.length - 1];
      padded = padded + last.repeat(set1.length - padded.length);
    }
    const table = /* @__PURE__ */ new Map();
    for (let i = 0; i < set1.length; i++) {
      table.set(set1[i], padded[i]);
    }
    let translated = "";
    for (const c of content) translated += table.get(c) ?? c;
    if (squeeze) translated = squeezeRuns(translated, new Set(set2));
    result = translated;
  }
  ctx.stdout.write(result);
};
function squeezeRuns(text, squeezeSet) {
  let out = "";
  let prev = null;
  for (const c of text) {
    if (squeezeSet.has(c) && prev === c) continue;
    out += c;
    prev = c;
  }
  return out;
}
var TR_CHAR_CLASSES = {
  "[:upper:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
  "[:lower:]": "abcdefghijklmnopqrstuvwxyz",
  "[:digit:]": "0123456789",
  "[:alpha:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  "[:alnum:]": "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789",
  "[:space:]": " 	\n\r\f\v",
  "[:blank:]": " 	"
};
function expandTrSet(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    if (s[i] === "[" && s[i + 1] === ":") {
      let matched = false;
      for (const [name, chars] of Object.entries(TR_CHAR_CLASSES)) {
        if (s.startsWith(name, i)) {
          out += chars;
          i += name.length;
          matched = true;
          break;
        }
      }
      if (matched) continue;
    }
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      if (next === "n") out += "\n";
      else if (next === "t") out += "	";
      else if (next === "\\") out += "\\";
      else out += next;
      i += 2;
      continue;
    }
    if (i + 2 < s.length && s[i + 1] === "-") {
      const startCp = s[i].codePointAt(0);
      const endCp = s[i + 2].codePointAt(0);
      if (startCp <= endCp) {
        for (let cp2 = startCp; cp2 <= endCp; cp2++) out += String.fromCodePoint(cp2);
        i += 3;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out;
}
function describeError7(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/builtins/xargs.ts
var MAX_DEPTH = 16;
var xargsDepth = 0;
function parseXargsArgs(args) {
  let replace = null;
  let maxArgs = null;
  let nullDelim = false;
  let verbose = false;
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === "-I" || arg === "--replace") {
      i++;
      if (i >= args.length) throw new TerminalError("xargs: option -I requires an argument");
      replace = args[i];
    } else if (arg.startsWith("-I") && arg.length > 2) {
      replace = arg.slice(2);
    } else if (arg === "-n" || arg === "--max-args") {
      i++;
      if (i >= args.length) throw new TerminalError("xargs: option -n requires an argument");
      const n = Number.parseInt(args[i], 10);
      if (!Number.isFinite(n)) throw new TerminalError(`xargs: invalid number: ${args[i]}`);
      maxArgs = n;
    } else if (arg.startsWith("-n") && arg.length > 2 && /^\d+$/.test(arg.slice(2))) {
      maxArgs = Number.parseInt(arg.slice(2), 10);
    } else if (arg === "-0" || arg === "--null") {
      nullDelim = true;
    } else if (arg === "-t" || arg === "--verbose") {
      verbose = true;
    } else if (arg === "-r" || arg === "--no-run-if-empty") ; else if (arg.startsWith("-")) {
      throw new TerminalError(`xargs: unknown option: ${arg}`);
    } else {
      return {
        replace,
        maxArgs,
        nullDelim,
        verbose,
        cmdName: arg,
        cmdBaseArgs: args.slice(i + 1)
      };
    }
    i++;
  }
  return { replace, maxArgs, nullDelim, verbose, cmdName: "echo", cmdBaseArgs: [] };
}
function shellQuote(s) {
  if (s.length === 0) return "''";
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(s)) return s;
  return `'${s.replaceAll("'", "'\\''")}'`;
}
var xargs = async (ctx) => {
  if (xargsDepth >= MAX_DEPTH) {
    throw new TerminalError(`xargs: maximum recursion depth exceeded (${MAX_DEPTH})`);
  }
  const { replace, maxArgs, nullDelim, verbose, cmdName, cmdBaseArgs } = parseXargsArgs(ctx.args);
  const inputText = ctx.stdin;
  if (inputText.trim().length === 0) return;
  const items = nullDelim ? inputText.split("\0").filter((s) => s.length > 0) : inputText.split(/\s+/).filter((s) => s.length > 0);
  if (items.length === 0) return;
  const { execute: execute2 } = await import('./interpreter-I3RIZ375.js');
  const runOne = async (cmdArgs) => {
    const cmdStr = [cmdName, ...cmdArgs].map(shellQuote).join(" ");
    if (verbose) ctx.stdout.write(`${cmdName} ${cmdArgs.join(" ")}
`);
    xargsDepth++;
    let out;
    try {
      out = await execute2(cmdStr, ctx.fs, { signal: ctx.signal, commands: ctx.commands });
    } catch (e) {
      throw e instanceof TerminalError ? e : new TerminalError(`xargs: ${cmdName}: execution error: ${describeError8(e)}`);
    } finally {
      xargsDepth--;
    }
    ctx.stdout.write(out);
  };
  if (replace !== null) {
    for (const item of items) {
      if (ctx.signal.aborted) throw new TerminalError("xargs: aborted");
      const subbed = cmdBaseArgs.map((a) => a.replaceAll(replace, item));
      await runOne(subbed);
    }
  } else if (maxArgs !== null) {
    for (let i = 0; i < items.length; i += maxArgs) {
      if (ctx.signal.aborted) throw new TerminalError("xargs: aborted");
      const batch = items.slice(i, i + maxArgs);
      await runOne([...cmdBaseArgs, ...batch]);
    }
  } else {
    await runOne([...cmdBaseArgs, ...items]);
  }
};
function describeError8(e) {
  return e instanceof Error ? e.message : String(e);
}

// src/builtins/index.ts
var BUILTINS = /* @__PURE__ */ new Map([
  // Filesystem
  ["pwd", pwd],
  ["cd", cd],
  ["ls", ls],
  ["mkdir", mkdir],
  ["touch", touch],
  ["cp", cp],
  ["mv", mv],
  ["rm", rm],
  ["basename", basename2],
  ["dirname", dirname2],
  // I/O
  ["echo", echo],
  ["printf", printf],
  ["cat", cat],
  ["head", head],
  ["tail", tail],
  ["tee", tee],
  // Text
  ["wc", wc],
  ["sort", sort],
  ["uniq", uniq],
  ["cut", cut],
  ["tr", tr],
  // Search
  ["grep", grep],
  ["find", find],
  // Diff
  ["diff", diff],
  // Sed
  ["sed", sed],
  // Meta
  ["xargs", xargs],
  // Archive
  ["gzip", gzip],
  ["gunzip", gunzip],
  ["tar", tar],
  ["zip", zip],
  ["unzip", unzip]
]);

// src/quote-masker.ts
var QUOTE_RX = /(?<!\\)(?<quote>["'])(?<content>(?:\\.|(?!\k<quote>).)*)\k<quote>/gs;
function maskQuotes(text) {
  const map = /* @__PURE__ */ new Map();
  const session = randomHex(8);
  let counter = 0;
  const masked = text.replace(QUOTE_RX, (match) => {
    const token = `__Q_${session}_${counter++}__`;
    map.set(token, match);
    return token;
  });
  return { masked, map };
}
function unmaskQuotes(text, map) {
  let result = text;
  for (const [token, original] of map) {
    result = result.replaceAll(token, original);
  }
  return result;
}
function unmaskAndUnquote(text, map) {
  let result = text;
  for (const [token, original] of map) {
    if (original.length >= 2) {
      const quoteChar = original[0];
      let inner = original.slice(1, -1);
      if (quoteChar === '"') inner = inner.replaceAll('\\"', '"');
      else if (quoteChar === "'") inner = inner.replaceAll("\\'", "'");
      result = result.replaceAll(token, inner);
    } else {
      result = result.replaceAll(token, original);
    }
  }
  return result;
}
function randomHex(length) {
  let out = "";
  while (out.length < length) {
    out += Math.floor(Math.random() * 4294967295).toString(16).padStart(8, "0");
  }
  return out.slice(0, length);
}

// src/parser.ts
var OPERATOR_CHARS = /* @__PURE__ */ new Set(["|", ";", "<", ">", "&"]);
var NON_TARGET_TOKENS = /* @__PURE__ */ new Set(["|", ";", "<", ">", ">>", ">&", "\n", "&&", "||"]);
function toScript(text) {
  if (!text || !text.trim()) {
    return { pipelines: [], operators: [] };
  }
  const joined = handleLineContinuation(text);
  const { masked, map } = maskQuotes(joined);
  const tokens = tokenize(masked);
  return parseTokens(tokens, map);
}
function handleLineContinuation(text) {
  return text.replace(/\\\n[ \t]*/g, " ");
}
function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === " " || c === "	" || c === "\r") {
      i++;
      continue;
    }
    if (c === "\n") {
      tokens.push("\n");
      i++;
      continue;
    }
    if (/[0-9]/.test(c) && text[i + 1] === ">") {
      if (text[i + 2] === "&" && i + 3 < n && /[0-9]/.test(text[i + 3] ?? "")) {
        tokens.push(`${c}>&${text[i + 3]}`);
        i += 4;
        continue;
      }
      if (text[i + 2] === ">") {
        tokens.push(`${c}>>`);
        i += 3;
        continue;
      }
      tokens.push(`${c}>`);
      i += 2;
      continue;
    }
    if (i + 1 < n) {
      const two = `${c}${text[i + 1]}`;
      if (two === "&&" || two === "||" || two === ">>" || two === ">&") {
        tokens.push(two);
        i += 2;
        continue;
      }
    }
    if (OPERATOR_CHARS.has(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    let word = "";
    while (i < n) {
      const ch = text[i];
      if (ch === " " || ch === "	" || ch === "\r" || ch === "\n") break;
      if (OPERATOR_CHARS.has(ch)) {
        if (i + 1 < n) {
          const peek = `${ch}${text[i + 1]}`;
          if (peek === "&&" || peek === "||" || peek === ">>" || peek === ">&") break;
        }
        break;
      }
      if (ch === "\\" && i + 1 < n) {
        word += text[i + 1];
        i += 2;
        continue;
      }
      word += ch;
      i++;
    }
    if (word.length > 0) tokens.push(word);
  }
  return tokens;
}
function parseTokens(tokens, maskMap) {
  const pipelines = [];
  const operators = [];
  let currentPipelineCmds = [];
  let pendingOp = null;
  let cmdName = null;
  let cmdArgs = [];
  let cmdRedirects = [];
  const unmask = (token) => unmaskQuotes(token, maskMap);
  const flushCommand = () => {
    if (cmdName !== null) {
      currentPipelineCmds.push({ name: cmdName, args: cmdArgs, redirects: cmdRedirects });
    }
    cmdName = null;
    cmdArgs = [];
    cmdRedirects = [];
  };
  const flushPipeline = (op) => {
    flushCommand();
    if (currentPipelineCmds.length > 0) {
      if (pendingOp !== null) operators.push(pendingOp);
      pipelines.push({ commands: currentPipelineCmds });
      pendingOp = op;
    }
    currentPipelineCmds = [];
  };
  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];
    i++;
    if (token === ";" || token === "\n" || token === "&&" || token === "||") {
      const op = token === "\n" ? ";" : token;
      flushPipeline(op);
      continue;
    }
    if (token === "|") {
      flushCommand();
      if (currentPipelineCmds.length === 0 && cmdName === null) {
        throw new ParseError("Unexpected pipe '|' before command");
      }
      if (i >= tokens.length) {
        throw new ParseError("Unexpected end of input after '|'");
      }
      const next = tokens[i];
      i++;
      if (next === "|" || next === ";" || next === "\n" || next === "&&" || next === "||") {
        throw new ParseError(`Expected command after '|', got '${next}'`);
      }
      cmdName = unmask(next);
      continue;
    }
    if (token === ">" || token === ">>" || token === "<") {
      if (i >= tokens.length) {
        throw new ParseError(`Expected filename after '${token}'`);
      }
      const target = tokens[i];
      i++;
      if (NON_TARGET_TOKENS.has(target)) {
        throw new ParseError(`Expected filename after '${token}', got '${target}'`);
      }
      cmdRedirects.push({ type: token, target: unmask(target) });
      continue;
    }
    if (/^[0-9]>>?$/.test(token)) {
      if (i >= tokens.length) {
        throw new ParseError(`Expected filename after '${token}'`);
      }
      const target = tokens[i];
      i++;
      if (NON_TARGET_TOKENS.has(target)) {
        throw new ParseError(`Expected filename after '${token}', got '${target}'`);
      }
      continue;
    }
    if (token === ">&") {
      if (i >= tokens.length) {
        throw new ParseError("Expected fd after '>&'");
      }
      const targetFd = tokens[i];
      i++;
      if (NON_TARGET_TOKENS.has(targetFd)) {
        throw new ParseError(`Expected fd after '>&', got '${targetFd}'`);
      }
      continue;
    }
    if (/^[0-9]>&[0-9]$/.test(token)) {
      continue;
    }
    const word = unmask(token);
    if (cmdName === null) cmdName = word;
    else cmdArgs.push(word);
  }
  flushPipeline(";");
  return { pipelines, operators };
}

// src/interpreter.ts
var NEVER_ABORT = new AbortController().signal;
var decoder8 = new TextDecoder("utf-8", { fatal: false });
var encoder6 = new TextEncoder();
async function execute(scriptText, fs, opts = {}) {
  return executeScript(toScript(scriptText), fs, opts);
}
async function executeScript(script, fs, opts = {}) {
  const commands = mergeCommands(opts.commands);
  const signal = opts.signal ?? NEVER_ABORT;
  const maxOutputChars = opts.maxOutputChars;
  const out = { value: "" };
  let lastSucceeded = true;
  let lastError = null;
  for (let i = 0; i < script.pipelines.length; i++) {
    if (signal.aborted)
      throw new TerminalError("aborted", applyOutputCap(out.value, maxOutputChars));
    if (i > 0) {
      const op = script.operators[i - 1];
      if (op === "&&" && !lastSucceeded) continue;
      if (op === "||" && lastSucceeded) continue;
    }
    try {
      await executePipeline(script.pipelines[i], fs, commands, signal, out);
      lastSucceeded = true;
      lastError = null;
    } catch (e) {
      lastSucceeded = false;
      lastError = e instanceof TerminalError ? e : new TerminalError(`Unexpected error: ${describeError9(e)}`);
    }
  }
  if (lastError !== null) {
    throw new TerminalError(lastError.message, applyOutputCap(out.value, maxOutputChars));
  }
  return applyOutputCap(out.value, maxOutputChars);
}
function applyOutputCap(value, limit) {
  if (limit === void 0 || limit <= 0 || value.length <= limit) return value;
  let cut2 = limit;
  const code = value.charCodeAt(cut2 - 1);
  if (code >= 55296 && code <= 56319) cut2 -= 1;
  const remaining = value.length - cut2;
  return `${value.slice(0, cut2)}
<truncated: ${remaining} more characters \u2014 use head/tail/grep/sed to read a specific range>
`;
}
async function executePipeline(pipeline, fs, commands, signal, out) {
  if (pipeline.commands.length === 0) return;
  let pipedInput = "";
  for (let cmdIdx = 0; cmdIdx < pipeline.commands.length; cmdIdx++) {
    const cmd = pipeline.commands[cmdIdx];
    if (signal.aborted) throw new TerminalError("aborted");
    let stdin = pipedInput;
    const inputRedirect = cmd.redirects.find((r) => r.type === "<");
    if (inputRedirect) {
      const target = expandPath(inputRedirect.target);
      try {
        const bytes = await fs.read(target);
        stdin = decoder8.decode(bytes);
      } catch (e) {
        throw new TerminalError(`${cmd.name}: ${target}: ${describeError9(e)}`);
      }
    }
    const expandedArgs = await expandArgs(cmd.args, fs);
    const handler = commands.get(cmd.name);
    if (handler === void 0) {
      throw new TerminalError(`${cmd.name}: command not found`);
    }
    const isLastInPipeline = cmdIdx === pipeline.commands.length - 1;
    const hasOutputRedirect = cmd.redirects.some((r) => r.type === ">" || r.type === ">>");
    const agentSink = isLastInPipeline && !hasOutputRedirect;
    const captured = new StringStdout();
    const ctx = {
      args: expandedArgs,
      stdin,
      stdout: captured,
      fs,
      env: {},
      signal,
      commands,
      agentSink
    };
    let result;
    try {
      result = await handler(ctx);
    } catch (e) {
      if (e instanceof TerminalError) throw e;
      throw new TerminalError(`${cmd.name}: execution error: ${describeError9(e)}`);
    }
    if (result !== void 0 && result.exitCode !== 0) {
      const msg = result.stderr ? `${cmd.name}: ${result.stderr}` : `${cmd.name}: exited with code ${result.exitCode}`;
      throw new TerminalError(msg);
    }
    const captureValue = captured.value();
    const outputRedirects = cmd.redirects.filter((r) => r.type === ">" || r.type === ">>");
    if (outputRedirects.length > 0) {
      for (const r of outputRedirects) {
        const target = expandPath(r.target);
        try {
          await fs.write(target, encoder6.encode(captureValue), r.type === ">>" ? "a" : "w");
        } catch (e) {
          throw new TerminalError(`${cmd.name}: redirect failed: ${describeError9(e)}`);
        }
      }
      pipedInput = "";
    } else {
      pipedInput = captureValue;
    }
  }
  if (pipedInput.length > 0) out.value += pipedInput;
}
async function expandArgs(args, fs) {
  const out = [];
  for (const arg of args) {
    const { masked, map } = maskQuotes(arg);
    const hasUnquotedGlob = (masked.includes("*") || masked.includes("?")) && map.size === 0;
    if (hasUnquotedGlob) {
      try {
        const matches = await glob(arg, fs);
        if (matches.length > 0) out.push(...matches);
        else out.push(arg);
      } catch {
        out.push(arg);
      }
    } else {
      out.push(unmaskAndUnquote(masked, map));
    }
  }
  return out;
}
function expandPath(target) {
  const { masked, map } = maskQuotes(target);
  return unmaskAndUnquote(masked, map);
}
function mergeCommands(commands) {
  if (commands === void 0) return BUILTINS;
  const host = commands instanceof Map ? commands : new Map(Object.entries(commands));
  if (host.size === 0) return BUILTINS;
  const merged = new Map(BUILTINS);
  for (const [name, handler] of host) merged.set(name, handler);
  return merged;
}
var StringStdout = class {
  #parts = [];
  write(s) {
    this.#parts.push(s);
  }
  value() {
    return this.#parts.join("");
  }
};
function describeError9(e) {
  if (e instanceof Error) return e.message;
  return String(e);
}

export { ParseError, TerminalError, execute, executeScript, maskQuotes, toScript, unmaskAndUnquote, unmaskQuotes };
//# sourceMappingURL=chunk-W7BA5NQM.js.map
//# sourceMappingURL=chunk-W7BA5NQM.js.map