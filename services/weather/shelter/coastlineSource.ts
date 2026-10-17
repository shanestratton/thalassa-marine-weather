/**
 * coastlineSource — bounded owned OSM `natural=coastline` around a point,
 * as the community land/water geometry the enclosure raycast needs.
 *
 * Strictly best-effort: any failure (offline, rate-limited, timeout) returns
 * null, and the caller then leaves the model wave heights untouched. Coastline
 * is static, so results are cached hard — in-memory for the session and in
 * Capacitor Preferences (30 days) so cold starts don't re-hit Overpass.
 *
 * Web/native share the fixed own Edge. No public mirror or Pi dependency.
 */

import { Preferences } from '@capacitor/preferences';
import { pruneMap } from '../../../utils/boundedMap';
import { fetchOwnedOverpass } from '../../osm/ownedOverpass';
import type { OwnedOsmElement } from '../../osm/ownedOverpassContract';
import type { Segment } from './shelterGeometry';

const FETCH_TIMEOUT_MS = 9_000;
const PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // coastline is static — 30 days
const DEG_LAT_KM = 110.54;

/** Don't write giant blobs into Capacitor Preferences (NSUserDefaults on
 *  iOS — the whole plist loads into memory). Measured: the Whitsundays
 *  60 km box stringifies to 2.4 MB; Moreton is ~0.9 MB. Over-cap results
 *  stay in memCache for the session and simply re-fetch next boot. */
const PERSIST_MAX_CHARS = 1_500_000;

/** A failed source is remembered for 6h to avoid repeated cold queries in
 * the same 11km cell. The owned transport separately bounds ignored native
 * aborts across headers and body; it never rotates public mirrors. */
const FAILURE_TTL_MS = 6 * 60 * 60 * 1000;
const failedAt = new Map<string, number>();

interface MemEntry {
    ts: number;
    segs: Segment[];
}
const memCache = new Map<string, MemEntry>();
/** Cap ~6 coastline cells — the PERSIST size guard never applied to the
 *  in-memory copy, so precisely the largest Overpass responses were the
 *  ones pinned in heap with no bound. */
const MEM_CACHE_MAX = 6;
const inflight = new Map<string, Promise<Segment[] | null>>();

/** Round to a ~11 km grid so nearby requests share one cached coastline. */
function cacheKey(lat: number, lon: number): string {
    const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
    return `coast_owned_v1_${r(lat)}_${r(lon)}`;
}

function isPoint(value: unknown): value is { lat: number; lon: number } {
    if (!value || typeof value !== 'object') return false;
    const point = value as Record<string, unknown>;
    return (
        typeof point.lat === 'number' &&
        typeof point.lon === 'number' &&
        Number.isFinite(point.lat) &&
        Number.isFinite(point.lon) &&
        Math.abs(point.lat) <= 90 &&
        Math.abs(point.lon) <= 180
    );
}

/** Parse an Overpass `out geom` way list into [lon,lat] segments. */
function waysToSegments(elements: OwnedOsmElement[]): Segment[] {
    const segs: Segment[] = [];
    for (const el of elements) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const pts = el.geometry;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (isPoint(a) && isPoint(b)) {
                segs.push([
                    [a.lon, a.lat],
                    [b.lon, b.lat],
                ]);
            }
        }
    }
    return segs;
}

async function loadPersisted(key: string): Promise<MemEntry | null> {
    try {
        const { value } = await Preferences.get({ key });
        if (!value) return null;
        const parsed = JSON.parse(value) as { ts: number; segs: Segment[] };
        if (
            !parsed ||
            !Number.isFinite(parsed.ts) ||
            parsed.ts > Date.now() + 300_000 ||
            Date.now() - parsed.ts > PERSIST_TTL_MS ||
            !Array.isArray(parsed.segs)
        )
            return null;
        return parsed;
    } catch {
        return null;
    }
}

async function persist(key: string, entry: MemEntry): Promise<void> {
    try {
        const value = JSON.stringify(entry);
        if (value.length > PERSIST_MAX_CHARS) return; // session memCache only
        await Preferences.set({ key, value });
    } catch {
        /* non-fatal */
    }
}

/** Missing owned source leaves model wave heights untouched on web/native. */
async function queryOverpass(lat: number, lon: number, radiusKm: number): Promise<MemEntry | null> {
    const dLat = radiusKm / DEG_LAT_KM;
    const dLon = radiusKm / (DEG_LAT_KM * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    const s = (lat - dLat).toFixed(4);
    const w = (lon - dLon).toFixed(4);
    const n = (lat + dLat).toFixed(4);
    const e = (lon + dLon).toFixed(4);
    const q = `[out:json][timeout:25];way["natural"="coastline"](${s},${w},${n},${e});out geom;`;

    try {
        const body = await fetchOwnedOverpass(q, { timeoutMs: FETCH_TIMEOUT_MS });
        const ts = Date.parse(body.thalassaSource.sourceAt);
        if (Date.now() - ts > PERSIST_TTL_MS) return null;
        return { segs: waysToSegments(body.elements), ts };
    } catch {
        return null;
    }
}

/**
 * Coastline segments around a point. Best-effort: returns null on any failure
 * (caller must treat null as "no shelter info — leave waves alone").
 */
export async function fetchCoastlineSegments(lat: number, lon: number, radiusKm = 60): Promise<Segment[] | null> {
    const key = cacheKey(lat, lon);

    const mem = memCache.get(key);
    if (mem && mem.ts <= Date.now() + 300_000 && Date.now() - mem.ts <= PERSIST_TTL_MS) return mem.segs;

    const lastFail = failedAt.get(key);
    if (lastFail !== undefined && Date.now() - lastFail < FAILURE_TTL_MS) return null;

    const pending = inflight.get(key);
    if (pending) return pending;

    const task = (async (): Promise<Segment[] | null> => {
        const persisted = await loadPersisted(key);
        if (persisted) {
            memCache.set(key, persisted);
            pruneMap(memCache, MEM_CACHE_MAX);
            return persisted.segs;
        }
        const original = await queryOverpass(lat, lon, radiusKm);
        if (original) {
            failedAt.delete(key);
            memCache.set(key, original);
            pruneMap(memCache, MEM_CACHE_MAX);
            void persist(key, original);
        } else {
            failedAt.set(key, Date.now());
        }
        return original?.segs ?? null;
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
}
