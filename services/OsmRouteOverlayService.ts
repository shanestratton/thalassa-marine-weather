/**
 * OSM route-overlay client.
 *
 * iOS-side fetcher for OSM features needed by the inshore router. The Pi
 * runs the actual Overpass query + cache; we just pull the assembled
 * GeoJSON via HTTP. Results are also cached locally (memory + the offline
 * water pack on the Capacitor Filesystem) so routes reuse them without
 * round-tripping the Pi — and route with no signal at all.
 *
 * Used by InshoreRouter — when assembling the layer set for a route
 * bbox, after pulling chart cells we also fetch the OSM overlay and
 * merge water polygons (→ supplement DEPARE), reef polygons
 * (→ supplement OBSTRN), and breakwaters (→ supplement LNDARE). That
 * fills the structural gaps in S-57 ENC data: rivers inside coastal
 * landmass polygons, marina exit channels, reef extents.
 *
 * The ladder (Phase 2b, 2026-10-01; tests/OsmRouteOverlayLadder.test.ts):
 *   0. memory — a complete answer 30 min; a pack, stale or empty one 2 min;
 *   1. the Pi, when reachable. A 2b Pi says how fresh its answer is
 *      (X-Osm-Overlay: fresh | cache | stale, X-Osm-Fetched-At) and answers
 *      503 when it has nothing. A pre-2b Pi answers a failure with an EMPTY
 *      200 — that is a failure here, never remembered or saved (it used to
 *      overwrite the last good copy). Its stale copy is held while the cloud
 *      is asked. Any other non-2xx, a throw or bad JSON goes on down the
 *      ladder (it used to answer empty at once);
 *   2. the cloud edge function (signed in), bounded at 45 s;
 *   3. offline: the Pi's stale copy unless the pack covers the whole bbox,
 *      else the pack (services/waterPack), else empty — never a mix of the two.
 * Every online answer fills the pack: verified sources (a 2b Pi fresh or
 * cached, the cloud) may replace its tiles, the rest fill only tiles it lacks.
 * Each answer carries `provenance`, so a route can say where its canal water
 * came from (services/waterPack/waterPackWords).
 *
 * Fix-up (2026-10-02):
 *   - the Pi and the cloud are asked on the 0.05° tile grid round the bbox
 *     (tileAlignedFetchBbox), so every tile the route touches is saved whole
 *     and the same bbox reads back from the pack in full; the router still
 *     gets the features that meet its own bbox (overlayWithin);
 *   - the Pi is asked for its stale copy with &stale=1 — a 2b Pi serves one
 *     only to a phone that says it reads X-Osm-Overlay;
 *   - a payload lacking any of the nine classes is used but never saved:
 *     "no berths key" is not "no berths here";
 *   - the cloud's answer may be its week-old cache with no date, so it is
 *     dated a week back (as is a pre-2b Pi's): it never displaces a fresher
 *     tile, and a caveat never understates the water's age;
 *   - a cloud that could not be reached (network error, timeout) is not
 *     asked again for two minutes, and gets 10 s, not 45, when the Pi has
 *     just said it has no internet — every tracer window and Auto review
 *     cluster used to pay the full wait again;
 *   - the answer says whether the phone was offline, so a refusal's advice
 *     fits ("route once you're online" only when it isn't).
 */

import type { FeatureCollection } from 'geojson';

import { pinnedPiRequest } from './PiPairingService';
import { piCache } from './PiCacheService';
import { createLogger } from '../utils/createLogger';
import { pruneMap } from '../utils/boundedMap';
import { withTimeout } from '../utils/deadline';
import { getWaterPackStore, type WaterPackFillOptions } from './waterPack/WaterPackStore';
import {
    OVERLAY_CLASSES,
    WATER_PACK_TILES_PER_DEG,
    assembleFromTiles,
    overlayIsAllEmpty,
    overlayWithin,
    tileAlignedFetchBbox,
    tileKeyFor,
    tileKeysForBbox,
    type Bbox,
    type PackCoverage,
} from './waterPack/waterPackTiles';

const log = createLogger('OsmRouteOverlay');

const MEM_CACHE_TTL_MS = 30 * 60 * 1000; // 30 min in-process
/** A pack, stale or empty answer is held only briefly: the next route should
 *  try the network again soon. */
