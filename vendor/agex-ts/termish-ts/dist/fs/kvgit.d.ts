import { Staged, Decoder, Encoder } from 'kvgit-ts';
import { FileSystem, FileMetadata, FileInfo } from './protocol.js';

/**
 * `KvgitFS` — `FileSystem` backed by a kvgit-ts `Staged`.
 *
 * Every path becomes a key in the staging buffer. Writes accumulate
 * locally; the user calls `commit()` to flush them as a single
 * versioned commit (with three-way merge if HEAD has moved).
 *
 * Storage layout:
 * - File at `/path/to/file` → key `f:/path/to/file`
 * - Explicit empty dir `/path` → key `d:/path`
 * - A dir is implicit if any `f:` or `d:` key has prefix `<path>/`
 *
 * Per-record byte format:
 * - Byte 0: type tag — 0x46 (`F`, file) or 0x44 (`D`, dir)
 * - Bytes 1–24: ISO 8601 createdAt (always 24 chars: `YYYY-MM-DDTHH:mm:ss.sssZ`)
 * - Bytes 25–48: ISO 8601 modifiedAt (same format)
 * - Bytes 49…: file content (empty for dirs)
 *
 * This keeps content bytes contiguous in the record (no base64), avoids
 * any JSON parsing in the hot path, and lets `read()` slice straight
 * into a Uint8Array.
 *
 * Peer-dep on kvgit-ts. Import only via `termish-ts/fs/kvgit`; importing
 * the main entry never pulls kvgit in.
 */

/** Typed as `Encoder` (value: unknown) so it plugs into `Staged`'s
 *  constructor without a generic-variance cast at call sites. */
declare const fileRecordEncoder: Encoder;
declare const fileRecordDecoder: Decoder;
/** Encoder that handles both `FileRecord` payloads and arbitrary
 *  structured values via a one-byte type tag. Use this on the unified
 *  `Staged` an agex-ts agent shares between its state backend and its
 *  kvgit-backed VFS — one `staged.commit()` then captures both atomically.
 *
 *  Wire format:
 *  - `0x46` (`F`) / `0x44` (`D`): existing FileRecord layout.
 *  - `0x4a` (`J`): byte 0 = tag, bytes 1+ = UTF-8 superjson payload.
 *
 *  The non-FileRecord path goes through `superjson` rather than plain
 *  JSON so that values containing `Uint8Array`, `Map`, `Set`, `Date`,
 *  `BigInt`, etc. roundtrip with their types preserved. Plain JSON
 *  silently corrupts these (e.g. `Uint8Array` becomes a numeric-keyed
 *  plain object that fails any subsequent `decoder.decode(value)` call).
 *  superjson encodes the type info as a sidecar in the wire payload —
 *  the bytes are still valid JSON, just with a `{json, meta}` envelope.
 */
declare const polymorphicEncoder: Encoder;
declare const polymorphicDecoder: Decoder;
interface KvgitFSOptions {
    /** Initial virtual cwd. Defaults to `/`. */
    readonly cwd?: string;
}
declare class KvgitFS implements FileSystem {
    #private;
    constructor(staged: Staged, opts?: KvgitFSOptions);
    /** Expose the underlying `Staged` so callers can `commit()`,
     *  switch branches, etc. */
    get staged(): Staged;
    getcwd(): string;
    chdir(path: string): Promise<void>;
    read(path: string): Promise<Uint8Array>;
    exists(path: string): Promise<boolean>;
    isFile(path: string): Promise<boolean>;
    isDir(path: string): Promise<boolean>;
    stat(path: string): Promise<FileMetadata>;
    write(path: string, content: Uint8Array, mode?: 'w' | 'a'): Promise<void>;
    mkdir(path: string, opts?: {
        parents?: boolean;
        existOk?: boolean;
    }): Promise<void>;
    remove(path: string): Promise<void>;
    rmdir(path: string): Promise<void>;
    rename(src: string, dst: string): Promise<void>;
    list(path?: string, opts?: {
        recursive?: boolean;
    }): Promise<string[]>;
    listDetailed(path?: string, opts?: {
        recursive?: boolean;
    }): Promise<FileInfo[]>;
}

export { KvgitFS, type KvgitFSOptions, fileRecordDecoder, fileRecordEncoder, polymorphicDecoder, polymorphicEncoder };
