import { FileSystem } from './fs/protocol.js';
export { FileInfo, FileMetadata } from './fs/protocol.js';
export { compileGlob, glob, globMatch, hasGlobChars } from './glob.js';

/**
 * AST node types for the terminal command language.
 *
 * Mirrors termish-py's `ast.py` shapes. All nodes are plain objects
 * (frozen at construction, conventionally treated as immutable).
 *
 * Grammar:
 *
 *   Script   = Pipeline { (";" | "&&" | "||" | "\n") Pipeline }*
 *   Pipeline = Command { "|" Command }*
 *   Command  = Word { Arg | Redirect }*
 */
/** I/O redirection kinds.
 * - `'<'`  read input from a file
 * - `'>'`  write output to a file (overwrite)
 * - `'>>'` write output to a file (append)
 */
type RedirectType = '<' | '>' | '>>';
/** Operators between pipelines.
 * - `';'`  always run the next pipeline
 * - `'&&'` run the next pipeline only if the previous succeeded
 * - `'||'` run the next pipeline only if the previous failed
 */
type Operator = ';' | '&&' | '||';
/** A single I/O redirection on a command. */
interface Redirect {
    readonly type: RedirectType;
    readonly target: string;
}
/** A single executable command invocation. */
interface Command {
    readonly name: string;
    readonly args: readonly string[];
    readonly redirects: readonly Redirect[];
}
/** A sequence of commands connected by pipes (stdout → stdin). */
interface Pipeline {
    readonly commands: readonly Command[];
}
/** A full script: pipelines joined by operators.
 * `operators[i]` separates `pipelines[i]` and `pipelines[i+1]`;
 * `operators.length === pipelines.length - 1`. */
interface Script {
    readonly pipelines: readonly Pipeline[];
    readonly operators: readonly Operator[];
}

/**
 * Command context + result + handler signature.
 *
 * Every builtin and every host-injected command receives a single
 * `CommandContext` argument: parsed args, stdin / stdout strings,
 * the filesystem, an env map (reserved), and an `AbortSignal` for
 * cooperative cancellation.
 *
 * Handlers return:
 * - `void` (or omitted return) for success with no stderr
 * - `CommandResult` to signal a non-zero exit code and/or stderr
 * - they can also throw `TerminalError` for hard failures
 */

interface CommandContext {
    /** Parsed arguments — does NOT include the command name. */
    readonly args: readonly string[];
    /** Stdin: piped content from the previous pipeline stage, or
     *  empty if this is the first command. */
    readonly stdin: string;
    /** Write stdout here. Pipeline captures and forwards. */
    readonly stdout: {
        write(s: string): void;
    };
    /** The filesystem the command operates on. */
    readonly fs: FileSystem;
    /** Reserved for future env-var support; currently always empty. */
    readonly env: Readonly<Record<string, string>>;
    /** Cooperative cancellation. Loop-heavy builtins (grep, find,
     *  xargs) check this at iteration boundaries. */
    readonly signal: AbortSignal;
    /** The full command registry — host overrides merged on top of
     *  builtins. Builtins that re-enter the interpreter (xargs,
     *  `find -exec`) thread this through so host-injected commands
     *  remain reachable in nested invocations. */
    readonly commands: ReadonlyMap<string, CommandHandler>;
    /** True when this command's stdout will flow to the script's
     *  returned output (last command in its pipeline, no output
     *  redirect). False when the stdout will be consumed by a
     *  downstream pipe stage or shunted to a file via `>` / `>>`.
     *
     *  Builtins use this to gate diagnostics that only make sense when
     *  the output reaches a human/agent caller — e.g. `cat` refuses to
     *  dump binary content when `agentSink=true`, but stays out of the
     *  way for `cat /binary > /copy` or `cat /nul-sep | xargs -0`. */
    readonly agentSink: boolean;
}
interface CommandResult {
    /** Non-zero signals failure. Default 0 (success). */
    readonly exitCode: number;
    /** Optional stderr text. */
    readonly stderr: string;
}
/** A command handler. Always async — every builtin and most host
 *  commands need to await IO. Resolve to `undefined` (or just fall
 *  off the end of the function body) for "success with no stderr",
 *  or to a `CommandResult` to signal a non-zero exit code or stderr
 *  text. Throw `TerminalError` for hard failures (the pipeline
 *  aborts and the partial output reaches the caller).
 *
 *  The `void` in the union is here so that a handler body with no
 *  `return` statement (which TS infers as `Promise<void>`) satisfies
 *  the type. `void` and `undefined` are equivalent at runtime. */
type CommandHandler = (ctx: CommandContext) => Promise<CommandResult | undefined | void>;

/**
 * Error types for termish-ts.
 *
 * `TerminalError` is the catch-all for command execution failures —
 * it carries any partial output captured before the failure so a
 * caller can still surface what made it through the pipeline.
 *
 * `ParseError` is raised by the parser for invalid syntax.
 */
declare class TerminalError extends Error {
    readonly name = "TerminalError";
    /** Whatever was written to stdout before the failure, captured so
     *  the host can still surface partial pipeline output. */
    readonly partialOutput: string;
    constructor(message: string, partialOutput?: string);
}
declare class ParseError extends Error {
    readonly name = "ParseError";
}

