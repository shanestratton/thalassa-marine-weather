/**
 * windGridPersist — carry the wind grid cache across app launches.
 *
 * WHY THIS EXISTS. Measured 2026-08-22, against Open-Meteo directly (so no
 * proxy, no app, no device in the way):
 *
 *     1 point  → 1.26 s        8 points → 1.55 s
 *     16 points → 1.55 s      32 points → 1.89 s
 *     32 points split 4×8 in parallel → 1.61 s wall
 *
 * There is a ~1.2 s FLOOR on a single point. Point count barely moves it,
 * halving the forecast hours saves ~0.3 s, and parallelising the batches buys
 * 0.27 s for a lot of complexity. Our Supabase hop adds ~0.13 s on top
 * (1986 ms in-app vs 1855 ms direct), so the proxy is not the problem either.
 *
 * The conclusion that matters: **wind cannot be made fast by restructuring the
 * request.** Windy feels instant because it serves precomputed grids from its
 * own CDN rather than calling a point API. The only way to beat a 1.2 s floor
 * is to not be on the network at all (Shane 2026-08-22: "speed, speed and
 * speed … Windy can do it, so we can").
 *
 * So the in-memory grid cache — which already makes the SECOND look at a patch
 * of water instant — gets to survive a relaunch. First wind of the session
 * paints from disk while the refresh runs behind it.
 *
 * FRESHNESS IS NOT REINVENTED HERE. Entries carry the same `fetchedAt` the
 * memory cache uses and are filtered by the SAME window the memory cache
 * applies (WIND_GRID_MAX_AGE_MS, 3 h — one ECMWF run). Nothing can paint from
 * disk that would not already have painted from memory; this only changes how
 * long the cache lives. That matters for a marine app: stale wind shown as
 * current is a safety problem, not a performance one.
 */
import { createLogger } from '../../utils/createLogger';
import type { WindGrid } from './windGridEncoding';

const log = createLogger('windGridPersist');

/** Bumped when the serialized shape changes — old payloads are dropped, never
 *  half-read. */
const STORAGE_KEY = 'thalassa.wind.gridcache.v1';

/** Per-entry ceiling. A 16×16×48 h grid is ~150 kB of base64; anything much
 *  larger is a wide synoptic pull whose re-fetch cost we would rather pay than
 *  spend the quota on. */
const MAX_ENTRY_BYTES = 512 * 1024;
/** Total ceiling across all entries — localStorage is a shared, small budget
 *  and wind must never be the reason another feature cannot write. */
const MAX_TOTAL_BYTES = 1024 * 1024;
/** Tiers worth keeping: the local fine grid and the synoptic warm. */
const MAX_ENTRIES = 2;

export interface PersistableEntry {
    grid: WindGrid;
    bounds: { north: number; south: number; west: number; east: number };
    res: number;
    model: string;
    fetchedAt: number;
}

/** Base64 of a Float32Array's bytes. Chunked because String.fromCharCode with
 *  a whole 150 kB array as arguments blows the call stack. */
function encodeFloats(values: Float32Array): string {
    const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
    let binary = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
}

function decodeFloats(encoded: string): Float32Array | null {
    try {
        const binary = atob(encoded);
        if (binary.length % 4 !== 0) return null;
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        return new Float32Array(bytes.buffer);
    } catch {
        return null;
    }
}

/** Flatten [hour][cell] into one array so the payload is three base64 blobs
 *  rather than 3×48 of them. */
function flatten(frames: Float32Array[], cells: number, hours: number): Float32Array | null {
    if (frames.length < hours) return null;
    const out = new Float32Array(cells * hours);
    for (let h = 0; h < hours; h += 1) {
        const frame = frames[h];
        if (!frame || frame.length < cells) return null;
        out.set(frame.subarray(0, cells), h * cells);
    }
    return out;
}

function unflatten(flat: Float32Array, cells: number, hours: number): Float32Array[] {
    const frames: Float32Array[] = [];
    for (let h = 0; h < hours; h += 1) {
        frames.push(flat.slice(h * cells, (h + 1) * cells));
    }
    return frames;
}

/**
 * Serialize one cache entry, or null when it is not safely persistable.
 *
 * Refuses SPARSE grids outright. The WindGrid type is shared with the CMEMS
 * frame-on-demand path, whose u/v arrays are deliberately holey — flattening
 * one would silently write zeros where a frame had not been decoded yet, and
 * zeros in a wind field read as a dead calm rather than as missing data.
 */
