import { FileSystem, FileMetadata, FileInfo } from './protocol.js';

/**
 * `RealFS` — Node.js-backed `FileSystem` rooted at a host directory.
 *
 * Every virtual POSIX path (`/data/file.txt`) maps to a real path under
 * the configured `root` (`${root}/data/file.txt`). The root acts as
 * the FS's virtual `/`, so agent code that operates on `/foo` cannot
 * reach anything outside the sandbox.
 *
 * Designed for Node only — the implementation imports `node:fs/promises`.
 * For browser-side real-FS access, use the File System Access API in a
 * separate adapter (not implemented here).
 */

interface RealFSOptions {
    /** Absolute host-side path that becomes the virtual `/`. The
     *  directory must already exist; the constructor does not create it. */
    readonly root: string;
    /** Initial virtual cwd. Defaults to `/`. */
    readonly cwd?: string;
}
declare class RealFS implements FileSystem {
    #private;
    constructor(opts: RealFSOptions);
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

export { RealFS, type RealFSOptions };