/**
 * Pipeline executor.
 *
 * Walks a `Script` AST, runs each pipeline through the chain of its
 * commands (stdout → stdin), honors redirects (`<`, `>`, `>>`),
 * threads exit codes through `&&` / `||`, and accumulates stdout
 * into a single returned string.
 *
 * Cancellation: every iteration boundary (between pipelines, between
 * commands within a pipeline, before each redirect read) checks
 * `signal.aborted`. Loop-heavy builtins are responsible for
 * checking inside their own loops.
 *
 * Error model: command failures throw `TerminalError`. The script-
 * level catch swallows the failure of an individual pipeline (so
 * `||` can still rescue it), but re-throws at the end with the
 * accumulated `partialOutput` if the *last* pipeline failed.
 */

interface ExecuteOptions {
    /** Custom commands. Override builtins on name collision.
     *  Pass either a `Map` or a plain object; both are accepted. */
    commands?: ReadonlyMap<string, CommandHandler> | Readonly<Record<string, CommandHandler>>;
    /** Cooperative cancellation. Default: never aborts. */
    signal?: AbortSignal;
    /** Maximum characters of accumulated stdout returned to the caller.
     *  When exceeded, output is sliced to the limit and a single-line
     *  marker is appended:
     *
     *    `\n<truncated: N more characters — use head/tail/grep/sed to read a specific range>\n`
     *
     *  Applied once, at the executeScript boundary — intra-pipeline
     *  buffers (e.g. `cat huge.json | jq .key`) are not affected.
     *  Also applied to the `partialOutput` carried on a thrown
     *  `TerminalError`. Default: no cap. Embedders that hand the output
     *  to an LLM should set this to bound input-token cost. */
    maxOutputChars?: number;
}
/**
 * Convenience: parse + execute. Matches termish-py's top-level
 * `execute(script_text, fs, commands=None)`.
 */
declare function execute(scriptText: string, fs: FileSystem, opts?: ExecuteOptions): Promise<string>;
/**
 * Execute a parsed `Script` against `fs`. Returns accumulated stdout.
 *
 * Throws `TerminalError` if the *last* pipeline failed. Earlier
 * pipeline failures are absorbed into the `&&` / `||` flow and the
 * partial output continues accumulating.
 */
declare function executeScript(script: Script, fs: FileSystem, opts?: ExecuteOptions): Promise<string>;

/**
 * Parse shell script text into the AST defined in `./ast`.
 *
 * Pipeline:
 *
 *   text
 *     → handleLineContinuation (strip backslash-newline joins)
 *     → maskQuotes (preserve quoted spans through tokenization)
 *     → tokenize (split into words + operators + newlines)
 *     → parseTokens (build Script AST, unmasking quoted spans)
 *
 * Ports termish-py's parser without depending on Python's `shlex` —
 * the tokenizer is hand-rolled but follows the same conventions:
 * whitespace splits words, the recognized operator set is fixed,
 * masked quote placeholders behave as single tokens.
 */

/**
 * Parse shell script text into a `Script` AST. Throws `ParseError`
 * on invalid syntax.
 *
 * Empty or whitespace-only input returns an empty Script (no
 * pipelines), matching termish-py.
 */
declare function toScript(text: string): Script;

/**
 * Mask quoted substrings so the tokenizer can treat them as opaque
 * single tokens.
 *
 * Why: shell tokenization needs to distinguish between quoted
 * wildcards (literal `*`) and unquoted wildcards (glob pattern).
 * Without masking, the tokenizer would see `'*'` as the operator
 * sequence `'`, `*`, `'` and lose the quoting semantics.
 *
 * Algorithm: each quoted span is replaced with a unique placeholder
 * token (`__Q_<sessionHex>_<n>__`) before tokenization. The parser
 * unmasks back to the original quoted form at parse time; the
 * interpreter calls `unmaskAndUnquote` (which strips the outer
 * quotes and unescapes) when actually executing.
 *
 * Ported from termish-py's `quote_masker.py`.
 */
interface MaskResult {
    /** Text with every quoted span replaced by a unique placeholder. */
    readonly masked: string;
    /** Placeholder → original quoted span (including the outer quotes). */
    readonly map: Map<string, string>;
}
declare function maskQuotes(text: string): MaskResult;
/** Restore placeholders to their full original quoted form (with quotes). */
declare function unmaskQuotes(text: string, map: ReadonlyMap<string, string>): string;
/**
 * Restore placeholders but **strip the outer quotes** and unescape
 * any escaped quote characters inside.
 *
 * Used at execution time when the interpreter expands command args:
 * the agent typed `'hello world'` to mean the literal string
 * `hello world`, so when we hand the arg to a builtin we want the
 * unquoted form.
 */
declare function unmaskAndUnquote(text: string, map: ReadonlyMap<string, string>): string;

export { type Command, type CommandContext, type CommandHandler, type CommandResult, type ExecuteOptions, FileSystem, type MaskResult, type Operator, ParseError, type Pipeline, type Redirect, type RedirectType, type Script, TerminalError, execute, executeScript, maskQuotes, toScript, unmaskAndUnquote, unmaskQuotes };
