/**
 * coastlineSource — pull OSM `natural=coastline` around a point from the public
 * Overpass API, as the land/water geometry the enclosure raycast needs.
 *
 * Strictly best-effort: any failure (offline, rate-limited, timeout) returns
 * null, and the caller then leaves the model wave heights untouched. Coastline
 * is static, so results are cached hard — in-memory for the session and in
 * Capacitor Preferences (30 days) so cold starts don't re-hit Overpass.
 *
 * Mirrors SeamarkService's endpoint-fallback approach; no Pi dependency.
 */

import { Preferences } from '@capacitor/preferences';
import { withDeadline } from '../../../utils/deadline';
import { createLogger } from '../../../utils/createLogger';
import type { Segment } from './shelterGeometry';

const log = createLogger('CoastlineSource');

const OVERPASS_ENDPOINTS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];

const FETCH_TIMEOUT_MS = 9_000;
const PERSIST_TTL_MS = 30 * 24 * 60 * 60 * 1000; // coastline is static — 30 days
const DEG_LAT_KM = 110.54;

interface MemEntry {
    ts: number;
    segs: Segment[];
}
const memCache = new Map<string, MemEntry>();
const inflight = new Map<string, Promise<Segment[] | null>>();

/** Round to a ~11 km grid so nearby requests share one cached coastline. */
function cacheKey(lat: number, lon: number): string {
    const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
    return `coast_${r(lat)}_${r(lon)}`;
}

interface OverpassWay {
    type: string;
    geometry?: Array<{ lat: number; lon: number }>;
}

/** Parse an Overpass `out geom` way list into [lon,lat] segments. */
function waysToSegments(elements: OverpassWay[]): Segment[] {
    const segs: Segment[] = [];
    for (const el of elements) {
        if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
        const pts = el.geometry;
        for (let i = 0; i + 1 < pts.length; i++) {
            const a = pts[i];
            const b = pts[i + 1];
            if (a && b && Number.isFinite(a.lat) && Number.isFinite(b.lat)) {
                segs.push([
                    [a.lon, a.lat],
                    [b.lon, b.lat],
                ]);
            }
        }
    }
    return segs;
}

async function loadPersisted(key: string): Promise<Segment[] | null> {
    try {
        const { value } = await Preferences.get({ key });
        if (!value) return null;
        const parsed = JSON.parse(value) as { ts: number; segs: Segment[] };
        if (!parsed || Date.now() - parsed.ts > PERSIST_TTL_MS) return null;
        return parsed.segs;
    } catch {
        return null;
    }
}

async function persist(key: string, segs: Segment[]): Promise<void> {
    try {
        await Preferences.set({ key, value: JSON.stringify({ ts: Date.now(), segs }) });
    } catch {
        /* non-fatal */
    }
}

async function queryOverpass(lat: number, lon: number, radiusKm: number): Promise<Segment[] | null> {
    const dLat = radiusKm / DEG_LAT_KM;
    const dLon = radiusKm / (DEG_LAT_KM * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
    const s = (lat - dLat).toFixed(4);
    const w = (lon - dLon).toFixed(4);
    const n = (lat + dLat).toFixed(4);
    const e = (lon + dLon).toFixed(4);
    const q = `[out:json][timeout:25];way["natural"="coastline"](${s},${w},${n},${e});out geom;`;

    for (let attempt = 0; attempt < OVERPASS_ENDPOINTS.length; attempt++) {
        const endpoint = OVERPASS_ENDPOINTS[attempt % OVERPASS_ENDPOINTS.length];
        try {
            const res = await withDeadline(
                fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: `data=${encodeURIComponent(q)}`,
                    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                }),
                FETCH_TIMEOUT_MS + 1_000,
                'overpass-coastline',
            );
            if (!res.ok) {
                log.warn(`coastline HTTP ${res.status} from ${endpoint}`);
                continue;
            }
            const data = (await res.json()) as { elements?: OverpassWay[] };
            return waysToSegments(data.elements || []);
        } catch (err) {
            log.warn(`coastline fetch failed on ${endpoint}: ${(err as Error)?.message || err}`);
        }
    }
    return null;
}

/**
 * Coastline segments around a point. Best-effort: returns null on any failure
 * (caller must treat null as "no shelter info — leave waves alone").
 */
export async function fetchCoastlineSegments(lat: number, lon: number, radiusKm = 60): Promise<Segment[] | null> {
    const key = cacheKey(lat, lon);

    const mem = memCache.get(key);
    if (mem) return mem.segs;

    const pending = inflight.get(key);
    if (pending) return pending;

    const task = (async (): Promise<Segment[] | null> => {
        const persisted = await loadPersisted(key);
        if (persisted) {
            memCache.set(key, { ts: Date.now(), segs: persisted });
            return persisted;
        }
        const segs = await queryOverpass(lat, lon, radiusKm);
        if (segs) {
            memCache.set(key, { ts: Date.now(), segs });
            void persist(key, segs);
        }
        return segs;
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
}