const MEM_CACHE_OFFLINE_TTL_MS = 2 * 60 * 1000;
// A COLD Overpass fetch over a whole passage bbox (Mooloolaba→Newport =
// ~990 pier/berth ways) measured 13 s Pi-side — 8 s silently timed out and
// served the stale disk copy WITHOUT berths, so the marina-carve had nothing
// to carve (Shane 2026-07-06 "that change did not land"). 20 s clears it. This
// only ever blocks that long when the Pi is REACHABLE but computing a cold
// query — `piCache.isAvailable()` short-circuits an out-of-range Pi straight
// to the next rung below, so a Pi that's gone still fails fast. Once the
// Pi caches the tile (7-day TTL) the fetch is <1 s again.
const FETCH_TIMEOUT_MS = 20_000;
/** The cloud call: a dead link must not hold the ladder to the router's 85 s
 *  watchdog, and 45 s still covers the function's two 20 s Overpass tries. */
const CLOUD_TIMEOUT_MS = 45_000;
/** …but only 10 s when the Pi has just said it has no internet (a 503, its
 *  stale copy, or a pre-2b Pi's empty 200): the boat's link is likely down,
 *  and the cloud's own cache still answers inside that (2026-10-02). */
const CLOUD_TIMEOUT_PI_OFFLINE_MS = 10_000;
/** A cloud that could not be reached is not asked again for this long. */
const CLOUD_RETRY_AFTER_MS = 2 * 60 * 1000;
/** The cloud serves its osm_overlay_cache copy for up to 7 days and sends no
 *  date (osm-overlay CACHE_TTL_MS); the pre-2b Pi's cache is the same age.
 *  Their answers are dated this far back until they say when. */
const UNDATED_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** A Pi date before this is a clock that was never set. */
const PLAUSIBLE_SINCE_MS = Date.UTC(2020, 0, 1);

/** Where an overlay came from. */
export type OsmOverlaySource = 'pi' | 'cloud' | 'pi-legacy' | 'pi-stale' | 'pack' | 'none';

export interface OsmOverlayProvenance {
    source: OsmOverlaySource;
    /** How much of the bbox it covers: online answers and the Pi's stale copy
     *  are whole; the pack may hold only some of the bbox's tiles. */
    coverage: PackCoverage;
    /** When the data came from OSM (epoch ms): the Pi's or the cloud's fetch,
     *  or the oldest saved pack tile with features. Absent when unknown. */
    dataAsOf?: number;
    /** pack / none: the pack tiles the bbox found saved. */
    presentTiles?: string[];
    /** pack: the extents of canal, marina or lead water left out because a
     *  tile it reaches isn't saved (2026-10-02). */
    unsavedWater?: Bbox[];
    /** The phone was offline (navigator.onLine false) when this was asked. */
    offline?: true;
}

