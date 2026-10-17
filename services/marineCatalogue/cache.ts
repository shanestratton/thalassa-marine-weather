import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { CACHE_MAX_BYTES, CACHE_MAX_ENTRIES, SHARD_MAX_BYTES, cataloguePath } from './schema';

interface Entry {
    path: string;
    text: string;
    at: number;
}
const FILE = 'public-marine-catalogue-v1.json';
let rows = new Map<string, Entry>();
let loaded: Promise<void> | undefined;
let queue: Promise<unknown> = Promise.resolve();
let epoch = 0;
const clearListeners = new Set<() => void>();
/** Visible public layers retire immediately when their optional cache is deleted. */
export function subscribeCatalogueCacheCleared(listener: () => void): () => void {
    clearListeners.add(listener);
    return () => {
        clearListeners.delete(listener);
    };
}
const bytes = (s: string) => new TextEncoder().encode(s).byteLength;
function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = queue.catch(() => undefined).then(job);
    queue = next;
    return next;
}
async function db(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('thalassa-public-marine-v1', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('cache');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}
async function disk(write?: string): Promise<string | null> {
    if (Capacitor.isNativePlatform()) {
        if (write !== undefined) {
            // Capacitor rename does not replace an existing destination on iOS.
            // A torn optional cache is rejected on restore rather than deleting a good pack first.
            await Filesystem.writeFile({ path: FILE, directory: Directory.Data, encoding: Encoding.UTF8, data: write });
            return null;
        }
        const info = await Filesystem.stat({ path: FILE, directory: Directory.Data });
        if (info.size > CACHE_MAX_BYTES + 1024 * 1024) throw new Error('Catalogue cache too large');
        const result = await Filesystem.readFile({ path: FILE, directory: Directory.Data, encoding: Encoding.UTF8 });
        return typeof result.data === 'string' ? result.data : null;
    }
    const database = await db();
    try {
        return await new Promise<string | null>((resolve, reject) => {
            const tx = database.transaction('cache', write === undefined ? 'readonly' : 'readwrite');
            const request =
                write === undefined ? tx.objectStore('cache').get('pack') : tx.objectStore('cache').put(write, 'pack');
            let result: string | null = null;
            request.onsuccess = () => {
                if (write === undefined && typeof request.result === 'string') result = request.result;
            };
            tx.oncomplete = () => resolve(result);
            tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('Catalogue storage failed'));
        });
    } finally {
        database.close();
    }
}
export function hydrateCatalogueCache(): Promise<void> {
    return (loaded ??= (async () => {
        const current = epoch;
        try {
            const raw = await disk();
            if (!raw || bytes(raw) > CACHE_MAX_BYTES + 1024 * 1024 || current !== epoch) return;
            const saved: unknown = JSON.parse(raw);
            if (!Array.isArray(saved) || saved.length > CACHE_MAX_ENTRIES) return;
            const restored = new Map<string, Entry>();
            let total = 0;
            for (const row of saved as Entry[]) {
                if (
                    !row ||
                    !cataloguePath(row.path) ||
                    typeof row.text !== 'string' ||
                    bytes(row.text) > SHARD_MAX_BYTES ||
                    typeof row.at !== 'number' ||
                    !Number.isFinite(row.at) ||
                    row.at > Date.now() + 300000 ||
                    row.at < 0
                )
                    continue;
                total += bytes(row.text);
                if (total > CACHE_MAX_BYTES) break;
                restored.set(row.path, row);
            }
            if (current === epoch) rows = restored;
        } catch {
            /* Public references remain available online when local storage fails. */
        }
    })());
}
export async function readCatalogueCache(path: string): Promise<{ text: string; at: number } | null> {
    await hydrateCatalogueCache();
    return rows.get(path) ?? null;
}
/** Serialized pack replacement: concurrent reads/downloads cannot resurrect a deletion. */
export async function writeCatalogueCache(path: string, text: string, expectedEpoch: number): Promise<void> {
    if (!cataloguePath(path) || bytes(text) > SHARD_MAX_BYTES) throw new Error('Invalid catalogue cache entry');
    await hydrateCatalogueCache();
    return serial(async () => {
        if (expectedEpoch !== epoch) return;
        const next = new Map(rows);
        next.delete(path);
        next.set(path, { path, text, at: Date.now() });
        while (next.size > CACHE_MAX_ENTRIES || bytes(JSON.stringify([...next.values()])) > CACHE_MAX_BYTES) {
            const first = next.keys().next().value!;
            next.delete(first);
        }
        await disk(JSON.stringify([...next.values()]));
        if (expectedEpoch === epoch) rows = next;
    });
}
export const catalogueCacheEpoch = () => epoch;
export async function catalogueCacheStats() {
    await hydrateCatalogueCache();
    return { entries: rows.size, bytes: rows.size ? bytes(JSON.stringify([...rows.values()])) : 0 };
}
export async function clearCatalogueCache(): Promise<void> {
    epoch++;
    for (const listener of [...clearListeners]) {
        try {
            listener();
        } catch {
            /* A view cannot prevent deletion. */
        }
    }
    await hydrateCatalogueCache();
    return serial(async () => {
        await disk('[]');
        rows.clear();
    });
}
