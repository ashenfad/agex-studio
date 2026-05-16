import { FileSystem, FileMetadata, FileInfo } from './protocol.js';

/**
 * In-process `FileSystem` implementation backed by a `Map`.
 *
 * Used by tests, ephemeral agent sessions, and as the reference
 * implementation against which other adapters (RealFS, KvgitFS) are
 * conformance-tested.
 *
 * Path model: POSIX-style absolute paths internally. Relative paths
 * are resolved against the in-memory cwd (defaults to `/`).
 *
 * Directory model: dirs are mostly implicit — `isDir(path)` is true
 * iff *some* file is stored under `path/`. Empty dirs that the user
 * explicitly `mkdir`s get tracked in a separate set so `rmdir` and
 * `list` see them too.
 */

declare class MemoryFS implements FileSystem {
    #private;
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

export { MemoryFS };
