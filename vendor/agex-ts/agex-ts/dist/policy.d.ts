import { M as MemberFilter, D as RegistrationCommon, x as RegisteredFn, w as RegisteredCls, a as MemberConfig, T as TerminalCommandHandler, P as Policy } from './types-BdbZoJfu.js';
import '@standard-schema/spec';
import 'termish-ts';
import './errors.js';

/**
 * `PolicyBuilder` — incremental construction of the agent's
 * registration table.
 *
 * The five `register*` methods correspond to `agent.fn`, `.cls`,
 * `.namespace`, `.skill`, `.terminal`. Each one validates eagerly
 * (RegistrationError on bad input or name collision) and updates
 * a single registration record in the appropriate map.
 *
 * `snapshot()` returns an immutable `Policy` view — the runtime
 * adapter consumes one of these at `init()` time. Subsequent calls
 * to `register*` invalidate any earlier snapshot conceptually, but
 * since snapshots are read-only views of the live maps, callers
 * should re-snapshot after each registration burst.
 */

interface FnRegistration extends RegistrationCommon {
    readonly fn?: RegisteredFn['fn'];
    readonly url?: string;
    readonly export?: string;
    readonly paramsSchema?: RegisteredFn['paramsSchema'];
    readonly wantsContext?: boolean;
}
interface ClsRegistration extends RegistrationCommon {
    readonly cls?: RegisteredCls['cls'];
    readonly url?: string;
    readonly export?: string;
    readonly constructable?: boolean;
    readonly include?: MemberFilter;
    readonly exclude?: MemberFilter;
    readonly configure?: Readonly<Record<string, MemberConfig>>;
}
interface NsRegistration extends RegistrationCommon {
    readonly target?: object;
    readonly url?: string;
    readonly export?: string;
    readonly recursive?: boolean;
    readonly include?: MemberFilter;
    readonly exclude?: MemberFilter;
    readonly configure?: Readonly<Record<string, MemberConfig>>;
}
interface TerminalRegistration extends RegistrationCommon {
    readonly handler: TerminalCommandHandler;
}
declare class PolicyBuilder {
    #private;
    registerFn(name: string, opts: FnRegistration): void;
    registerCls(name: string, opts: ClsRegistration): void;
    registerNamespace(name: string, opts: NsRegistration): void;
    registerSkill(name: string, content: string): void;
    registerTerminal(name: string, opts: TerminalRegistration): void;
    snapshot(): Policy;
    /** Hash-style fingerprint of the current policy. Cheap to compute;
     *  any registration mutation changes the value. The agent uses
     *  this to invalidate cached primer/dependency snapshots. */
    fingerprint(): string;
}
/**
 * Apply the standard `include`/`exclude` filtering rule to a member name.
 *
 * - `exclude` always wins.
 * - `include` defaults to "everything not excluded".
 * - Filter values can be a single glob (`'foo*'`), an array of globs, or
 *   a predicate function.
 *
 * Globs are simple shell-style: `*` matches any chars (no slashes), `?`
 * matches one char. No bracket expressions for v1.
 *
 * No default `_*` exclusion: TypeScript has `#field` for true privacy
 * and `private` as a compile-time hint, so an underscore prefix carries
 * no special meaning here. If a registered target intentionally exposes
 * `_helper`, the agent sees it. Embedders who want the Python-style
 * convention can pass `exclude: '_*'` explicitly.
 */
declare function memberAllowed(name: string, include: MemberFilter | undefined, exclude: MemberFilter | undefined): boolean;

export { PolicyBuilder, memberAllowed };
