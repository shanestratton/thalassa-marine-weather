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

// ── Auto-download around the user (Pi-only smart caching) ──

/**
 * Compute an OfflineBounds square-ish box of `radiusNm` nautical miles either
 * side of (centerLat, centerLon). Latitude maths is constant (1° ≈ 60 nm);
 * longitude is scaled by cos(lat) so the real-world width stays ~ 2 × radiusNm.
 */
export function boundsAroundPoint(centerLat: number, centerLon: number, radiusNm: number): OfflineBounds {
    const latDelta = radiusNm / 60; // 1° lat ≈ 60 nm
    const cosLat = Math.max(0.01, Math.cos((centerLat * Math.PI) / 180));
    const lonDelta = radiusNm / 60 / cosLat;
    return {
        north: Math.min(85, centerLat + latDelta),
        south: Math.max(-85, centerLat - latDelta),
        east: centerLon + lonDelta,
        west: centerLon - lonDelta,
    };
}

/**
 * Great-circle distance in nautical miles. Good enough for "did the user move
 * far enough to warrant re-caching" — we don't need millimetre accuracy.
 */
export function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R_NM = 3440.065; // Earth radius in NM
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ── Auto-cache bookkeeping ──

const LS_LAST_CENTER_KEY = 'thalassa_map_autocache_last_center';
const MOVE_THRESHOLD_NM = 100; // re-trigger after the user moves this far
/** Hard ceiling on the Pi cache size before we skip auto-caching to protect disk. */
const PI_CACHE_CEILING_MB = 10 * 1024;

interface LastAutoCache {
    lat: number;
    lon: number;
    timestamp: number;
}

function loadLastAutoCache(): LastAutoCache | null {
    try {
        const raw = localStorage.getItem(LS_LAST_CENTER_KEY);
        if (!raw) return null;
        const obj = JSON.parse(raw);
        if (typeof obj?.lat === 'number' && typeof obj?.lon === 'number') {
            return obj as LastAutoCache;
        }
    } catch {
        /* ignore */
    }
    return null;
}

function saveLastAutoCache(lat: number, lon: number): void {
    try {
        localStorage.setItem(LS_LAST_CENTER_KEY, JSON.stringify({ lat, lon, timestamp: Date.now() }));
    } catch {
        /* ignore */
    }
}

export type AutoDownloadOutcome =
    | { status: 'skipped'; reason: string }
    | { status: 'started' }
    | { status: 'done'; tilesCached: number; failed: number }
    | { status: 'error'; message: string };

export interface AutoDownloadOptions {
    centerLat: number;
    centerLon: number;
    /** How far either side of the centre to cover (default 1000 NM). */
    radiusNm?: number;
    /** Zoom range — z6 ocean-view → z10 coastal-detail covers a 1000 NM box
     *  in ~17k tiles per source. Deeper zooms blow tile counts up quickly. */
    minZoom?: number;
    maxZoom?: number;
    /** Optional cancellation */
    signal?: AbortSignal;
    /** Optional progress callback for UI toasts */
    onProgress?: (p: OfflineDownloadProgress) => void;
}

/**
 * Smart auto-cache called when the boat Pi is available. Downloads a
 * 1000 NM coastal box around the user in the background so the map keeps
 * working when the phone drops offline. Skips when:
 *   - No Pi (we only auto-cache onto the Pi, not the phone, because phone
 *     storage and bandwidth are finite)
 *   - Coordinates are invalid or the equator placeholder (0,0)
 *   - User hasn't moved far enough from the last auto-cache centre
 *   - Pi's SQLite cache is already fat (>10 GB) — the skipper can purge
 *     and re-run manually if they want
 */
export async function autoDownloadAroundUser(opts: AutoDownloadOptions): Promise<AutoDownloadOutcome> {
    const { centerLat, centerLon, radiusNm = 1000, minZoom = 6, maxZoom = 10, signal, onProgress } = opts;

    if (!isFinite(centerLat) || !isFinite(centerLon) || (centerLat === 0 && centerLon === 0)) {
        return { status: 'skipped', reason: 'invalid centre' };
    }

    if (!piCache.isAvailable()) {
        return { status: 'skipped', reason: 'no Pi — auto-cache is Pi-only' };
    }

    // Disk-space guard: the Pi cache has LRU eviction, but if it's already
    // massive we'd rather let the skipper make the call.
    const piStatus = piCache.getStatus();
    const piSizeMB = piStatus.cacheStats?.dbSizeMB ?? 0;
    if (piSizeMB > PI_CACHE_CEILING_MB) {
        return { status: 'skipped', reason: `Pi cache already ${(piSizeMB / 1024).toFixed(1)} GB` };
    }

    // Movement threshold — skip if we've already cached near here.
    const last = loadLastAutoCache();
    if (last) {
        const moved = distanceNm(last.lat, last.lon, centerLat, centerLon);
        if (moved < MOVE_THRESHOLD_NM) {
            return {
                status: 'skipped',
                reason: `only moved ${moved.toFixed(0)} NM since last auto-cache`,
            };
        }
    }

    const bounds = boundsAroundPoint(centerLat, centerLon, radiusNm);
    log.info(
        `auto-cache: ${radiusNm}NM around (${centerLat.toFixed(2)},${centerLon.toFixed(2)}) z${minZoom}-z${maxZoom}`,
    );

    onProgress?.({
        phase: 'downloading',
        current: 0,
        total: 0,
        failed: 0,
        route: 'pi',
        message: `Auto-caching ${radiusNm} NM around you…`,
    });

    const result = await downloadArea({ bounds, minZoom, maxZoom, signal, concurrency: 8 }, (p) => onProgress?.(p));

    if (result.phase === 'done') {
        saveLastAutoCache(centerLat, centerLon);
        return { status: 'done', tilesCached: result.current - result.failed, failed: result.failed };
    }
    if (result.phase === 'cancelled') {
        return { status: 'skipped', reason: 'cancelled' };
    }
    return { status: 'error', message: result.message };
}

export const MapOfflineService = {
    enumerateTiles,
    estimateTileCount,
    estimateSizeMB,
    downloadArea,
    boundsAroundPoint,
    distanceNm,
    autoDownloadAroundUser,
};
