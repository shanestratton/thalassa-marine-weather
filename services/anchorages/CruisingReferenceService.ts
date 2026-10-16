import { Preferences } from '@capacitor/preferences';
import { satelliteModeActive } from '../networkPolicy';
import { validFetchTable } from './placeConditions';
import {
    CrowdedCellError,
    NAMED_PLACES_CELL_MAX,
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
const offline = () => satelliteModeActive() || (typeof navigator !== 'undefined' && navigator.onLine === false);

/**
 * The public Overpass mirrors, in turn; a cut-short or malformed answer fails over like an error. `reached` is
 * told when a mirror answers, or is still working when the wait runs out (131-PYD-10): only then did the ask
 * reach Overpass. Offline, no signal, or the sheet closed first, it never left the phone.
 */
async function askOverpass<T>(
    query: string,
    signal: AbortSignal,
    parse: (body: unknown) => T,
    reached: () => void = () => {},
    waitMs = 12_000,
): Promise<T> {
    if (offline()) throw new Error('Offline');
    for (const endpoint of [
        'https://overpass-api.de/api/interpreter',
        'https://overpass.kumi.systems/api/interpreter',
    ]) {
        if (offline()) throw new Error('Offline or Satellite Mode');
        try {
            signal.throwIfAborted();
            const res = await fetch(`${endpoint}?data=${encodeURIComponent(query)}`, {
                signal: AbortSignal.any([signal, AbortSignal.timeout(waitMs)]),
            }).catch((error: unknown) => {
                // Not the sheet's signal, so the wait ran out (WebKit may call it an AbortError).
                if (!signal.aborted && /^(?:Timeout|Abort)Error$/.test((error as Error)?.name)) reached();
                throw error;
            });
            reached();
            if (!res.ok) throw new Error(`Reference request failed (${res.status})`);
            const parsed = parse(await res.json());
            signal.throwIfAborted();
            return parsed;
        } catch (error) {
            signal.throwIfAborted();
            // A whole answer with too much in it: the other mirror holds the same map.
            if (error instanceof CrowdedCellError) throw error;
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
        // Own published extract first; no global Overpass dump on the phone.
        // An unpublished catalogue keeps the existing small live-cell fallback.
        try {
            const [{ loadMarineCells }, { areaKey }, { catalogueMoorings }] = await Promise.all([
                import('../marineCatalogue/service'),
                import('../marineCatalogue/schema'),
                import('../marineCatalogue/adapters'),
            ]);
            const published = await loadMarineCells([areaKey(tile.south + 0.5, tile.west + 0.5)], ['osm'], signal);
            const snapshot = published.manifests[0];
            if (snapshot && !published.partial) {
                const points = catalogueMoorings(published.records, snapshot).filter(
                    (p) => p.lat >= tile.south && p.lat <= tile.north && p.lon >= tile.west && p.lon <= tile.east,
                );
                await references.remember(tile.key, { at: Date.now(), points });
                return { points, stale: Date.now() - Date.parse(snapshot.sourceAt) > 45 * 86400000 };
            }
        } catch {
            signal.throwIfAborted(); /* Unpublished/unreachable: retain the existing bounded live query. */
        }
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
 * Only an ask that reached Overpass counts: one that never left the phone
 * (offline, no signal, the sheet closed first) is given back, so a planner
 * opened at sea leaves the day's names for when she is back in signal.
 */
export const NAMED_PLACES_ASKS_PER_DAY = 12;
/** A cell with more bays and marinas than a plan takes is not asked again for as long as a full one is kept. */
export const CROWDED_CELL_MS = NAMED_PLACES_FRESH_MS;
const DAY_MS = 24 * 60 * 60_000;
/** namedPlacesQuery's own [timeout:25]. */
const NAMES_WAIT_MS = 25_000;
const ALLOWANCE_KEY = 'thalassa_named_places_allowance_v1';
// A plan's four cells, each at its caps, always fit: one dense plan never pushes out its own cells.
const names = tileStore('thalassa_named_places_v1', 12, 4 * NAMED_PLACES_CELL_MAX, validNamedPlace);
/** When each ask that reached Overpass went out, and the crowded cells with when they were found so. */
let asks: number[] = [];
const crowded = new Map<string, number>();
/** Asks out now, not yet answered: held against the day's allowance, so four cells at once hold four. */
let out = 0;
let allowanceRead: Promise<void> | null = null;

function readAllowance(): Promise<void> {
    allowanceRead ??= Preferences.get({ key: ALLOWANCE_KEY })
        .then(({ value }) => {
            const stored = value ? JSON.parse(value) : null;
            if (Array.isArray(stored?.asks)) asks = stored.asks.filter((t: unknown) => Number.isFinite(t));
            for (const row of Array.isArray(stored?.crowded) ? stored.crowded : [])
                if (Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[1]))
                    crowded.set(row[0], row[1]);
        })
        .catch(() => {
            /* No record on the phone: the allowance starts afresh. */
        });
    return allowanceRead;
}

async function saveAllowance(): Promise<void> {
    try {
        await Preferences.set({ key: ALLOWANCE_KEY, value: JSON.stringify({ asks, crowded: [...crowded] }) });
    } catch {
        /* The allowance still holds for this session. */
    }
}

/** A cell's named bays, marinas, towns and villages: cached per cell, capped per phone. */
export async function loadNamedPlaces(tile: ReferenceTile, signal: AbortSignal): Promise<NamedPlacesResult> {
    await names.restore();
    signal.throwIfAborted();
    const previous = names.cache.get(tile.key);
    if (previous && Date.now() - previous.at < NAMED_PLACES_FRESH_MS) return { points: previous.points, stale: false };
    try {
        // Offline, nothing is held, asked or spent (131-PYD-10): at sea that is most of the time.
        if (offline()) throw new Error('Offline');
        await readAllowance();
        signal.throwIfAborted();
        const now = Date.now();
        const recent = (at: number, ms: number) => now - at < ms && at <= now + 300_000;
        asks = asks.filter((at) => recent(at, DAY_MS));
        for (const [key, at] of crowded) if (!recent(at, CROWDED_CELL_MS)) crowded.delete(key);
        if (crowded.has(tile.key)) throw new CrowdedCellError();
        if (asks.length + out >= NAMED_PLACES_ASKS_PER_DAY)
            throw new Error("Today's allowance of place names is used up");
        out++;
        let reached = false;
        let points: NamedPlace[];
        try {
            // The phone waits as long as Overpass may work (a cold cell took 13 s), so its answer is not thrown away.
            points = await askOverpass(
                namedPlacesQuery(tile),
                signal,
                parseNamedPlaces,
                () => (reached = true),
                NAMES_WAIT_MS,
            );
        } catch (error) {
            if (error instanceof CrowdedCellError) crowded.set(tile.key, now);
            throw error;
        } finally {
            out--;
            if (reached) {
                asks.push(now);
                await saveAllowance();
            }
        }
        await names.remember(tile.key, { at: Date.now(), points });
        return { points, stale: false };
    } catch (error) {
        signal.throwIfAborted();
        if (previous) return { points: previous.points, stale: true };
        throw error;
    }
}
