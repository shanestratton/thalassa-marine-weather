import { Preferences } from '@capacitor/preferences';
import { validFetchTable } from './placeConditions';
import {
    namedPlacesQuery,
    parseNamedPlaces,
    parseOsmReferences,
    parseQpwsReferences,
    referenceQuery,
    validCachedReference,
    validNamedPlace,
    type CruisingPoint,
    type NamedPlace,
    type ReferenceTile,
} from './cruisingReference';

const FRESH_MS = 24 * 60 * 60_000;
interface CachedTile<P> {
    at: number;
    points: P[];
}
export interface ReferenceResult {
    points: CruisingPoint[];
    stale: boolean;
}
export interface NamedPlacesResult {
    points: NamedPlace[];
    stale: boolean;
}

/** One coarse cell per row, the oldest dropped first, kept on the phone for offline reads. */
function tileStore<P>(key: string, maxTiles: number, maxPoints: number, valid: (p: unknown) => p is P) {
    const cache = new Map<string, CachedTile<P>>();
    // Read once, and every cell asked meanwhile waits for it (131-PYD-10): four cells asked at once
    // must not each miss the phone's copy and ask Overpass again.
    let restored: Promise<void> | null = null;
    return {
        cache,
        restore(): Promise<void> {
            restored ??= (async () => {
                try {
                    const { value } = await Preferences.get({ key });
                    const rows: [string, CachedTile<P>][] = value ? JSON.parse(value) : [];
                    let count = 0;
                    for (const [tileKey, row] of rows.slice(-maxTiles)) {
                        if (
                            !row ||
                            !Number.isFinite(row.at) ||
                            row.at > Date.now() + 300_000 ||
                            !Array.isArray(row.points) ||
                            !row.points.every(valid) ||
                            (count += row.points.length) > maxPoints
                        )
                            continue;
                        cache.set(tileKey, row);
                    }
                } catch {
                    /* Cache unavailable; network can still provide references. */
                }
            })();
            return restored;
        },
        async remember(tileKey: string, row: CachedTile<P>): Promise<void> {
            cache.delete(tileKey);
            cache.set(tileKey, row);
            let count = [...cache.values()].reduce((n, r) => n + r.points.length, 0);
            while (cache.size > maxTiles || count > maxPoints) {
                const first = cache.keys().next().value!;
                count -= cache.get(first)!.points.length;
                cache.delete(first);
            }
            try {
                await Preferences.set({ key, value: JSON.stringify([...cache]) });
            } catch {
                /* Optional offline copy. */
            }
        },
    };
}

const references = tileStore('thalassa_cruising_reference_v1', 24, 6000, validCachedReference);
let official: Promise<CruisingPoint[]> | null = null;

/** The public Overpass mirrors, in turn; a cut-short or malformed answer fails over like an error. */
async function askOverpass<T>(query: string, signal: AbortSignal, parse: (body: unknown) => T): Promise<T> {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Offline');
    for (const endpoint of [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
    ]) {
        try {
            const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
            });
            if (!res.ok) throw new Error(`Reference request failed (${res.status})`);
            const parsed = parse(await res.json());
            signal.throwIfAborted();
            return parsed;
        } catch {
            signal.throwIfAborted();
        }
    }
    throw new Error('Worldwide reference providers unavailable');
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

export async function loadReferenceTile(
    tile: ReferenceTile,
    signal: AbortSignal,
    options: { requireRestrictionMetadata?: boolean } = {},
): Promise<ReferenceResult> {
    await references.restore();
    signal.throwIfAborted();
    const previous = references.cache.get(tile.key);
    if (
        previous &&
        Date.now() - previous.at < FRESH_MS &&
        (!options.requireRestrictionMetadata || previous.points.every((point) => Array.isArray(point.restrictionNotes)))
    )
        return { points: previous.points, stale: false };
    try {
        let at = 0;
        const points = await askOverpass(referenceQuery(tile), signal, (body) => {
            at = Date.now();
            return parseOsmReferences(body, new Date(at).toISOString());
        });
        await references.remember(tile.key, { at, points });
        return { points, stale: false };
    } catch (error) {
        signal.throwIfAborted();
        if (previous) return { points: previous.points, stale: true };
        throw error;
    }
}

// ── Named places (131-PYD-10) ──────────────────────────────────

/** Bays and towns stay put: a cell is asked again after 30 days, and its old copy serves if that fails. */
export const NAMED_PLACES_FRESH_MS = 30 * 24 * 60 * 60_000;
/**
 * Public Overpass is shared, and its policy asks for light use: this phone asks
 * for at most this many cells of names in any 24 hours (a plan asks for up to
 * four), until our own OSM extract on the weather server replaces it (142-07).
 */
export const NAMED_PLACES_ASKS_PER_DAY = 12;
const ASKS_KEY = 'thalassa_named_places_asks_v1';
const names = tileStore('thalassa_named_places_v1', 12, 12_000, validNamedPlace);
let asks: number[] = [];
let asksRead: Promise<void> | null = null;

/** One ask from today's allowance, or false when it is spent. Read once; four cells at once count four. */
async function takeAsk(now: number): Promise<boolean> {
    asksRead ??= Preferences.get({ key: ASKS_KEY })
        .then(({ value }) => {
            const stored: unknown = value ? JSON.parse(value) : [];
            if (Array.isArray(stored)) asks = stored.filter((t): t is number => Number.isFinite(t));
        })
        .catch(() => {
            /* No record on the phone: the allowance starts afresh. */
        });
    await asksRead;
    asks = asks.filter((t) => now - t < 24 * 60 * 60_000 && t <= now + 300_000);
    if (asks.length >= NAMED_PLACES_ASKS_PER_DAY) return false;
    asks.push(now);
    try {
        await Preferences.set({ key: ASKS_KEY, value: JSON.stringify(asks) });
    } catch {
        /* The allowance still holds for this session. */
    }
    return true;
}

/** A cell's named bays, marinas and settlements: cached per cell, capped per phone. */
export async function loadNamedPlaces(tile: ReferenceTile, signal: AbortSignal): Promise<NamedPlacesResult> {
    await names.restore();
    signal.throwIfAborted();
    const previous = names.cache.get(tile.key);
    if (previous && Date.now() - previous.at < NAMED_PLACES_FRESH_MS) return { points: previous.points, stale: false };
    try {
        if (!(await takeAsk(Date.now()))) throw new Error("Today's allowance of place names is used up");
        signal.throwIfAborted();
        const points = await askOverpass(namedPlacesQuery(tile), signal, parseNamedPlaces);
        await names.remember(tile.key, { at: Date.now(), points });
        return { points, stale: false };
    } catch (error) {
        signal.throwIfAborted();
        if (previous) return { points: previous.points, stale: true };
        throw error;
    }
}
