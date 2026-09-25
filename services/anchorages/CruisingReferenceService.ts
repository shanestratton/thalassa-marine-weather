import { Preferences } from '@capacitor/preferences';
import { validFetchTable } from './placeConditions';
import {
    parseOsmReferences,
    parseQpwsReferences,
    referenceQuery,
    validCachedReference,
    type CruisingPoint,
    type ReferenceTile,
} from './cruisingReference';

const CACHE_KEY = 'thalassa_cruising_reference_v1';
const MAX_TILES = 24;
const MAX_CACHE_POINTS = 6000;
const FRESH_MS = 24 * 60 * 60_000;
interface CachedTile {
    at: number;
    points: CruisingPoint[];
}
export interface ReferenceResult {
    points: CruisingPoint[];
    stale: boolean;
}
const cache = new Map<string, CachedTile>();
let restored = false;
let official: Promise<CruisingPoint[]> | null = null;

async function restore(): Promise<void> {
    if (restored) return;
    restored = true;
    try {
        const { value } = await Preferences.get({ key: CACHE_KEY });
        const rows: [string, CachedTile][] = value ? JSON.parse(value) : [];
        let count = 0;
        for (const [key, row] of rows.slice(-MAX_TILES)) {
            if (
                !row ||
                !Number.isFinite(row.at) ||
                row.at > Date.now() + 300_000 ||
                !Array.isArray(row.points) ||
                !row.points.every(validCachedReference) ||
                (count += row.points.length) > MAX_CACHE_POINTS
            )
                continue;
            cache.set(key, row);
        }
    } catch {
        /* Cache unavailable; network can still provide references. */
    }
}

async function remember(key: string, row: CachedTile): Promise<void> {
    cache.delete(key);
    cache.set(key, row);
    let count = [...cache.values()].reduce((n, r) => n + r.points.length, 0);
    while (cache.size > MAX_TILES || count > MAX_CACHE_POINTS) {
        const first = cache.keys().next().value!;
        count -= cache.get(first)!.points.length;
        cache.delete(first);
    }
    try {
        await Preferences.set({ key: CACHE_KEY, value: JSON.stringify([...cache]) });
    } catch {
        /* Optional offline copy. */
    }
}

export async function loadOfficialMoorings(): Promise<CruisingPoint[]> {
    if (!official)
        official = fetch('/anchorages/moorings/qpws.json')
            .then(async (res) => {
                if (!res.ok) throw new Error('Official mooring snapshot unavailable');
                const body = await res.json();
                if (!Number.isFinite(Date.parse(body.retrievedAt))) throw new Error('Missing snapshot date');
                const points = parseQpwsReferences(body.data, body.retrievedAt);
                // A new mooring position must not inherit an old position's lee.
                try {
                    const shelterRes = await fetch('/anchorages/moorings/shelter.json');
                    if (!shelterRes.ok) return points;
                    const shelter = await shelterRes.json();
                    if (shelter.mooringSnapshotAt !== body.retrievedAt) return points;
                    for (const p of points) {
                        const s = shelter.points?.[p.id];
                        if (s?.lat === p.lat && s?.lon === p.lon && validFetchTable(s.fetchLandNM))
                            p.fetchLandNM = s.fetchLandNM;
                    }
                } catch {
                    /* Missing shelter must not hide the buoy itself. */
                }
                return points;
            })
            .catch((error) => {
                official = null;
                throw error;
            });
    return official;
}

export async function loadReferenceTile(tile: ReferenceTile, signal: AbortSignal): Promise<ReferenceResult> {
    await restore();
    signal.throwIfAborted();
    const previous = cache.get(tile.key);
    if (previous && Date.now() - previous.at < FRESH_MS) return { points: previous.points, stale: false };
    try {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Offline');
        for (const endpoint of [
            'https://overpass-api.de/api/interpreter',
            'https://overpass.kumi.systems/api/interpreter',
        ]) {
            try {
                const res = await fetch(`${endpoint}?data=${encodeURIComponent(referenceQuery(tile))}`, {
                    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
                });
                if (!res.ok) throw new Error(`Reference request failed (${res.status})`);
                const at = Date.now();
                const points = parseOsmReferences(await res.json(), new Date(at).toISOString());
                signal.throwIfAborted();
                await remember(tile.key, { at, points });
                return { points, stale: false };
            } catch {
                signal.throwIfAborted();
            }
        }
        throw new Error('Worldwide reference providers unavailable');
    } catch (error) {
        signal.throwIfAborted();
        if (previous) return { points: previous.points, stale: true };
        throw error;
    }
}
