import { Capacitor, CapacitorHttp } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import { satelliteModeBlocks } from './networkPolicy';
import { onOfflineReliefUse, publishOfflineRelief } from './offlineReliefRuntime';
import {
    RELIEF_OFFLINE_DIRECTORY,
    RELIEF_OFFLINE_LIMIT_BYTES,
    RELIEF_OFFLINE_LIMIT_TILES,
    RELIEF_TILE_MAX_BYTES,
    RELIEF_WEB_CACHE,
    planReliefArea,
    readReliefBytes,
    reliefTile,
    validateReliefBytes,
    type ReliefBounds,
    type ReliefTile,
} from './offlineReliefPlan';

interface SavedTile {
    url: string;
    bytes: number;
    usedAt: number;
}
export interface ReliefStorage {
    tiles: number;
    bytes: number;
}
export interface ReliefProgress {
    phase: 'downloading' | 'done' | 'cancelled' | 'error';
    current: number;
    total: number;
    saved: number;
    missing: number;
    failed: number;
    message: string;
}
const MANIFEST = `${RELIEF_OFFLINE_DIRECTORY}/index.json`;
const WEB_MANIFEST = 'https://tiles.thalassatiles.com/__offline-relief-manifest-v1';
let rows: SavedTile[] = [];
let nativeRoot = '';
let hydration: Promise<void> | undefined;
let active: 'download' | 'delete' | null = null;
let storageFault = false;
class ReliefStorageError extends Error {}
let writes: Promise<unknown> = Promise.resolve();
let touchTimer: ReturnType<typeof setTimeout> | undefined;
const native = () => Capacitor.isNativePlatform();
const path = (tile: ReliefTile) => `${RELIEF_OFFLINE_DIRECTORY}/${tile.key}`;
function publish() {
    publishOfflineRelief(
        new Map(rows.map((r) => [r.url, native() ? `${nativeRoot}/${reliefTile(r.url)!.key}` : r.url])),
    );
}
export function reliefStorage(): ReliefStorage {
    return { tiles: rows.length, bytes: rows.reduce((n, r) => n + r.bytes, 0) };
}
function acceptManifest(value: unknown): SavedTile[] {
    if (
        !value ||
        typeof value !== 'object' ||
        !('schema' in value) ||
        value.schema !== 1 ||
        !('tiles' in value) ||
        !Array.isArray(value.tiles)
    )
        return [];
    const result: SavedTile[] = [],
        urls = new Set<string>();
    let size = 0;
    for (const row of value.tiles
        .slice(0, RELIEF_OFFLINE_LIMIT_TILES)
        .sort((a, b) => Number(b?.usedAt) - Number(a?.usedAt))) {
        if (
            !row ||
            typeof row.url !== 'string' ||
            !reliefTile(row.url) ||
            urls.has(row.url) ||
            !Number.isInteger(row.bytes) ||
            row.bytes < 30 ||
            row.bytes > RELIEF_TILE_MAX_BYTES ||
            !Number.isFinite(row.usedAt) ||
            row.usedAt < 0 ||
            row.usedAt > Date.now() + 300000 ||
            size + row.bytes > RELIEF_OFFLINE_LIMIT_BYTES
        )
            continue;
        result.push({ url: row.url, bytes: row.bytes, usedAt: row.usedAt });
        size += row.bytes;
        urls.add(row.url);
    }
    return result;
}
async function persist() {
    const data = JSON.stringify({ schema: 1, tiles: rows });
    if (native())
        await Filesystem.writeFile({ path: MANIFEST, directory: Directory.Data, encoding: Encoding.UTF8, data });
    else
        await (
            await caches.open(RELIEF_WEB_CACHE)
        ).put(WEB_MANIFEST, new Response(data, { headers: { 'content-type': 'application/json' } }));
}
function serial<T>(job: () => Promise<T>): Promise<T> {
    const next = writes.catch(() => undefined).then(job);
    writes = next;
    return next;
}
/** No network. A fresh process validates the bounded index against real persistent files/cache entries. */
export function hydrateRelief(): Promise<void> {
    return (hydration ??= (async () => {
        rows = [];
        if (native()) {
            await Filesystem.mkdir({
                path: RELIEF_OFFLINE_DIRECTORY,
                directory: Directory.Data,
                recursive: true,
            }).catch(() => undefined);
            const root = await Filesystem.getUri({ path: RELIEF_OFFLINE_DIRECTORY, directory: Directory.Data });
            nativeRoot = Capacitor.convertFileSrc(root.uri).replace(/\/$/, '');
            const files = (await Filesystem.readdir({ path: RELIEF_OFFLINE_DIRECTORY, directory: Directory.Data }))
                .files;
            const index = files.find((f) => f.name === 'index.json');
            if (index && index.size <= 1024 * 1024) {
                const data = await Filesystem.readFile({
                    path: MANIFEST,
                    directory: Directory.Data,
                    encoding: Encoding.UTF8,
                });
                try {
                    rows = acceptManifest(JSON.parse(String(data.data)));
                } catch {
                    rows = [];
                }
            }
            const actual = new Map(files.filter((f) => f.type === 'file').map((f) => [f.name, f.size]));
            rows = rows.filter((r) => actual.get(reliefTile(r.url)!.key) === r.bytes);
            const keep = new Set(rows.map((r) => reliefTile(r.url)!.key));
            // Recover crash-orphaned terrain only. This directory never contains chart-vault data.
            for (const f of files)
                if (/^v[1-9]\d{0,2}_(global|au)_(dem|idx)_\d+_\d+_\d+\.(png|webp)$/.test(f.name) && !keep.has(f.name))
                    await Filesystem.deleteFile({
                        path: `${RELIEF_OFFLINE_DIRECTORY}/${f.name}`,
                        directory: Directory.Data,
                    });
        } else {
            if (typeof caches === 'undefined') throw new Error('Offline browser storage is unavailable.');
            const cache = await caches.open(RELIEF_WEB_CACHE),
                index = await cache.match(WEB_MANIFEST);
            if (index) {
                const text = await index.text();
                if (text.length <= 1024 * 1024) {
                    try {
                        rows = acceptManifest(JSON.parse(text));
                    } catch {
                        rows = [];
                    }
                }
            }
            const found: SavedTile[] = [];
            for (const row of rows) {
                const response = await cache.match(row.url);
                if (response && response.headers.get('x-thalassa-relief-bytes') === String(row.bytes)) found.push(row);
            }
            rows = found;
            const keep = new Set(rows.map((r) => r.url));
            for (const request of await cache.keys())
                if (reliefTile(request.url) && !keep.has(request.url)) await cache.delete(request);
        }
        // Reading validated existing files must work even when a full disk
        // cannot rewrite metadata. New tile commits remain strict below.
        await persist().catch(() => undefined);
        onOfflineReliefUse((url) => {
            const row = rows.find((r) => r.url === url);
            if (row) row.usedAt = Date.now();
            touchTimer ??= setTimeout(() => {
                touchTimer = undefined;
                void serial(persist).catch(() => undefined);
            }, 2000);
        });
        publish();
    })().catch((error) => {
        rows = [];
        publish();
        hydration = undefined;
        throw error;
    }));
}
async function remove(row: SavedTile) {
    const tile = reliefTile(row.url)!;
    if (native()) await Filesystem.deleteFile({ path: path(tile), directory: Directory.Data });
    else await (await caches.open(RELIEF_WEB_CACHE)).delete(tile.url);
    rows = rows.filter((r) => r.url !== row.url);
}
async function reconcileSavedRelief() {
    // Finish any boot hydration, then reconcile under the write queue. A browser
    // may have evicted cached files since this process last read its index.
    await hydrateRelief();
    await serial(async () => {
        const used = new Map(rows.map((row) => [row.url, row.usedAt]));
        hydration = undefined;
        await hydrateRelief();
        for (const row of rows) row.usedAt = Math.max(row.usedAt, used.get(row.url) ?? 0);
        await persist().catch(() => undefined);
        storageFault = false;
    });
}
/** Delete only this feature's validated terrain, preserving free/imported/boat charts. */
export async function deleteSavedRelief(): Promise<void> {
    if (active) throw new Error('Cancel the download or wait for deletion to finish before deleting saved relief.');
    active = 'delete';
    try {
        await reconcileSavedRelief();
        await serial(async () => {
            try {
                for (const row of [...rows]) await remove(row);
            } finally {
                try {
                    await persist();
                } finally {
                    publish();
                }
            }
        });
    } finally {
        active = null;
    }
}
function base64(bytes: Uint8Array): string {
    let value = '';
    for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(value);
}
function checkAbort(signal: AbortSignal) {
    if (signal.aborted) throw new DOMException('Download cancelled', 'AbortError');
}
async function fetchTile(tile: ReliefTile, signal: AbortSignal): Promise<Uint8Array | null> {
    checkAbort(signal);
    if (satelliteModeBlocks('offline-download')) throw new Error('Turn off Satellite Mode before downloading relief.');
    const controller = new AbortController(),
        abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 18000);
    try {
        if (native()) {
            // Native fetch is patched by Capacitor: use its explicit no-redirect API instead.
            const response = await Promise.race([
                CapacitorHttp.get({
                    url: tile.url,
                    responseType: 'arraybuffer',
                    disableRedirects: true,
                    connectTimeout: 15000,
                    readTimeout: 15000,
                }),
                new Promise<never>((_, reject) =>
                    controller.signal.addEventListener(
                        'abort',
                        () => reject(new DOMException('Download cancelled or timed out', 'AbortError')),
                        { once: true },
                    ),
                ),
            ]);
            checkAbort(signal);
            if (response.url !== tile.url) throw new Error('Relief redirect refused.');
            if (response.status === 404) return null;
            const headers = new Headers(response.headers);
            if (
                response.status !== 200 ||
                headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== tile.mime ||
                Number(headers.get('content-length')) > RELIEF_TILE_MAX_BYTES ||
                typeof response.data !== 'string' ||
                response.data.length > Math.ceil(RELIEF_TILE_MAX_BYTES / 3) * 4 ||
                !/^[A-Za-z0-9+/]*={0,2}$/.test(response.data)
            )
                throw new Error('Relief response invalid.');
            return validateReliefBytes(
                Uint8Array.from(atob(response.data), (c) => c.charCodeAt(0)),
                tile.mime,
            );
        }
        const response = await fetch(tile.url, {
            signal: controller.signal,
            redirect: 'error',
            credentials: 'omit',
            cache: 'reload',
        });
        checkAbort(signal);
        if (response.redirected || (response.url && response.url !== tile.url))
            throw new Error('Relief redirect refused.');
        if (response.status === 404) return null;
        return await readReliefBytes(response, tile.mime);
    } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
    }
}
async function store(tile: ReliefTile, bytes: Uint8Array, signal: AbortSignal, pinned: ReadonlySet<string>) {
    await serial(async () => {
        if (storageFault) throw new ReliefStorageError('Relief storage needs cleanup before another write.');
        try {
            checkAbort(signal);
            while (
                rows.length >= RELIEF_OFFLINE_LIMIT_TILES ||
                reliefStorage().bytes + bytes.length > RELIEF_OFFLINE_LIMIT_BYTES
            ) {
                const candidates = rows.filter((r) => !pinned.has(r.url));
                if (!candidates.length)
                    throw new ReliefStorageError('This area exceeds 128 MiB. Choose a smaller area or lower detail.');
                const oldest = candidates.reduce((a, b) => (a.usedAt <= b.usedAt ? a : b));
                await remove(oldest);
            }
            checkAbort(signal);
            if (native()) {
                try {
                    await Filesystem.writeFile({ path: path(tile), directory: Directory.Data, data: base64(bytes) });
                } catch (error) {
                    // Filesystem errors can leave a partially written file. Stop the
                    // whole operation; the next operation must reconcile it first.
                    await Filesystem.deleteFile({ path: path(tile), directory: Directory.Data }).catch(() => undefined);
                    throw error;
                }
            } else
                await (
                    await caches.open(RELIEF_WEB_CACHE)
                ).put(
                    tile.url,
                    new Response(bytes.slice().buffer, {
                        headers: {
                            'content-type': tile.mime,
                            'content-length': String(bytes.length),
                            'x-thalassa-relief-bytes': String(bytes.length),
                        },
                    }),
                );
            if (signal.aborted) {
                if (native()) await Filesystem.deleteFile({ path: path(tile), directory: Directory.Data });
                else await (await caches.open(RELIEF_WEB_CACHE)).delete(tile.url);
                checkAbort(signal);
            }
            rows.push({ url: tile.url, bytes: bytes.length, usedAt: Date.now() });
            try {
                await persist();
            } catch (error) {
                await remove(rows.find((r) => r.url === tile.url)!);
                throw error;
            }
        } catch (error) {
            storageFault = true;
            if (signal.aborted) throw error;
            throw error instanceof ReliefStorageError
                ? error
                : new ReliefStorageError('Relief storage failed. Free space or delete saved relief, then retry.');
        }
    });
}
/** Explicit user action only; Satellite Mode still blocks bulk terrain downloads. */
export async function downloadReliefArea(
    bounds: ReliefBounds,
    detail: number,
    base: string,
    signal: AbortSignal,
    report: (progress: ReliefProgress) => void,
): Promise<void> {
    if (active) throw new Error('A relief download or deletion is already running.');
    const plan = planReliefArea(bounds, detail, base);
    if (plan.tooLarge) throw new Error('Choose a smaller area or lower detail (maximum 4,096 tiles).');
    if (satelliteModeBlocks('offline-download')) throw new Error('Turn off Satellite Mode before downloading relief.');
    active = 'download';
    const p: ReliefProgress = {
        phase: 'downloading',
        current: 0,
        total: plan.tileCount,
        saved: 0,
        missing: 0,
        failed: 0,
        message: 'Preparing saved relief…',
    };
    report({ ...p });
    try {
        await reconcileSavedRelief();
        checkAbort(signal);
        let next = 0;
        let storageFailed = false;
        const pinned = new Set(plan.tiles.map((tile) => tile.url));
        await Promise.all(
            [0, 1].map(async () => {
                while (next < plan.tiles.length && !signal.aborted && !storageFailed) {
                    const tile = plan.tiles[next++];
                    try {
                        const existing = rows.find((r) => r.url === tile.url);
                        if (existing) {
                            existing.usedAt = Date.now();
                            p.saved++;
                        } else {
                            const bytes = await fetchTile(tile, signal);
                            if (bytes) {
                                await store(tile, bytes, signal, pinned);
                                p.saved++;
                            } else p.missing++;
                        }
                    } catch (error) {
                        if (error instanceof ReliefStorageError) storageFailed = true;
                        if (!signal.aborted) {
                            p.failed++;
                            p.message = error instanceof Error ? error.message : 'Tile could not be saved.';
                        }
                    }
                    p.current++;
                    report({ ...p });
                }
            }),
        );
        await serial(persist);
        publish();
        p.phase = signal.aborted ? 'cancelled' : storageFailed || (p.failed && !p.saved) ? 'error' : 'done';
        p.message = `${p.saved} saved; ${p.missing} outside terrain coverage; ${p.failed} failed. ${signal.aborted ? 'Download cancelled.' : p.saved ? 'Saved relief is available offline.' : 'No relief was saved.'}${p.failed ? ' ' + p.message : ''}`;
    } catch (error) {
        p.phase = signal.aborted ? 'cancelled' : 'error';
        p.message = error instanceof Error ? error.message : 'Relief storage unavailable.';
    } finally {
        active = null;
        publish();
        report({ ...p });
    }
}