export interface OsmRouteOverlay {
    water: FeatureCollection;
    reef: FeatureCollection;
    coastline: FeatureCollection;
    marina: FeatureCollection;
    breakwater: FeatureCollection;
    /** aeroway=aerodrome/runway/taxiway/apron polygons from OSM. Injected
     *  into LNDARE in InshoreRouter to block reclaimed-land airport
     *  peninsulas (Brisbane Airport's eastern runway is the canonical
     *  case — chart LNDARE doesn't cover the post-2020 reclamation, so
     *  A* threaded a straight diagonal across the runway).
     *  Added 2026-05-19. Pi side must be on cache schema v2 or newer for
     *  this field to be populated; older Pi versions return [] which is
     *  fine (router falls through to chart-only for the airport area). */
    aeroway: FeatureCollection;
    /** waterway=canal/fairway/dock LineStrings from OSM — navigable
     *  dredged-channel centrelines (marina exit channels, port approach
     *  cuts). Bresenham-rasterised into a 1-cell navigable corridor by
     *  the engine so canal estates connect to open water across chart
     *  LNDARE that tessellates the channel banks as land at 50 m.
     *  Added 2026-05-20 for the Newport Marina exit. Pi must be on cache
     *  schema v3+; older Pi returns [] → router degrades to chart-only,
     *  the canal estate stays islanded (origin snap stays large). */
    canalLines: FeatureCollection;
    /** seamark=navigation_line LineStrings (charted leading/transit lines,
     *  clearing lines excluded Pi-side). The dredged-channel centreline a
     *  vessel steers along. Rasterised by InshoreRouter into a preferred
     *  channel corridor (+ shallow-cell rescue) so A* rides the real
     *  channel through bars/approaches the coarse bathymetry reads as too
     *  shallow — the Brisbane River mouth bar is the canonical case.
     *  Added 2026-05-20. Pi must be on cache schema v4+; older Pi returns
     *  [] → router degrades to chart-only (route reverts to cutting the
     *  red CAUTION diagonal across the bar, which is at least honest). */
    navLines: FeatureCollection;
    /** man_made=pier/pontoon + floating=yes — marina finger pontoons /
     *  berth rows. Injected into the engine as layers.BERTH and hard-blocked
     *  at FINE resolution only, overriding the marina-authoritative water, so
     *  the marina leg rides the fairway lanes between berth rows instead of
     *  cutting across the pens (Mooloolaba 2026-07-05). Pi must be on cache
     *  schema v5+; older Pi returns [] → router keeps today's basin-centre
     *  line (no regression). */
    berths: FeatureCollection;
    /** Where this overlay came from (Phase 2b, 2026-10-01): a route says so
     *  when its canal water came from the phone's saved pack or the Pi's
     *  stale copy, or was missing. Optional: mocks and old callers omit it,
     *  and code that walks the overlay's classes names them (never
     *  Object.keys). */
    provenance?: OsmOverlayProvenance;
}

function emptyOverlay(): OsmRouteOverlay {
    return {
        water: { type: 'FeatureCollection', features: [] },
        reef: { type: 'FeatureCollection', features: [] },
        coastline: { type: 'FeatureCollection', features: [] },
        marina: { type: 'FeatureCollection', features: [] },
        breakwater: { type: 'FeatureCollection', features: [] },
        aeroway: { type: 'FeatureCollection', features: [] },
        canalLines: { type: 'FeatureCollection', features: [] },
        navLines: { type: 'FeatureCollection', features: [] },
        berths: { type: 'FeatureCollection', features: [] },
    };
}

interface MemCacheEntry {
    ts: number;
    ttlMs: number;
    data: OsmRouteOverlay;
}
const memCache = new Map<string, MemCacheEntry>();
/** Cap ~6 bboxes: each entry is a multi-MB Overpass FeatureCollection set,
 *  and every distinct route area used to pin one for the whole session.
 *  6, not 4: a multi-leg trip grades ~5 windows per pass, and a cap below
 *  the window count made every grading pass refetch the cloud overlay. */
const MEM_CACHE_MAX = 6;
function rememberOverlay(key: string, data: OsmRouteOverlay, ttlMs = MEM_CACHE_TTL_MS): void {
    memCache.set(key, { ts: Date.now(), ttlMs, data });
    pruneMap(memCache, MEM_CACHE_MAX, (entry) => Date.now() - entry.ts >= entry.ttlMs);
}

function bboxKey(bbox: [number, number, number, number]): string {
    const r = (n: number): string => (Math.round(n * 100) / 100).toFixed(2);
    return `${r(bbox[0])}_${r(bbox[1])}_${r(bbox[2])}_${r(bbox[3])}`;
}

/** A shallow copy carrying its provenance, so a remembered object is never
 *  re-labelled by a later answer. */
function withProvenance(overlay: OsmRouteOverlay, provenance: OsmOverlayProvenance): OsmRouteOverlay {
    const out = { provenance } as OsmRouteOverlay;
    for (const k of OVERLAY_CLASSES) out[k] = overlay[k];
    return out;
}

/**
 * An overlay payload with every class present (older Pis lack the newer
 * classes, which the router treats as "none mapped"); null when the payload
 * is not an overlay at all. `complete` when it carried all nine: only then
 * may it be saved, since a class it lacks is "not asked", never "none here"
 * (2026-10-02).
 */
function overlayFromPayload(value: unknown): { overlay: OsmRouteOverlay; complete: boolean } | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const raw = value as Record<string, { features?: unknown } | undefined>;
    const out = emptyOverlay();
    let complete = true;
    for (const k of OVERLAY_CLASSES) {
        const fc = raw[k];
        if (fc === undefined) {
            complete = false;
            continue;
        }
        if (!fc || typeof fc !== 'object' || !Array.isArray(fc.features)) return null;
        out[k] = fc as FeatureCollection;
    }
    return { overlay: out, complete };
}

