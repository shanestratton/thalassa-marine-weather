/**
 * A small in-memory stand-in for @capacitor/filesystem (Phase 2b, 2026-10-01)
 * — enough of writeFile / appendFile / readFile / deleteFile / stat / readdir /
 * rmdir / rename / copy / getUri for the water pack's store and the Documents
 * vault (126-B3a), with a log of every call so a test can count the writes
 * that would cross the iOS plugin bridge, and how big each one was.
 *
 * Data is kept as given: base64 for a binary file (appendFile concatenates,
 * which is exact while every chunk but the last is a whole number of 3-byte
 * groups, as the vault writes them), text for a UTF-8 one. getUri answers a
 * file:/// URI as iOS does (file:///Library/…); fileForUri maps one back, so a
 * fetch stub can serve the file a convertFileSrc URL names.
 *
 * Use it directly (new WaterPackStore({ fs: memoryFs })) or as the module:
 *   vi.mock('@capacitor/filesystem', async () =>
 *       (await import('./helpers/memoryFilesystem')).memoryFilesystemModule());
 */

export interface MemoryFile {
    data: string;
    mtime: number;
    /** As written: set for text (UTF-8); absent for base64, whose size is the decoded byte count. */
    encoding?: string;
}

/** The file's size in bytes, as stat and readdir report it on the device. */
function sizeOf(file: MemoryFile): number {
    if (file.encoding) return file.data.length;
    const padding = file.data.endsWith('==') ? 2 : file.data.endsWith('=') ? 1 : 0;
    return Math.floor((file.data.length * 3) / 4) - padding;
}

type Op =
    | 'writeFile'
    | 'appendFile'
    | 'readFile'
    | 'deleteFile'
    | 'stat'
    | 'readdir'
    | 'mkdir'
    | 'rmdir'
    | 'rename'
    | 'copy'
    | 'getUri';

export interface MemoryCall {
    op: Op;
    path: string;
    /** writeFile / appendFile: the length of the data handed across (characters). */
    chars?: number;
    /** The Directory the call named. */
    directory?: string;
}

export interface MemoryFilesystem {
    files: Map<string, MemoryFile>;
    calls: MemoryCall[];
    writeFile(o: { path: string; data: string; directory?: string; encoding?: string; recursive?: boolean }): Promise<{
        uri: string;
    }>;
    /** Appends to a file (creating it), as the plugin does: base64 chunks join into one file. */
    appendFile(o: { path: string; data: string; directory?: string; encoding?: string }): Promise<void>;
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
    /** Copies a file, replacing any at the destination; answers the copy's uri. */
    copy(o: { from: string; to: string; directory?: string; toDirectory?: string }): Promise<{ uri: string }>;
    /** file:///Library/<path> for Directory.Library, as iOS answers. */
    getUri(o: { path: string; directory?: string }): Promise<{ uri: string }>;
    /** The file a getUri (or convertFileSrc of one) URI names, or undefined. */
    fileForUri(uri: string): MemoryFile | undefined;
    /** Calls of one kind whose path starts with the prefix. */
    count(op: Op, prefix?: string): number;
    reset(): void;
    /** Clock for mtimes (ms). */
    now: () => number;
}

const fullPath = (directory: string | undefined, path: string): string => `${directory ?? 'DATA'}/${path}`;

/** Where each Directory sits in a file:/// URI (iOS's Library and Caches; Data kept apart from Documents). */
const URI_ROOTS: Record<string, string> = {
    LIBRARY: 'Library',
    CACHE: 'Library/Caches',
    DOCUMENTS: 'Documents',
    DATA: 'Data',
};

export function createMemoryFilesystem(now: () => number = () => Date.now()): MemoryFilesystem {
    const files = new Map<string, MemoryFile>();
    const calls: MemoryCall[] = [];
    const notFound = (path: string) => new Error(`File does not exist: ${path}`);
    const fs: MemoryFilesystem = {
        files,
        calls,
        now,
        async writeFile({ path, data, directory, encoding }) {
            calls.push({ op: 'writeFile', path, chars: data.length, directory });
            files.set(fullPath(directory, path), { data, mtime: fs.now(), ...(encoding ? { encoding } : {}) });
            return { uri: `mem://${fullPath(directory, path)}` };
        },
        async appendFile({ path, data, directory, encoding }) {
            calls.push({ op: 'appendFile', path, chars: data.length, directory });
            const key = fullPath(directory, path);
            const existing = files.get(key);
            const kept = existing ? existing.encoding : encoding;
            files.set(key, {
                data: (existing?.data ?? '') + data,
                mtime: fs.now(),
                ...(kept ? { encoding: kept } : {}),
            });
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
            if (f) return { type: 'file', size: sizeOf(f), ctime: f.mtime, mtime: f.mtime, uri: `mem://${path}` };
            const dir = `${fullPath(directory, path)}/`;
            if ([...files.keys()].some((k) => k.startsWith(dir)))
                return { type: 'directory', size: 0, ctime: 0, mtime: 0, uri: `mem://${path}` };
            throw notFound(path);
        },
        async readdir({ path, directory }) {
            calls.push({ op: 'readdir', path });
            // The root ('') is listed (and is never missing); any other folder must exist.
            const dir = path ? `${fullPath(directory, path)}/` : `${directory ?? 'DATA'}/`;
            const names = new Map<string, { type: 'file' | 'directory'; size: number; mtime: number }>();
            for (const [k, f] of files) {
                if (!k.startsWith(dir)) continue;
                const rest = k.slice(dir.length);
                const slash = rest.indexOf('/');
                if (slash >= 0) names.set(rest.slice(0, slash), { type: 'directory', size: 0, mtime: 0 });
                else names.set(rest, { type: 'file', size: sizeOf(f), mtime: f.mtime });
            }
            if (names.size === 0 && path) throw notFound(path);
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
            files.set(fullPath(toDirectory ?? directory, to), { ...f, mtime: fs.now() });
        },
        async copy({ from, to, directory, toDirectory }) {
            calls.push({ op: 'copy', path: from, directory });
            const f = files.get(fullPath(directory, from));
            if (!f) throw notFound(from);
            const target = fullPath(toDirectory ?? directory, to);
            files.set(target, { ...f, mtime: fs.now() });
            return { uri: `mem://${target}` };
        },
        async getUri({ path, directory }) {
            calls.push({ op: 'getUri', path, directory });
            return { uri: `file:///${URI_ROOTS[directory ?? 'DATA'] ?? directory}/${path}` };
        },
        fileForUri(uri) {
            const match =
                decodeURI(uri).match(/^.*?file:\/\/\/(.+)$/) ?? decodeURI(uri).match(/_capacitor_file_\/(.+)$/);
            if (!match) return undefined;
            const rest = match[1];
            // Longest root first: Library/Caches before Library.
            const roots = Object.entries(URI_ROOTS).sort((a, b) => b[1].length - a[1].length);
            for (const [directory, root] of roots) {
                if (rest.startsWith(`${root}/`)) return files.get(fullPath(directory, rest.slice(root.length + 1)));
            }
            return undefined;
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
