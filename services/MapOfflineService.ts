/**
 * MapOfflineService — Pre-download raster map tiles for offline use.
 *
 * Routing:
 *   - Pi available → tiles fetched through `piCache.passthroughTileUrl(url)`
 *     so they live on the boat's Pi SQLite cache and survive app reinstalls.
 *   - Pi unavailable → tiles fetched directly and cached by the service worker
 *     (see `public/sw.js` — TILE_CACHE, cache-first).
 *
 * Tile sources covered:
 *   - OSM raster base:  https://tile.openstreetmap.org/{z}/{x}/{y}.png
 *   - OpenSeaMap sea-marks overlay: https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png
 *
 * Mapbox vector tiles are NOT pre-fetched here — they have per-style URLs with
 * embedded access tokens and are already cached cache-first by the SW whenever
 * the user has viewed the area while online.
 */

import { piCache } from './PiCacheService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('MapOffline');

// ── Types ──

export interface OfflineBounds {
    north: number;
    south: number;
    east: number;
    west: number;
}

export type OfflineDownloadPhase = 'idle' | 'downloading' | 'done' | 'error' | 'cancelled';

export interface OfflineDownloadProgress {
    phase: OfflineDownloadPhase;
    current: number;
    total: number;
    failed: number;
    /** Which routing path is being used */
    route: 'pi' | 'direct';
    message: string;
}

export interface OfflineDownloadOptions {
    bounds: OfflineBounds;
    /** Inclusive. Typical cruising range: 8 (region) – 13 (harbour). */
    minZoom: number;
    maxZoom: number;
    /** How many parallel fetches. Tune for the Pi / local network. */
    concurrency?: number;
    /** Cancellation signal */
    signal?: AbortSignal;
}

// ── Tile URL templates ──

const TILE_TEMPLATES = [
    { name: 'osm', url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png' },
    { name: 'openseamap', url: 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png' },
];

// ── Public API ──

/**
 * Convert lon/lat/zoom → tile (x,y) — standard slippy-map projection.
 */
function lonLatToTile(lon: number, lat: number, z: number): { x: number; y: number } {
    const n = Math.pow(2, z);
    const x = Math.floor(((lon + 180) / 360) * n);
    const latRad = (lat * Math.PI) / 180;
    const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
    return { x: Math.max(0, Math.min(n - 1, x)), y: Math.max(0, Math.min(n - 1, y)) };
}

/**
 * Enumerate every tile (z,x,y) that covers the bounds between minZoom and maxZoom inclusive.
 */
export function enumerateTiles(
    bounds: OfflineBounds,
    minZoom: number,
    maxZoom: number,
): Array<{ z: number; x: number; y: number }> {
    const tiles: Array<{ z: number; x: number; y: number }> = [];
    for (let z = minZoom; z <= maxZoom; z++) {
        const tl = lonLatToTile(bounds.west, bounds.north, z);
        const br = lonLatToTile(bounds.east, bounds.south, z);
        const xMin = Math.min(tl.x, br.x);
        const xMax = Math.max(tl.x, br.x);
        const yMin = Math.min(tl.y, br.y);
        const yMax = Math.max(tl.y, br.y);
        for (let x = xMin; x <= xMax; x++) {
            for (let y = yMin; y <= yMax; y++) {
                tiles.push({ z, x, y });
            }
        }
    }
    return tiles;
}

/**
 * Estimate how many tiles will be downloaded (across every source).
 * Useful for showing a count + rough MB figure before starting.
 */
export function estimateTileCount(bounds: OfflineBounds, minZoom: number, maxZoom: number): number {
    return enumerateTiles(bounds, minZoom, maxZoom).length * TILE_TEMPLATES.length;
}

/**
 * Approximate download size in MB. Raster tiles average ~10–30 KB each;
 * we use 20 KB as a mid-range estimate.
 */
export function estimateSizeMB(tileCount: number): number {
    return Math.round((tileCount * 20) / 1024);
}

function fillTemplate(template: string, z: number, x: number, y: number): string {
    return template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));
}

// 30-day TTL for offline tiles on the Pi (default passthroughTileUrl TTL is 30 min).
const OFFLINE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Download every tile for the given bounds/zoom range.
 *
 * Returns a promise that resolves when the download completes (or rejects if
 * the supplied AbortSignal aborts). Progress is emitted via `onProgress`.
 */
export async function downloadArea(
    options: OfflineDownloadOptions,
    onProgress: (p: OfflineDownloadProgress) => void,
): Promise<OfflineDownloadProgress> {
    const { bounds, minZoom, maxZoom, concurrency = 6, signal } = options;

    const coords = enumerateTiles(bounds, minZoom, maxZoom);
    const targets: string[] = [];
    for (const { z, x, y } of coords) {
        for (const { url } of TILE_TEMPLATES) {
            targets.push(fillTemplate(url, z, x, y));
        }
    }

    const usePi = piCache.isAvailable();
    const route: 'pi' | 'direct' = usePi ? 'pi' : 'direct';
    const total = targets.length;
    let current = 0;
    let failed = 0;

    const emit = (phase: OfflineDownloadPhase, message: string) => {
        onProgress({ phase, current, total, failed, route, message });
    };

    emit('downloading', `Starting — ${total} tiles via ${usePi ? 'Pi cache' : 'phone cache'}`);

    // Worker pool — pulls tiles off the queue until empty
    const queue = targets.slice();
    const workers: Promise<void>[] = [];

    const worker = async () => {
        while (queue.length > 0) {
            if (signal?.aborted) return;
            const url = queue.shift();
            if (!url) return;

            let fetchUrl = url;
            if (usePi) {
                const piUrl = piCache.passthroughTileUrl(url, OFFLINE_TTL_MS);
                if (piUrl) fetchUrl = piUrl;
            }

            try {
                const res = await fetch(fetchUrl, { signal, cache: 'reload' });
                if (!res.ok) failed++;
            } catch (err) {
                if (signal?.aborted) return;
                failed++;
                log.warn(`Tile failed: ${url}`, err);
            }

            current++;
            // Throttle progress events — every 4 tiles (or on the last one)
            if (current % 4 === 0 || current === total) {
                emit('downloading', `${current} / ${total}${failed > 0 ? ` · ${failed} failed` : ''}`);
            }
        }
    };

    for (let i = 0; i < concurrency; i++) workers.push(worker());

    try {
        await Promise.all(workers);
    } catch (err) {
        if (signal?.aborted) {
            emit('cancelled', `Cancelled at ${current} / ${total}`);
            return { phase: 'cancelled', current, total, failed, route, message: 'Cancelled' };
        }
        log.error('Download failed', err);
        emit('error', 'Download failed');
        return { phase: 'error', current, total, failed, route, message: 'Download failed' };
    }

    if (signal?.aborted) {
        emit('cancelled', `Cancelled at ${current} / ${total}`);
        return { phase: 'cancelled', current, total, failed, route, message: 'Cancelled' };
    }

    const okCount = current - failed;
    emit('done', `Done — ${okCount} cached${failed > 0 ? `, ${failed} failed` : ''}`);
    return { phase: 'done', current, total, failed, route, message: 'Done' };
}

export const MapOfflineService = {
    enumerateTiles,
    estimateTileCount,
    estimateSizeMB,
    downloadArea,
};
