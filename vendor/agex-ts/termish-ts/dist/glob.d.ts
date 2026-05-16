import { FileSystem } from './fs/protocol.js';

/**
 * Standalone glob helper over a `FileSystem`.
 *
 * Supports four pattern primitives — same surface as Python's `fnmatch`
 * with the `**` extension:
 *
 * | Pattern | Meaning |
 * |---|---|
 * | `*`  | any sequence of characters except `/` |
 * | `?`  | any single character except `/` |
 * | `[abc]` | any character in the bracket set |
 * | `**` | any sequence of characters including `/` |
 *
 * Backends do not implement `glob()` themselves — this helper walks
 * the FS via `list()`. Trades some efficiency (always lists from the
 * longest non-glob prefix recursively) for simplicity and adapter
 * portability.
 */

/** Returns true if `pattern` contains any glob metacharacters. */
declare function hasGlobChars(pattern: string): boolean;
/**
 * Compile a glob pattern into an anchored regex. The regex matches a
 * full path *relative to* the longest non-glob prefix.
 */
declare function compileGlob(pattern: string): RegExp;
/** Pure pattern match — true iff `path` matches `pattern`. */
declare function globMatch(pattern: string, path: string): boolean;
/**
 * Resolve a glob pattern against a `FileSystem`, returning matching
 * paths sorted lexicographically.
 *
 * Patterns may be absolute (`/etc/**\/*.conf`) or relative (`*.ts`,
 * `src/lib/*.ts`). Relative patterns resolve against `fs.getcwd()`.
 *
 * If the pattern has no glob characters, returns `[pattern]` if the
 * path exists or `[]` otherwise — matches shell semantics.
 */
declare function glob(pattern: string, fs: FileSystem): Promise<string[]>;

export { compileGlob, glob, globMatch, hasGlobChars };