export function serializeEntry(entry: PersistableEntry): string | null {
    const { grid } = entry;
    const cells = grid.width * grid.height;
    const hours = grid.totalHours;
    if (!Number.isFinite(cells) || cells <= 0 || !Number.isFinite(hours) || hours <= 0) return null;
    const u = flatten(grid.u, cells, hours);
    const v = flatten(grid.v, cells, hours);
    const speed = flatten(grid.speed, cells, hours);
    if (!u || !v || !speed) return null;

    const payload = {
        w: grid.width,
        h: grid.height,
        hours,
        lats: grid.lats,
        lons: grid.lons,
        n: grid.north,
        s: grid.south,
        e: grid.east,
        wst: grid.west,
        refTime: grid.refTime,
        hourOffsets: grid.hourOffsets,
        stepHours: grid.stepHours,
        res: entry.res,
        model: entry.model,
        fetchedAt: entry.fetchedAt,
        bounds: entry.bounds,
        u: encodeFloats(u),
        v: encodeFloats(v),
        sp: encodeFloats(speed),
    };
    const json = JSON.stringify(payload);
    if (json.length > MAX_ENTRY_BYTES) return null;
    return json;
}

export function deserializeEntry(json: string): PersistableEntry | null {
    try {
        const p = JSON.parse(json) as Record<string, unknown>;
        const w = Number(p.w);
        const h = Number(p.h);
        const hours = Number(p.hours);
        const fetchedAt = Number(p.fetchedAt);
        if (![w, h, hours, fetchedAt].every((n) => Number.isFinite(n) && n > 0)) return null;
        const cells = w * h;
        const u = decodeFloats(String(p.u));
        const v = decodeFloats(String(p.v));
        const speed = decodeFloats(String(p.sp));
        if (!u || !v || !speed) return null;
        if (u.length !== cells * hours || v.length !== cells * hours || speed.length !== cells * hours) return null;
        const bounds = p.bounds as PersistableEntry['bounds'] | undefined;
        if (!bounds || ![bounds.north, bounds.south, bounds.east, bounds.west].every(Number.isFinite)) return null;

        const grid: WindGrid = {
            u: unflatten(u, cells, hours),
            v: unflatten(v, cells, hours),
            speed: unflatten(speed, cells, hours),
            width: w,
            height: h,
            lats: Array.isArray(p.lats) ? (p.lats as number[]) : [],
            lons: Array.isArray(p.lons) ? (p.lons as number[]) : [],
            north: Number(p.n),
            south: Number(p.s),
            east: Number(p.e),
            west: Number(p.wst),
            totalHours: hours,
            refTime: typeof p.refTime === 'string' ? p.refTime : undefined,
            hourOffsets: Array.isArray(p.hourOffsets) ? (p.hourOffsets as number[]) : undefined,
            stepHours: Array.isArray(p.stepHours) ? (p.stepHours as number[]) : undefined,
        };
        return { grid, bounds, res: Number(p.res), model: String(p.model), fetchedAt };
    } catch {
        return null;
    }
}

/** Persist up to MAX_ENTRIES, newest first, within the byte budget. */
export function saveWindGrids(entries: readonly PersistableEntry[]): void {
    try {
        const newestFirst = [...entries].sort((a, b) => b.fetchedAt - a.fetchedAt).slice(0, MAX_ENTRIES);
        const encoded: string[] = [];
        let total = 0;
        for (const entry of newestFirst) {
            const json = serializeEntry(entry);
            if (!json) continue;
            if (total + json.length > MAX_TOTAL_BYTES) break;
            total += json.length;
            encoded.push(json);
        }
        if (encoded.length === 0) {
            localStorage.removeItem(STORAGE_KEY);
            return;
        }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(encoded));
    } catch (err) {
        // A full quota must never break wind. The memory cache still works;
        // the only cost is a slower first paint next launch.
        log.warn('could not persist wind grids', err);
    }
}

/**
 * Load persisted grids that are still inside `maxAgeMs`.
 *
 * The caller passes its OWN staleness window so this module can never disagree
 * with the memory cache about what counts as fresh.
 */
export function loadWindGrids(maxAgeMs: number, now = Date.now()): PersistableEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const list = JSON.parse(raw) as unknown;
        if (!Array.isArray(list)) return [];
        const out: PersistableEntry[] = [];
        for (const item of list) {
            if (typeof item !== 'string') continue;
            const entry = deserializeEntry(item);
            if (!entry) continue;
            if (now - entry.fetchedAt > maxAgeMs) continue;
            out.push(entry);
        }
        return out;
    } catch (err) {
        log.warn('could not read persisted wind grids', err);
        return [];
    }
}

export function clearWindGrids(): void {
    try {
        localStorage.removeItem(STORAGE_KEY);
    } catch {
        /* nothing to do */
    }
}
