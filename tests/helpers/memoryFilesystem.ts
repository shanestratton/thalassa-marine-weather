/**
 * A small in-memory stand-in for @capacitor/filesystem (Phase 2b, 2026-10-01)
 * — enough of writeFile / readFile / deleteFile / stat / readdir / rmdir / rename for the water
 * pack's store, with a log of every call so a test can count the writes that
 * would cross the iOS plugin bridge.
 *
 * Use it directly (new WaterPackStore({ fs: memoryFs })) or as the module:
 *   vi.mock('@capacitor/filesystem', async () =>
 *       (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
 */

export interface MemoryFile {
    data: string;
    mtime: number;
}

type Op = 'writeFile' | 'readFile' | 'deleteFile' | 'stat' | 'readdir' | 'mkdir' | 'rmdir' | 'rename';

export interface MemoryFilesystem {
    files: Map<string, MemoryFile>;
    calls: { op: Op; path: string }[];
    writeFile(o: { path: string; data: string; directory?: string; encoding?: string; recursive?: boolean }): Promise<{
        uri: string;
    }>;
    readFile(o: { path: string; directory?: string; encoding?: string }): Promise<{ data: string }>;
    deleteFile(o: { path: string; directory?: string }): Promise<void>;
    stat(o: { path: string; directory?: string }): Promise<{
        type: 'file' | 'directory';
        size: number;
        ctime: number;
        mtime: number;
        uri: string;
    }>;
    readdir(o: { path: string; directory?: string }): Promise<{
        files: { name: string; type: 'file' | 'directory'; size: number; ctime: number; mtime: number; uri: string }[];
    }>;
    mkdir(o: { path: string; directory?: string; recursive?: boolean }): Promise<void>;
    /** Removes a folder: an empty one, or with `recursive` everything in it. */
    rmdir(o: { path: string; directory?: string; recursive?: boolean }): Promise<void>;
    /** Moves a file, replacing any at the destination (as iOS's does). */
    rename(o: { from: string; to: string; directory?: string; toDirectory?: string }): Promise<void>;
    getUri(o: { path: string; directory?: string }): Promise<{ uri: string }>;
    /** Calls of one kind whose path starts with the prefix. */
    count(op: Op, prefix?: string): number;
    reset(): void;
    /** Clock for mtimes (ms). */
    now: () => number;
}

const fullPath = (directory: string | undefined, path: string): string => `${directory ?? 'DATA'}/${path}`;

export function createMemoryFilesystem(now: () => number = () => Date.now()): MemoryFilesystem {
    const files = new Map<string, MemoryFile>();
    const calls: { op: Op; path: string }[] = [];
    const notFound = (path: string) => new Error(`File does not exist: ${path}`);
    const fs: MemoryFilesystem = {
        files,
        calls,
        now,
        async writeFile({ path, data, directory }) {
            calls.push({ op: 'writeFile', path });
            files.set(fullPath(directory, path), { data, mtime: fs.now() });
            return { uri: `mem://${fullPath(directory, path)}` };
        },
        async readFile({ path, directory }) {
            calls.push({ op: 'readFile', path });
            const f = files.get(fullPath(directory, path));
            if (!f) throw notFound(path);
            return { data: f.data };
        },
        async deleteFile({ path, directory }) {
            calls.push({ op: 'deleteFile', path });
            if (!files.delete(fullPath(directory, path))) throw notFound(path);
        },
        async stat({ path, directory }) {
            calls.push({ op: 'stat', path });
            const f = files.get(fullPath(directory, path));
            if (f) return { type: 'file', size: f.data.length, ctime: f.mtime, mtime: f.mtime, uri: `mem://${path}` };
            const dir = `${fullPath(directory, path)}/`;
            if ([...files.keys()].some((k) => k.startsWith(dir)))
                return { type: 'directory', size: 0, ctime: 0, mtime: 0, uri: `mem://${path}` };
            throw notFound(path);
        },
        async readdir({ path, directory }) {
            calls.push({ op: 'readdir', path });
            const dir = `${fullPath(directory, path)}/`;
            const names = new Map<string, { type: 'file' | 'directory'; size: number; mtime: number }>();
            for (const [k, f] of files) {
                if (!k.startsWith(dir)) continue;
                const rest = k.slice(dir.length);
                const slash = rest.indexOf('/');
                if (slash >= 0) names.set(rest.slice(0, slash), { type: 'directory', size: 0, mtime: 0 });
                else names.set(rest, { type: 'file', size: f.data.length, mtime: f.mtime });
            }
            if (names.size === 0) throw notFound(path);
            return {
                files: [...names].map(([name, v]) => ({ name, ...v, ctime: v.mtime, uri: `mem://${path}/${name}` })),
            };
        },
        async mkdir({ path }) {
            calls.push({ op: 'mkdir', path });
        },
        async rmdir({ path, directory, recursive }) {
            calls.push({ op: 'rmdir', path });
            const dir = `${fullPath(directory, path)}/`;
            const inside = [...files.keys()].filter((k) => k.startsWith(dir));
            if (inside.length === 0) throw notFound(path);
            if (!recursive) throw new Error(`Folder is not empty: ${path}`);
            for (const k of inside) files.delete(k);
        },
        async rename({ from, to, directory, toDirectory }) {
            calls.push({ op: 'rename', path: from });
            const f = files.get(fullPath(directory, from));
            if (!f) throw notFound(from);
            files.delete(fullPath(directory, from));
            files.set(fullPath(toDirectory ?? directory, to), { data: f.data, mtime: fs.now() });
        },
        async getUri({ path, directory }) {
            return { uri: `mem://${fullPath(directory, path)}` };
        },
        count(op, prefix = '') {
            return calls.filter((c) => c.op === op && c.path.startsWith(prefix)).length;
        },
        reset() {
            files.clear();
            calls.length = 0;
        },
    };
    return fs;
}

/** One shared instance for a test file that mocks the module. */
export const memoryFs = createMemoryFilesystem();

/** The module shape @capacitor/filesystem exports, backed by memoryFs. */
export function memoryFilesystemModule() {
    return {
        Filesystem: memoryFs,
        Directory: { Data: 'DATA', Documents: 'DOCUMENTS', Library: 'LIBRARY', Cache: 'CACHE' },
        Encoding: { UTF8: 'utf8' },
    };
}