const overlayCounts = (data: OsmRouteOverlay): string =>
    `water=${data.water.features.length} reef=${data.reef.features.length} coast=${data.coastline.features.length} marina=${data.marina.features.length} bw=${data.breakwater.features.length} aeroway=${data.aeroway.features.length} canalLines=${data.canalLines.features.length} navLines=${data.navLines.features.length} berths=${data.berths.features.length}`;

/** The route's ends sit 0.1° in from a router bbox's corners: write the
 *  pack tiles nearest them first when a fill is capped. */
const bboxFocus = ([w, s, e, n]: Bbox): { lat: number; lon: number }[] => {
    const inset = Math.min(0.1, (e - w) / 2, (n - s) / 2);
    return [
        { lon: w + inset, lat: s + inset },
        { lon: e - inset, lat: n - inset },
        { lon: w + inset, lat: n - inset },
        { lon: e - inset, lat: s + inset },
    ];
};

/** Fire-and-forget: the pack's queue owns the writes, and never throws. */
function fillPack(overlay: OsmRouteOverlay, bbox: Bbox, opts: WaterPackFillOptions): void {
    try {
        void getWaterPackStore().fillFromOverlay(overlay, bbox, { focus: bboxFocus(bbox), ...opts });
    } catch (err) {
        log.warn(`water pack fill failed: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// ── The Pi ───────────────────────────────────────────────────────────

type PiOutcome =
    | {
          kind: 'complete';
          overlay: OsmRouteOverlay;
          source: 'pi' | 'pi-legacy';
          verified: boolean;
          fetchedAt: number;
          /** All nine classes came: it may be saved. */
          complete: boolean;
      }
    | { kind: 'stale'; overlay: OsmRouteOverlay; fetchedAt?: number; complete: boolean }
    /** noInternet: the Pi said so (a 503, or a pre-2b Pi's empty 200). */
    | { kind: 'failed'; noInternet: boolean };

/** A response header, whatever case the native bridge hands it in. */
function header(headers: Record<string, string> | undefined, name: string): string | undefined {
    if (!headers) return undefined;
    const want = name.toLowerCase();
    for (const [k, v] of Object.entries(headers)) if (k.toLowerCase() === want) return String(v);
    return undefined;
}

/** The Pi's fetch date: no later than now, and not before 2020 (a Pi whose
 *  clock was never set) — else unknown. */
function plausibleDate(value: string | undefined): number | undefined {
    const t = value ? Date.parse(value) : NaN;
    if (!Number.isFinite(t) || t < PLAUSIBLE_SINCE_MS) return undefined;
    return Math.min(t, Date.now());
}

/** Never throws: 'failed' when the Pi gave nothing usable. */
async function fetchOverlayFromPi(bbox: Bbox): Promise<PiOutcome> {
    // &stale=1: this phone reads X-Osm-Overlay, so a 2b Pi may serve its
    // stale copy (it gives one to no other phone, 2026-10-02). A pre-2b Pi
    // ignores the parameter.
    const url = `${piCache.baseUrl}/api/osm/overlay?bbox=${bbox.join(',')}&stale=1`;
    const t0 = Date.now();
    try {
        // Pinned transport: plain fetch cannot complete the Pi's self-signed
        // handshake, so this used to fail silently and fall back to an empty
        // overlay on every call.
        const res = await pinnedPiRequest({ url, readTimeout: FETCH_TIMEOUT_MS, responseType: 'text' });
        if (res.status < 200 || res.status >= 300) {
            // 503 OSM_OVERLAY_UNAVAILABLE from a 2b Pi: no internet there and
            // nothing saved. Bug 2b: this used to end the ladder with empty.
            log.warn(`OSM overlay HTTP ${res.status} from the Pi — trying the cloud, then the pack`);
            return { kind: 'failed', noInternet: res.status === 503 };
        }
        const parsed = overlayFromPayload(JSON.parse(res.data));
        if (!parsed) {
            log.warn('OSM overlay from the Pi is not an overlay — trying the cloud, then the pack');
            return { kind: 'failed', noInternet: false };
        }
        const { overlay, complete } = parsed;
        const state = header(res.headers, 'X-Osm-Overlay');
        const fetchedAt = plausibleDate(header(res.headers, 'X-Osm-Fetched-At'));
        log.warn(`OSM overlay from the Pi in ${Date.now() - t0}ms (${state ?? 'pre-2b'}) — ${overlayCounts(overlay)}`);
        if (state === 'fresh' || state === 'cache') {
            // A date the phone cannot believe makes the copy unverified, and
            // as old as the Pi's cache may be.
            return {
                kind: 'complete',
                overlay,
                source: 'pi',
                verified: fetchedAt !== undefined,
                fetchedAt: fetchedAt ?? Date.now() - UNDATED_CACHE_MAX_AGE_MS,
                complete,
            };
        }
        if (state === 'stale') {
            // Bug 2's shape is never the boat's copy of the water.
            return overlayIsAllEmpty(overlay)
                ? { kind: 'failed', noInternet: true }
                : { kind: 'stale', overlay, fetchedAt, complete };
        }
        if (state === undefined) {
            // A pre-2b Pi (f4483b5f) answers a failed Overpass call with an
            // empty 200 — bug 2. Empty is its failure; anything else is real
            // data from its week-long cache, of unknown age: used, dated a
            // week back, and never trusted over the pack.
            if (overlayIsAllEmpty(overlay)) {
                log.warn('pre-2b Pi answered an empty overlay — its failure shape: not remembered, not saved');
                return { kind: 'failed', noInternet: true };
            }
            return {
                kind: 'complete',
                overlay,
                source: 'pi-legacy',
                verified: false,
                fetchedAt: Date.now() - UNDATED_CACHE_MAX_AGE_MS,
                complete,
            };
        }
        log.warn(`OSM overlay state "${state}" from the Pi is unknown — not used`);
        return { kind: 'failed', noInternet: false };
    } catch (err) {
        log.warn(
            `OSM overlay fetch from the Pi failed (${Date.now() - t0}ms): ${err instanceof Error ? err.message : String(err)}`,
        );
        return { kind: 'failed', noInternet: false };
    }
}

const isOffline = (): boolean => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Until when the cloud is not asked: it could not be reached just now. */
let cloudUnreachableUntil = 0;
const TIMED_OUT = Symbol('timed out');

/** The cloud rung, bounded; null when it gave nothing. */
async function cloudOverlay(
    bbox: Bbox,
    piSaysNoInternet = false,
): Promise<{ overlay: OsmRouteOverlay; complete: boolean } | null> {
    if (isOffline()) return null;
    if (Date.now() < cloudUnreachableUntil) {
        log.warn('cloud overlay skipped — it could not be reached in the last two minutes');
        return null;
    }
    const res = await withTimeout<CloudOutcome | typeof TIMED_OUT>(
        fetchOverlayFromCloud(bbox),
        TIMED_OUT,
        piSaysNoInternet ? CLOUD_TIMEOUT_PI_OFFLINE_MS : CLOUD_TIMEOUT_MS,
    );
    if (res === TIMED_OUT || ('unreachable' in res && res.unreachable)) {
        log.warn(`cloud overlay ${res === TIMED_OUT ? 'timed out' : 'unreachable'} — not asked again for two minutes`);
        cloudUnreachableUntil = Date.now() + CLOUD_RETRY_AFTER_MS;
        return null;
    }
    return 'overlay' in res ? res : null;
}

// ── The offline water pack ───────────────────────────────────────────

async function overlayFromPack(bbox: Bbox): Promise<{
    overlay: OsmRouteOverlay;
    coverage: PackCoverage;
    presentKeys: string[];
    unsavedWater: Bbox[];
    dataAsOf?: number;
} | null> {
    try {
        const { tiles, entries } = await getWaterPackStore().readTiles(tileKeysForBbox(bbox));
        // Each tile's OSM date, empty tiles included: a newer tile without a
        // water feature has superseded an older neighbour's copy (2026-10-02).
        const fetchedAt = new Map([...entries].map(([k, e]) => [k, e.fetchedAt]));
        const { overlay, coverage, presentKeys, unsavedWater } = assembleFromTiles(tiles, bbox, fetchedAt);
        // The date a caveat names: the oldest tile with features it used
        // (an old empty sea tile says nothing about the marina).
        let withFeatures: number | undefined;
        let any: number | undefined;
        for (const key of presentKeys) {
            const e = entries.get(key);
            if (!e) continue;
            any = any === undefined ? e.fetchedAt : Math.min(any, e.fetchedAt);
            if (e.bytes > 0)
                withFeatures = withFeatures === undefined ? e.fetchedAt : Math.min(withFeatures, e.fetchedAt);
        }
        const dataAsOf = withFeatures ?? any;
        return { overlay, coverage, presentKeys, unsavedWater, ...(dataAsOf !== undefined ? { dataAsOf } : {}) };
    } catch (err) {
        log.warn(`water pack read failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/**
 * Fetch the OSM route overlay for a bbox. Never throws: with nothing online
 * and nothing saved it returns an empty overlay (source 'none') — the router
 * falls back cleanly to chart-only data, and the route says why.
 *
 * @param bbox [W, S, E, N] in degrees
 */
export async function getOsmRouteOverlay(bbox: [number, number, number, number]): Promise<OsmRouteOverlay> {
    const key = bboxKey(bbox);
    const cached = memCache.get(key);
    if (cached && Date.now() - cached.ts < cached.ttlMs) {
        log.info(`mem-cache hit for bbox ${key}`);
        return cached.data;
    }
    const offline = isOffline() ? { offline: true as const } : {};
    // Asked on the tile grid, so every tile this bbox touches is saved whole;
    // the router gets the features that meet its own bbox — the same set the
    // pack gives back for it later (2026-10-02).
    const fetchBbox = tileAlignedFetchBbox(bbox);

    // 1. The Pi.
    let piStale: Extract<PiOutcome, { kind: 'stale' }> | null = null;
    let piSaysNoInternet = false;
    if (piCache.isAvailable()) {
        const pi = await fetchOverlayFromPi(fetchBbox);
        if (pi.kind === 'complete') {
            if (pi.complete)
                fillPack(pi.overlay, fetchBbox, { source: pi.source, verified: pi.verified, fetchedAt: pi.fetchedAt });
            const out = withProvenance(overlayWithin(pi.overlay, bbox), {
                source: pi.source,
                coverage: 'full',
                ...(pi.verified ? { dataAsOf: pi.fetchedAt } : {}),
            });
            rememberOverlay(key, out);
            return out;
        }
        if (pi.kind === 'stale') {
            piStale = pi;
            piSaysNoInternet = true;
        } else piSaysNoInternet = pi.noInternet;
    }

    // 2. The cloud (edge function; powers the desktop builder where the Pi
    // is unreachable by definition).
    const cloud = await cloudOverlay(fetchBbox, piSaysNoInternet);
    if (cloud) {
        log.warn(`CLOUD overlay for bbox ${key} — ${overlayCounts(cloud.overlay)}`);
        const fetchedAt = Date.now() - UNDATED_CACHE_MAX_AGE_MS;
        if (cloud.complete) fillPack(cloud.overlay, fetchBbox, { source: 'cloud', verified: true, fetchedAt });
        const out = withProvenance(overlayWithin(cloud.overlay, bbox), {
            source: 'cloud',
            coverage: 'full',
            dataAsOf: fetchedAt,
        });
        rememberOverlay(key, out);
        return out;
    }

    // 3. Offline: what the boat or the phone saved. A months-old OSM canal
    // polygon beats "the marina is land" — and the route says how old.
    const pack = await overlayFromPack(bbox);
    if (piStale && pack?.coverage !== 'full') {
        // The Pi's copy is a whole snapshot of this bbox; a partial pack is
        // not. Never mixed. It fills only the tiles the pack lacks.
        if (piStale.fetchedAt !== undefined && piStale.complete)
            fillPack(piStale.overlay, fetchBbox, { source: 'pi-stale', verified: false, fetchedAt: piStale.fetchedAt });
        log.warn(`Pi STALE overlay for bbox ${key}`);
        const out = withProvenance(overlayWithin(piStale.overlay, bbox), {
            source: 'pi-stale',
            coverage: 'full',
            ...(piStale.fetchedAt !== undefined ? { dataAsOf: piStale.fetchedAt } : {}),
        });
        rememberOverlay(key, out, MEM_CACHE_OFFLINE_TTL_MS);
        return out;
    }
    if (pack && pack.presentKeys.length > 0) {
        log.warn(
            `water PACK overlay for bbox ${key} (${pack.coverage}, ${pack.presentKeys.length} tiles) — ${overlayCounts(pack.overlay)}`,
        );
        const out = withProvenance(pack.overlay, {
            source: 'pack',
            coverage: pack.coverage,
            ...(pack.dataAsOf !== undefined ? { dataAsOf: pack.dataAsOf } : {}),
            presentTiles: pack.presentKeys,
            ...(pack.unsavedWater.length > 0 ? { unsavedWater: pack.unsavedWater } : {}),
            ...offline,
        });
        rememberOverlay(key, out, MEM_CACHE_OFFLINE_TTL_MS);
        return out;
    }
    log.warn('no Pi, cloud or saved water for this bbox — OSM overlay empty (router will fall back to chart-only)');
    const out = withProvenance(emptyOverlay(), { source: 'none', coverage: 'none', presentTiles: [], ...offline });
    rememberOverlay(key, out, MEM_CACHE_OFFLINE_TTL_MS);
    return out;
}

// ── Prefetch: the ends of a settled trace ───────────────────────────

/** Tiles fetched within this long are not fetched again by the prefetch. */
const PREFETCH_FRESH_MS = 30 * 24 * 60 * 60 * 1000;
/** An area answered within this long is not asked again — an all-empty
 *  answer saves nothing, so the pack alone would not remember it. */
const PREFETCH_ASKED_MS = 6 * 60 * 60 * 1000;
let prefetching: Promise<void> | null = null;
/** Area (its centre tile) → when an online answer for it last came. */
const prefetchAsked = new Map<string, number>();

/** The aligned 3×3 tiles (0.15°) round a point, and the bbox that fetches
 *  them whole: ±0.01°, so the fill's margin still yields all nine. Always
 *  ≥0.17° wide, so it can never fall inside the cloud's 0.055°-wide curated
 *  Newport box (which answers 503 once its seed is a week old). */
function prefetchArea(p: { lat: number; lon: number }): { keys: string[]; bbox: Bbox } {
    const [x, y] = tileKeyFor(p).split('_').map(Number);
    const keys: string[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) keys.push(`${x + dx}_${y + dy}`);
    const r = (v: number): number => Number(v.toFixed(6));
    const n = WATER_PACK_TILES_PER_DEG;
    return {
        keys,
        bbox: [r((x - 1) / n - 0.01), r((y - 1) / n - 0.01), r((x + 2) / n + 0.01), r((y + 2) / n + 0.01)],
    };
}

/**
 * Save the harbour water round the first and last pins of a settled trace
 * to the offline pack, so the passage can be routed again with no signal
 * (Phase 2b, 2026-10-01). Background and best effort: nothing in Satellite
 * Mode or offline, one run at a time, at most two areas, and an area whose
 * nine tiles were all saved in the last 30 days is not fetched again.
 */
export function prefetchWaterPack(
    points: ReadonlyArray<{ lat: number; lon: number } | null | undefined>,
): Promise<void> {
    if (prefetching) return prefetching;
    prefetching = runPrefetch(points)
        .catch((err) => log.warn(`water pack prefetch failed: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => {
            prefetching = null;
        });
    return prefetching;
}

async function runPrefetch(points: ReadonlyArray<{ lat: number; lon: number } | null | undefined>): Promise<void> {
    const { satelliteModeBlocks } = await import('./networkPolicy');
    if (satelliteModeBlocks('offline-download') || isOffline()) return;
    const valid = (p: { lat: number; lon: number } | null | undefined): p is { lat: number; lon: number } =>
        !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85 && Math.abs(p.lon) <= 180;
    const ends = [points[0], points[points.length - 1]].filter(valid);
    const areas = new Map<string, { keys: string[]; bbox: Bbox; focus: { lat: number; lon: number } }>();
    for (const p of ends) {
        const area = prefetchArea(p);
        if (!areas.has(area.keys[4]) && areas.size < 2) areas.set(area.keys[4], { ...area, focus: p });
    }
    const store = getWaterPackStore();
    for (const [centre, { keys, bbox, focus }] of areas) {
        const entries = await store.entriesFor(keys);
        const now = Date.now();
        // Skipped only when all nine are saved, verified and recent: a tile
        // from a pre-2b Pi or a stale copy may be cut short (2026-10-02).
        if (
            keys.every((k) => {
                const e = entries.get(k);
                return !!e && e.verified && now - e.fetchedAt < PREFETCH_FRESH_MS;
            })
        )
            continue;
        if (now - (prefetchAsked.get(centre) ?? -Infinity) < PREFETCH_ASKED_MS) continue;
        let stale: Extract<PiOutcome, { kind: 'stale' }> | null = null;
        let piSaysNoInternet = false;
        if (piCache.isAvailable()) {
            const pi = await fetchOverlayFromPi(bbox);
            if (pi.kind === 'complete') {
                rememberAsked(centre);
                if (pi.complete)
                    await store.fillFromOverlay(pi.overlay, bbox, {
                        source: pi.source,
                        verified: pi.verified,
                        fetchedAt: pi.fetchedAt,
                        focus: [focus],
                    });
                continue;
            }
            if (pi.kind === 'stale') {
                stale = pi;
                piSaysNoInternet = true;
            } else piSaysNoInternet = pi.noInternet;
        }
        const cloud = await cloudOverlay(bbox, piSaysNoInternet);
        if (cloud) {
            rememberAsked(centre);
            if (cloud.complete)
                await store.fillFromOverlay(cloud.overlay, bbox, {
                    source: 'cloud',
                    verified: true,
                    fetchedAt: Date.now() - UNDATED_CACHE_MAX_AGE_MS,
                    focus: [focus],
                });
        } else if (stale?.fetchedAt !== undefined && stale.complete) {
            await store.fillFromOverlay(stale.overlay, bbox, {
                source: 'pi-stale',
                verified: false,
                fetchedAt: stale.fetchedAt,
                focus: [focus],
            });
        }
    }
}

function rememberAsked(centre: string): void {
    prefetchAsked.set(centre, Date.now());
    pruneMap(prefetchAsked, 50, (at) => Date.now() - at >= PREFETCH_ASKED_MS);
}

/** Test hook: forget remembered overlays, any prefetch in flight, the
 *  areas asked and a cloud marked unreachable. */
export function __resetOsmRouteOverlayForTests(): void {
    memCache.clear();
    prefetching = null;
    prefetchAsked.clear();
    cloudUnreachableUntil = 0;
}

// ── Cloud fallback (osm-overlay edge function, desktop builder) ─────
// Same recipe as the pi-cache (ported verbatim, v5 schema incl. berths),
// cached server-side in osm_overlay_cache. Signed-in only (the function
// verifies the JWT) — a signed-out browser degrades to the pack, then empty.
// On failure the function answers 503 OVERLAY_UPSTREAM_UNAVAILABLE, which
// invoke turns into an error: nothing here, never an empty overlay.

/** An overlay; or nothing, `unreachable` when the call never got there (a
 *  network or relay error) rather than being answered with an error. */
type CloudOutcome = { overlay: OsmRouteOverlay; complete: boolean } | { unreachable: boolean };

const unreachableError = (error: unknown): boolean => {
    const name = (error as { name?: unknown } | null)?.name;
    return name === 'FunctionsFetchError' || name === 'FunctionsRelayError';
};

async function fetchOverlayFromCloud(bbox: [number, number, number, number]): Promise<CloudOutcome> {
    try {
        const { supabase, isSupabaseConfigured } = await import('./supabase');
        if (!isSupabaseConfigured() || !supabase) return { unreachable: false };
        const { data, error } = await supabase.functions.invoke('osm-overlay', {
            body: { bbox: bbox.join(',') },
        });
        if (error) return { unreachable: unreachableError(error) };
        if (!data || typeof data !== 'object') return { unreachable: false };
        const raw = data as Partial<OsmRouteOverlay>;
        if (!raw.water || !Array.isArray(raw.water.features)) return { unreachable: false };
        return overlayFromPayload(raw) ?? { unreachable: false };
    } catch (err) {
        log.warn(`cloud overlay failed: ${err instanceof Error ? err.message : String(err)}`);
        return { unreachable: true };
    }
}
