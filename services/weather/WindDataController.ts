/**
 * WindDataController — Orchestrates wind data for the WebGL particle engine.
 *
 * Two modes:
 *   1. Global (online): Streams wind data from Open-Meteo commercial API
 *      for the current map viewport. Re-fetches on significant view changes.
 *
 *   2. Local (offline): Loads pre-parsed .wind.bin from device storage.
 *      Data is bounded to the downloaded region; the shader naturally
 *      culls particles outside via Mercator → clip space projection.
 *
 * The controller feeds data to WindStore, which the Custom Layer engine reads.
 */

import { createLogger } from '../../utils/createLogger';
import type mapboxgl from 'mapbox-gl';
import { fetchWindGrid, fetchGlobalWindField, type WindGrid } from './windField';
import { loadLocalWindFile } from './GribWindParser';
import { WindStore } from '../../stores/WindStore';
import { LocationStore } from '../../stores/LocationStore';
import { withDeadline } from '../../utils/deadline';
import { crumb } from '../../utils/flightRecorder';
import { heapTag } from '../../utils/heapGauge';
import { continuousEastForLongitudeRange } from './windLongitude';
import { loadWindGrids, saveWindGrids } from './windGridPersist';
const log = createLogger('WindCtrl');

// ── Bounds Cache (avoid redundant re-fetches) ──
//
// GFS model runs every 6 hours (00Z, 06Z, 12Z, 18Z), so wind data older than
// ~3 hours could be from an outdated model run. We invalidate the cache after
// WIND_GRID_MAX_AGE_MS to force a refresh on the next pan or layer toggle —
// previously the grid stuck around indefinitely while bounds held steady,
// which is what made the chart-page wind look "wrong direction" (actually
// just stale) after the app had been open for hours.
const WIND_GRID_MAX_AGE_MS = 3 * 60 * 60 * 1000;

interface CachedBounds {
    north: number;
    south: number;
    west: number;
    east: number;
    zoom: number;
    fetchedAt: number;
}

let lastFetchedBounds: CachedBounds | null = null;

// ── Multi-resolution grid cache ──
//
// One cached grid per resolution tier (plus a punter-centred 0.25° prefetch).
// Any viewport fully covered by a fresh cached grid publishes instantly from
// memory: zooming home reuses the fine grid, zooming OUT reuses the wide boot
// grid — which is what stops the previous fetch's hard-edged rectangle
// floating over a dark map while a ~600-point wide fetch downloads (Shane
// 2026-08-04 screenshot). The network only runs when no cached grid covers,
// or a covering grid is coarser than the zoom deserves (refined behind it).
const FINE_GRID_RES_DEG = 0.25;
const FINE_GRID_HALF_SPAN_DEG = 2;
/**
 * Synoptic warm — the OTHER end of wind's zoom range.
 *
 * Wind opens local at z9 and pinches out to z3 (LAYER_FRAME_ZOOM /
 * LAYER_MIN_ZOOM). Boot therefore only ever warmed the fine tier, so the first
 * pinch-out fell off the cache and paid a full wide fetch — the exact "hard-
 * edged rectangle over a dark map" this cache exists to prevent (Shane,
 * 2026-08-22: "have the wind load in the background for the zoom 3 level as
 * well as the zoom 9 level").
 *
 * The span is generous on purpose and it is FREE to be. The main path picks
 * `max(tier, maxSpan / 24)`, so resolution scales with span and the point
 * count stays ~24×24 whatever half-span we choose here. A wider warm buys a
 * better chance of covering whatever the punter actually pinches out to, at
 * identical download size — it only costs sharpness, which is meaningless at
 * synoptic scale.
 */
const SYNOPTIC_HALF_SPAN_DEG = 25;
const SYNOPTIC_GRID_RES_DEG = (SYNOPTIC_HALF_SPAN_DEG * 2) / 24;
/** Camera crossing this (with the layer on) starts the fine prefetch. */
const FINE_PREFETCH_MIN_ZOOM = 5;
const CHART_HOURS = 48;
const MAX_CACHED_GRIDS = 4;

/**
 * THE WORLD FLOOR — the tier the punter cannot fall off (Shane 2026-08-24:
 * "when a punter wants to move the world around, it is ready to go").
 *
 * The fine and synoptic warms both anchor on the PUNTER, so a pan to the far
 * side of the world falls off both, the disjoint-view safety below rightly
 * refuses to paint Brisbane's wind over Indonesia, and the punter stares at a
 * blank field while a viewport fetch runs — the "blocky, nineties" feel. A
 * grid whose bounds are the whole world cannot be panned off: bestCoveringGrid
 * finds it for ANY viewport by construction, publishes it instantly, and the
 * ordinary viewport fetch refines behind it exactly as fine-over-synoptic
 * already does. The fix is not fetching faster; it is never having nothing.
 *
 * Two kinds, priced very differently:
 *  · GFS sustained: global mode already downloads the full-earth 1° GRIB —
 *    the floor is the SAME WindGrid object stored under a world key, so it
 *    costs zero extra bytes and simply stops being thrown away on a model
 *    switch. (~19 MB resident incl. u/v/speed Float32s — the identical
 *    working set global mode holds today while painting.)
 *  · Point-batch models (ICON, ECMWF, … and anything serving gust): a 6°
 *    world sweep, ~29×61 = 1,769 points × 24 h ≈ 0.5 MB resident. For scale:
 *    a world-span viewport fetch today resolves max(tier, span/24) = 15°, so
 *    the floor is FINER than what a world pan currently buys, for one fetch
 *    per model per staleness window instead of one per pan.
 *
 * Floors are capped (MAX_WORLD_FLOORS), exempt from LRU eviction like the
 * synoptic warm, never persisted (a multi-MB JSON.stringify on the main
 * thread is exactly what the 512 KB persist entry cap exists to prevent), and
 * refused when stale by bestCoveringGrid like every other entry. They survive
 * layer toggle-off on purpose: staleness deletes data, not the toggle — a
 * punter who flicks wind off and back on 30 s later should not re-download
 * the planet.
 */
const WORLD_FLOOR_RES_DEG = 6;
const WORLD_FLOOR_HOURS = 24;
const MAX_WORLD_FLOORS = 2;
const WORLD_KEY_PREFIX = 'world:';
const WORLD_FLOOR_BOUNDS = { north: 85, south: -85, west: -180, east: 180 } as const;
let worldFloorInflight = false;

function isWorldKey(key: string): boolean {
    return key.startsWith(WORLD_KEY_PREFIX);
}

/**
 * Is this link one we may speculatively spend megabytes on?
 *
 * Mirrors the adaptive-poll heuristic in MapHub (10 s wifi / 60 s cellular):
 * navigator.connection is absent in WKWebView, and there — like MapHub — we
 * assume fast, because a native app on a phone hotspot is indistinguishable
 * from wifi anyway and the floor fetch is one bounded download, not a stream.
 * Cellular and 2g/3g effective types are the honest "metered offshore" signal
 * the browser can actually give us, and on those the floor waits: the punter
 * tiers still warm (they are what the boat actually needs), and a world pan
 * falls back to today's fetch-on-demand behaviour rather than silently
 * spending an Iridium-class link's whole day.
 */
export function isFastLink(): boolean {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const conn = (navigator as any)?.connection;
    if (!conn) return true;
    if (conn.type === 'cellular') return false;
    const ect: string = conn.effectiveType ?? '4g';
    return ect !== '2g' && ect !== 'slow-2g' && ect !== '3g';
}

interface CachedWindGrid {
    /** Raw sustained+gust grid as fetched — field transform applied at publish. */
    grid: WindGrid;
    bounds: { north: number; south: number; west: number; east: number };
    res: number;
    model: ReturnType<typeof WindStore.getState>['model'];
    fetchedAt: number;
}

const windGridCache = new Map<string, CachedWindGrid>();
let fineGridInflight = false;
let synopticGridInflight = false;
/** Identity of the published cache entry, so parked moveends don't re-publish
 *  (every setGrid restarts the particle overlay). */
let lastPublishedCacheKey: string | null = null;

function cacheKeyForRes(res: number): string {
    return res.toFixed(2);
}

function publishKeyFor(res: number, fetchedAt: number, field: string): string {
    return `${cacheKeyForRes(res)}:${fetchedAt}:${field}`;
}

/** Rehydrate-once latch: the disk read happens on the first activate, not at
 *  module scope (tests import this module with storage mocked out, and a
 *  read at import time would run before their mocks are installed). */
let persistRehydrated = false;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Pull the last session's grids back into the memory cache.
 *
 * Freshness is the memory cache's own window, passed in rather than
 * redefined — see windGridPersist for why that boundary matters.
 */
function rehydratePersistedGrids(): void {
    if (persistRehydrated) return;
    persistRehydrated = true;
    try {
        const entries = loadWindGrids(WIND_GRID_MAX_AGE_MS);
        for (const entry of entries) {
            const key = cacheKeyForRes(entry.res);
            // Never overwrite a grid this session already fetched — memory is
            // by definition at least as fresh as disk.
            if (windGridCache.has(key)) continue;
            windGridCache.set(key, {
                grid: entry.grid,
                bounds: entry.bounds,
                res: entry.res,
                model: entry.model as CachedWindGrid['model'],
                fetchedAt: entry.fetchedAt,
            });
        }
        if (entries.length > 0) {
            const ageMin = Math.round((Date.now() - Math.max(...entries.map((e) => e.fetchedAt))) / 60000);
            log.warn(`[perf] wind cache rehydrated: ${entries.length} grid(s), newest ${ageMin}m old`);
            crumb('wind:rehydrate', `${entries.length}grids,${ageMin}m`);
        }
    } catch (err) {
        log.warn('[WindController] rehydrate failed', err);
    }
}

/** Debounced write-behind — a burst of stores during a pan must not turn into
 *  a burst of multi-hundred-kB serializations on the main thread. */
function schedulePersist(): void {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
        persistTimer = null;
        saveWindGrids(
            // Floors excluded BEFORE serialization — see storeWorldFloor.
            [...windGridCache.entries()]
                .filter(([key]) => !isWorldKey(key))
                .map(([, c]) => c)
                .map((c) => ({
                    grid: c.grid,
                    bounds: c.bounds,
                    res: c.res,
                    model: String(c.model),
                    fetchedAt: c.fetchedAt,
                })),
        );
    }, 3_000);
}

function storeCachedGrid(entry: CachedWindGrid): void {
    windGridCache.set(cacheKeyForRes(entry.res), entry);
    // The synoptic warm is fetched once at boot, so by definition it is always
    // the OLDEST entry — a plain oldest-first eviction would throw it away
    // after a few zoom levels of exploring, which is precisely when the punter
    // is most likely to pinch out and want it. Exempt it: it is the smallest
    // grid in the cache (~24×24) and bestCoveringGrid already refuses stale
    // entries, so keeping it cannot serve old wind, only save a fetch.
    const synopticKey = cacheKeyForRes(SYNOPTIC_GRID_RES_DEG);
    // World floors are exempt for the same reason the synoptic warm is — they
    // exist precisely for the moment the punter leaves everything else — and
    // they carry their own cap instead (MAX_WORLD_FLOORS, in storeWorldFloor),
    // so the exemption cannot become unbounded.
    const worldKeys = [...windGridCache.keys()].filter(isWorldKey).length;
    while (windGridCache.size - worldKeys > MAX_CACHED_GRIDS) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [key, cached] of windGridCache) {
            if (key === synopticKey && windGridCache.size > 1) continue;
            if (isWorldKey(key)) continue;
            if (cached.fetchedAt < oldestAt) {
                oldestAt = cached.fetchedAt;
                oldestKey = key;
            }
        }
        if (!oldestKey) break;
        windGridCache.delete(oldestKey);
    }
    schedulePersist();
}

/**
 * Store a world floor under its own key namespace.
 *
 * NOT keyed by bare resolution like the punter tiers: the viewport fetch's
 * resolution ladder bottoms out at 1.0°, which is exactly the GFS floor's
 * resolution — under one namespace a low-zoom viewport grid would silently
 * clobber the floor it is supposed to refine.
 */
function storeWorldFloor(entry: CachedWindGrid): void {
    windGridCache.set(`${WORLD_KEY_PREFIX}${String(entry.model)}`, entry);
    // Oldest-floor eviction, bounded separately from the punter tiers.
    let floors = [...windGridCache.entries()].filter(([k]) => isWorldKey(k));
    while (floors.length > MAX_WORLD_FLOORS) {
        floors.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
        windGridCache.delete(floors[0][0]);
        floors = floors.slice(1);
    }
    // Deliberately no schedulePersist(): floors are memory-only. The GFS
    // floor is ~19 MB of Float32 — serializing it just to have the 512 KB
    // entry cap discard the result would burn the main thread for nothing.
}

/** Does `outer` fully cover this (unpadded) viewport? Date-Line safe. */
function boundsCover(
    outer: { north: number; south: number; west: number; east: number },
    viewport: { north: number; south: number; west: number; east: number },
): boolean {
    const oEast = continuousEastForLongitudeRange(outer.west, outer.east);
    // A grid spanning the full 360° wraps — every longitude is inside it, and
    // the shift arithmetic below cannot express that. Without this a Fiji
    // viewport straddling the Date Line tests as "not covered" by a WORLD
    // grid, which is exactly the viewport the world floor exists for.
    if (oEast - outer.west >= 360 - 1e-9) {
        return viewport.north <= outer.north && viewport.south >= outer.south;
    }
    const oCenter = (outer.west + oEast) / 2;
    const vEast = continuousEastForLongitudeRange(viewport.west, viewport.east);
    const shift = Math.round((oCenter - (viewport.west + vEast) / 2) / 360) * 360;
    const vWest = viewport.west + shift;
    return (
        viewport.north <= outer.north && viewport.south >= outer.south && vWest >= outer.west && vEast + shift <= oEast
    );
}

/**
 * Do these two boxes share any water at all? Date-Line safe, same
 * normalisation as boundsCover.
 *
 * The weaker sibling of boundsCover, and the distinction is a SAFETY one.
 * Retaining a field while its replacement loads is fine when the old grid
 * OVERLAPS the new view — zooming out, the retained wind is still drawn where
 * it actually belongs, just not everywhere. It is NOT fine when the two are
 * disjoint: pan clean away and the old field paints Brisbane's wind over
 * Indonesia, which is not "incomplete" but wrong, and wrong wind on a chart is
 * a hazard rather than a rough edge.
 */
export function boundsOverlap(
    a: { north: number; south: number; west: number; east: number },
    b: { north: number; south: number; west: number; east: number },
): boolean {
    const aEast = continuousEastForLongitudeRange(a.west, a.east);
    const aCenter = (a.west + aEast) / 2;
    const bEast = continuousEastForLongitudeRange(b.west, b.east);
    const shift = Math.round((aCenter - (b.west + bEast) / 2) / 360) * 360;
    const bWest = b.west + shift;
    if (a.north < b.south || a.south > b.north) return false;
    return !(aEast < bWest || a.west > bEast + shift);
}

/** Finest fresh cached grid that fully covers the viewport for this model. */
function bestCoveringGrid(
    model: CachedWindGrid['model'],
    viewport: { north: number; south: number; west: number; east: number },
): CachedWindGrid | null {
    let best: CachedWindGrid | null = null;
    for (const entry of windGridCache.values()) {
        if (entry.model !== model) continue;
        if (Date.now() - entry.fetchedAt > WIND_GRID_MAX_AGE_MS) continue;
        if (!boundsCover(entry.bounds, viewport)) continue;
        // Finest wins; equal resolution goes to the fresher fetch (a viewport
        // grid and the GFS world floor can both sit at 1.0°).
        if (!best || entry.res < best.res || (entry.res === best.res && entry.fetchedAt > best.fetchedAt)) {
            best = entry;
        }
    }
    return best;
}

/**
 * Warm the fine local grid around the punter's position. Fire-and-forget with
 * its own dedupe; when it lands while the camera is still zoomed in, re-runs
 * fetchOnline so the sharper field swaps in without waiting for a gesture.
 */
async function prefetchLocalFineGrid(map: mapboxgl.Map, model: CachedWindGrid['model']): Promise<void> {
    if (fineGridInflight) return;
    const { lat, lon } = LocationStore.getState();
    const existing = windGridCache.get(cacheKeyForRes(FINE_GRID_RES_DEG));
    if (
        existing &&
        existing.model === model &&
        Date.now() - existing.fetchedAt < WIND_GRID_MAX_AGE_MS &&
        Math.abs((existing.bounds.north + existing.bounds.south) / 2 - lat) < 0.5 &&
        Math.abs((existing.bounds.west + existing.bounds.east) / 2 - lon) < 0.5
    ) {
        return;
    }
    fineGridInflight = true;
    try {
        const { fetchModelWindGrid } = await import('./OpenMeteoWindFetcher');
        const bounds = {
            north: Math.min(lat + FINE_GRID_HALF_SPAN_DEG, 85),
            south: Math.max(lat - FINE_GRID_HALF_SPAN_DEG, -85),
            west: lon - FINE_GRID_HALF_SPAN_DEG,
            east: lon + FINE_GRID_HALF_SPAN_DEG,
        };
        const grid = await withDeadline(
            fetchModelWindGrid(model, bounds, CHART_HOURS, FINE_GRID_RES_DEG),
            30_000,
            'om-fine-grid',
        );
        if (grid) {
            storeCachedGrid({ grid, bounds, res: FINE_GRID_RES_DEG, model, fetchedAt: Date.now() });
            log.info(`[WindController] Fine local grid warmed: ${grid.width}×${grid.height} @ ${FINE_GRID_RES_DEG}°`);
            if ((map.getZoom?.() ?? 0) > FINE_PREFETCH_MIN_ZOOM) {
                void WindDataController.fetchOnline(map);
            }
        }
    } catch (e) {
        log.warn('[WindController] Fine grid prefetch failed', e);
    } finally {
        fineGridInflight = false;
    }
}

/**
 * Warm the synoptic grid around the punter, so pinching out to z3 publishes
 * from memory instead of blanking for a wide fetch.
 *
 * Deliberately does NOT publish or re-run fetchOnline when it lands. The
 * fine-grid warm does, because a sharper field replacing a coarse one at the
 * SAME camera is an upgrade. This is the opposite: dropping a 2° field over a
 * z9 harbour view would be a downgrade the punter never asked for. It is a
 * cache warm and nothing else — bestCoveringGrid picks it up if and when the
 * camera actually goes wide.
 *
 * Takes no map for the same reason: it is anchored on the punter, not the
 * camera, so it is correct whatever the user is looking at while it lands.
 */
async function prefetchSynopticGrid(model: CachedWindGrid['model']): Promise<void> {
    if (synopticGridInflight) return;
    const { lat, lon } = LocationStore.getState();
    const existing = windGridCache.get(cacheKeyForRes(SYNOPTIC_GRID_RES_DEG));
    if (
        existing &&
        existing.model === model &&
        Date.now() - existing.fetchedAt < WIND_GRID_MAX_AGE_MS &&
        // A synoptic field stays useful over a much bigger move than a fine
        // one, so the re-warm threshold is correspondingly wider — a few
        // degrees of travel does not invalidate a 50-degree picture.
        Math.abs((existing.bounds.north + existing.bounds.south) / 2 - lat) < 5 &&
        Math.abs((existing.bounds.west + existing.bounds.east) / 2 - lon) < 5
    ) {
        return;
    }
    const bounds = {
        north: Math.min(lat + SYNOPTIC_HALF_SPAN_DEG, 85),
        south: Math.max(lat - SYNOPTIC_HALF_SPAN_DEG, -85),
        west: lon - SYNOPTIC_HALF_SPAN_DEG,
        east: lon + SYNOPTIC_HALF_SPAN_DEG,
    };
    // Something fresh already covers this whole area — most often because the
    // punter opened the app already zoomed out, so the ordinary viewport fetch
    // did this job. Warming again would be a second download of the same
    // picture at a different resolution key.
    if (bestCoveringGrid(model, bounds)) {
        // Silence here was ambiguous: an absent "warm ready" line could mean
        // the warm never ran OR that it correctly had nothing to do. Say which.
        log.warn('[perf] wind synoptic warm skipped — a fresh grid already covers');
        return;
    }
    synopticGridInflight = true;
    try {
        const { fetchModelWindGrid } = await import('./OpenMeteoWindFetcher');
        const grid = await withDeadline(
            fetchModelWindGrid(model, bounds, CHART_HOURS, SYNOPTIC_GRID_RES_DEG),
            30_000,
            'om-synoptic-grid',
        );
        if (grid) {
            storeCachedGrid({ grid, bounds, res: SYNOPTIC_GRID_RES_DEG, model, fetchedAt: Date.now() });
            // warn, not info: info is silent in prod, so there was no way to
            // tell from a device log whether the warm that prevents the
            // zoom-out blank had actually run.
            log.warn(
                `[perf] wind synoptic warm ready ${grid.width}×${grid.height} @ ${SYNOPTIC_GRID_RES_DEG.toFixed(2)}°`,
            );
            crumb('wind:synoptic', `${grid.width}x${grid.height}`);
        }
    } catch (e) {
        log.warn('[WindController] Synoptic grid prefetch failed', e);
    } finally {
        synopticGridInflight = false;
    }
}

/**
 * Warm the world floor for a point-batch model, so a pan to anywhere on earth
 * publishes SOMETHING real instantly. See the WORLD FLOOR note at the top.
 *
 * Fire-and-forget like the other warms, with the same shape of dedupe. Runs
 * only on a fast link — on metered/slow links the punter tiers still warm and
 * a world pan simply pays today's fetch-on-demand price. GFS needs no warm
 * here: its floor is stored organically by the global-mode fetch itself.
 */
async function prefetchWorldFloor(model: CachedWindGrid['model']): Promise<void> {
    if (worldFloorInflight) return;
    if (!isFastLink()) return;
    const existing = windGridCache.get(`${WORLD_KEY_PREFIX}${String(model)}`);
    if (existing && Date.now() - existing.fetchedAt < WIND_GRID_MAX_AGE_MS) return;
    worldFloorInflight = true;
    try {
        const { fetchModelWindGrid } = await import('./OpenMeteoWindFetcher');
        const grid = await withDeadline(
            fetchModelWindGrid(model, { ...WORLD_FLOOR_BOUNDS }, WORLD_FLOOR_HOURS, WORLD_FLOOR_RES_DEG),
            60_000,
            'om-world-floor',
        );
        if (grid) {
            storeWorldFloor({
                grid,
                bounds: { ...WORLD_FLOOR_BOUNDS },
                res: WORLD_FLOOR_RES_DEG,
                model,
                fetchedAt: Date.now(),
            });
            // warn, not info — same reasoning as the synoptic warm: a device
            // log must be able to say whether the floor that prevents the
            // world-pan blank had actually landed.
            log.warn(
                `[perf] wind world floor ready ${grid.width}×${grid.height} @ ${WORLD_FLOOR_RES_DEG}° (${String(model)})`,
            );
            crumb('wind:world-floor', `${grid.width}x${grid.height}`);
        }
    } catch (e) {
        log.warn('[WindController] World floor prefetch failed', e);
    } finally {
        worldFloorInflight = false;
    }
}

/**
 * Monotonic fence for every asynchronous wind load.
 *
 * Model/field changes clear WindStore.grid immediately, but the request they
 * replace cannot always be aborted (CapacitorHttp ignores AbortSignal). An
 * older request must therefore prove that it is still the newest request and
 * still belongs to the same model/field/mode before it may publish anything.
 */
let windRequestGeneration = 0;

interface WindRequestContext {
    generation: number;
    isGlobalMode: boolean;
    model: ReturnType<typeof WindStore.getState>['model'];
    field: ReturnType<typeof WindStore.getState>['field'];
}

function isCurrentWindRequest(request: WindRequestContext): boolean {
    const current = WindStore.getState();
    return (
        request.generation === windRequestGeneration &&
        current.isGlobalMode === request.isGlobalMode &&
        current.model === request.model &&
        current.field === request.field
    );
}

/**
 * A request that is going to replace the currently-painted field normally
 * removes that field before it starts — a retained grid from another mount,
 * model, or mode must never masquerade as live while its replacement loads.
 *
 * The one exception is a VIEWPORT REFINEMENT: same model/field/mode, the
 * on-screen grid came from a fetch this controller made minutes ago, and the
 * user just panned or zoomed. Blanking the field there is what made zooming
 * in "flaky" — the animation died for the whole refetch. That grid was
 * truthfully live one frame earlier, so it keeps animating until the sharper
 * replacement swaps in atomically (`keepRenderedGrid`). Model/field switches
 * still clear instantly via WindStore.setModel/setField.
 */
function beginWindGridLoad(request: WindRequestContext, keepRenderedGrid = false): boolean {
    if (!isCurrentWindRequest(request)) return false;
    if (keepRenderedGrid && WindStore.getState().grid) {
        WindStore.setState({ loading: true, error: null });
        return true;
    }
    WindStore.setState({
        grid: null,
        totalHours: 0,
        hour: 0,
        loading: true,
        error: null,
    });
    return true;
}

function clearRenderableWindGrid(): void {
    lastPublishedCacheKey = null;
    WindStore.setState({
        grid: null,
        totalHours: 0,
        hour: 0,
        loading: false,
        error: null,
    });
}

function boundsChangedSignificantly(a: CachedBounds, b: CachedBounds): boolean {
    // Re-fetch if view shifted by more than 20% or zoom changed by >1
    const latSpan = a.north - a.south;
    const aEast = continuousEastForLongitudeRange(a.west, a.east);
    const lonSpan = aEast - a.west;
    // Cached viewport requests deliberately retain their continuous longitude
    // axis (e.g. 178.4…181.6). Mapbox may report the unchanged camera as
    // 179…-179 on the next moveend, so unwrap that short viewport beside the
    // cached grid before measuring a shift. Comparing the raw spellings looks
    // like a 360° pan and repeatedly clears/reloads z3 wind.
    const bSpan = continuousEastForLongitudeRange(b.west, b.east) - b.west;
    const aCenter = (a.west + aEast) / 2;
    const bWest = b.west + Math.round((aCenter - b.west) / 360) * 360;
    const bEast = bWest + bSpan;
    const latShift = Math.abs(a.north - b.north) + Math.abs(a.south - b.south);
    const lonShift = Math.abs(aEast - bEast) + Math.abs(a.west - bWest);
    const zoomDiff = Math.abs(a.zoom - b.zoom);

    return latShift / latSpan > 0.4 || lonShift / lonSpan > 0.4 || zoomDiff > 1;
}

function isCacheStale(cached: CachedBounds): boolean {
    return Date.now() - cached.fetchedAt > WIND_GRID_MAX_AGE_MS;
}

/** Test seam — the grid cache is module-private on purpose; this lets the
 *  world floor's coverage, tie-break and eviction contracts be pinned without
 *  standing up a live map and a mocked fetch stack. */
export const __windCacheForTest = {
    clear(): void {
        windGridCache.clear();
    },
    seed(entry: CachedWindGrid, asWorldFloor = false): void {
        if (asWorldFloor) storeWorldFloor(entry);
        else storeCachedGrid(entry);
    },
    keys(): string[] {
        return [...windGridCache.keys()];
    },
    bestCovering: bestCoveringGrid,
};

// ── Moveend listener management ──

let moveEndHandler: (() => void) | null = null;
let moveEndTimer: ReturnType<typeof setTimeout> | null = null;

function clearMoveListener(map: mapboxgl.Map) {
    if (moveEndHandler) {
        map.off('moveend', moveEndHandler);
        moveEndHandler = null;
    }
    if (moveEndTimer) {
        clearTimeout(moveEndTimer);
        moveEndTimer = null;
    }
}

// ── Public API ──

export const WindDataController = {
    /**
     * Activate the wind data pipeline for the current mode.
     * Registers map listeners for online mode, loads file for offline mode.
     */
    async activate(map: mapboxgl.Map) {
        // Disk → memory BEFORE the fetch decision, so a covering grid from the
        // last launch can publish instantly and the network runs behind it.
        rehydratePersistedGrids();
        const generation = ++windRequestGeneration;
        const { isGlobalMode, model, field } = WindStore.getState();
        // Non-GFS models and the gust field come from Open-Meteo's point-batch
        // API, which can't do full-earth — they're always VIEWPORT-bounded and
        // so must re-fetch on pan even in global mode. Only GFS sustained wind
        // gets the fetch-once full-earth GRIB in global mode.
        const viewportBound = model !== 'gfs' || field === 'gust';

        clearMoveListener(map);
        // Viewport wind must listen before the initial request starts. A model
        // fetch can take up to 30 seconds; registering after await loses any
        // moveend that occurs while it is loading and publishes the abandoned
        // viewport until the user moves a second time.
        if (isGlobalMode && viewportBound) {
            this.registerMoveListener(map);
        }

        if (isGlobalMode) await this.fetchOnline(map, generation);
        else await this.fetchOffline(generation);
    },

    /**
     * Deactivate: remove map listeners, clear state.
     */
    deactivate(map: mapboxgl.Map) {
        windRequestGeneration += 1;
        clearMoveListener(map);
        lastFetchedBounds = null;
        clearRenderableWindGrid();
    },

    /**
     * Online pipeline: fetch wind grid via Supabase GFS GRIB2 edge function.
     * In global mode, always fetches the full Earth grid.
     * In passage mode, fetches for the visible viewport.
     */
    async fetchOnline(map: mapboxgl.Map, generation: number = ++windRequestGeneration): Promise<boolean> {
        const { isGlobalMode, model, field } = WindStore.getState();
        const request: WindRequestContext = { generation, isGlobalMode, model, field };
        if (!isCurrentWindRequest(request)) return false;

        const bounds = map.getBounds();
        if (!bounds) return isCurrentWindRequest(request);

        const currentZoom = map.getZoom();

        // GFS sustained wind uses the fine full-earth GRIB-edge path (and the
        // efficient global fetch). Any other model, or the gust field, comes
        // from Open-Meteo's gridded point-batch API — viewport-bounded, carries
        // gust, and is the source the model/field switcher routes through.
        const useOpenMeteoGridded = model !== 'gfs' || field === 'gust';

        // Determine bounds for the request
        let north: number, south: number, west: number, east: number;
        /** What is actually VISIBLE — the coverage tests use this, not the
         *  padded request bounds, so a small pan inside the pad still keeps
         *  the old field while its replacement loads. */
        let visibleBounds: { north: number; south: number; west: number; east: number };
        let desiredRes = 1.0;

        if (isGlobalMode && !useOpenMeteoGridded) {
            north = 90;
            south = -90;
            west = -180;
            east = 180;
            visibleBounds = { north, south, west, east };
            // A fresh world floor answers global mode outright — the re-toggle
            // and the model-switch-back used to re-download the whole planet
            // the cache was already holding.
            const floor = bestCoveringGrid(model, WORLD_FLOOR_BOUNDS);
            if (floor && floor.res <= 1.0 + 1e-6) {
                const publishKey = publishKeyFor(floor.res, floor.fetchedAt, field);
                if (!(lastPublishedCacheKey === publishKey && WindStore.getState().grid)) {
                    if (!isCurrentWindRequest(request)) return false;
                    WindStore.setGrid(floor.grid);
                    lastPublishedCacheKey = publishKey;
                    lastFetchedBounds = { ...floor.bounds, zoom: currentZoom, fetchedAt: floor.fetchedAt };
                    log.warn('[perf] wind published world floor instantly (global mode)');
                }
                return isCurrentWindRequest(request);
            }
        } else {
            // Passage mode: visible viewport with padding
            const currentBounds: CachedBounds = {
                north: Math.min(bounds.getNorth(), 85),
                south: Math.max(bounds.getSouth(), -85),
                west: bounds.getWest(),
                east: bounds.getEast(),
                zoom: currentZoom,
                fetchedAt: Date.now(),
            };
            visibleBounds = currentBounds;

            // Add 30% padding along the viewport's short, continuous
            // longitude axis. A Date-Line viewport can be expressed as
            // 179…-179; subtracting those raw values gives -358° and used to
            // pad the request onto the opposite side of the planet at z3.
            const continuousEast = continuousEastForLongitudeRange(currentBounds.west, currentBounds.east);
            const latPad = (currentBounds.north - currentBounds.south) * 0.3;
            const lonPad = (continuousEast - currentBounds.west) * 0.3;
            north = Math.min(currentBounds.north + latPad, 90);
            south = Math.max(currentBounds.south - latPad, -90);
            west = currentBounds.west - lonPad;
            east = continuousEast + lonPad;

            // Adaptive resolution: fine when zoomed in, but coarsen for wide
            // viewports so a zoomed-out (or global) view doesn't explode into
            // thousands of Open-Meteo point batches. Cap ~24 cells per side.
            const maxSpan = Math.max(Math.abs(east - west), Math.abs(north - south));
            desiredRes = Math.max(currentZoom > 8 ? 0.25 : currentZoom > 6 ? 0.5 : 1.0, maxSpan / 24);

            // A fresh cached grid that fully covers the viewport publishes
            // instantly — no network, no blank, no stale rectangle.
            //
            // ALL models now, not just the point-batch ones (2026-08-24). The
            // GFS path never consulted the cache, so GFS passage mode paid a
            // full GRIB fetch for water a cached grid already described — and
            // with the world floor in the cache, this line is precisely what
            // turns a trans-Pacific pan from a blank into instant coarse wind
            // refined behind. The GFS refine still goes through the GRIB edge
            // path below; only the FIRST PAINT comes from memory.
            const covering = bestCoveringGrid(model, currentBounds);
            if (covering) {
                const publishKey = publishKeyFor(covering.res, covering.fetchedAt, field);
                const alreadyPublished = lastPublishedCacheKey === publishKey && WindStore.getState().grid;
                if (!alreadyPublished) {
                    let grid = covering.grid;
                    if (field === 'gust') {
                        const { applyGustField } = await import('./windFieldTransforms');
                        if (!isCurrentWindRequest(request)) return false;
                        grid = applyGustField(grid);
                    }
                    if (!isCurrentWindRequest(request)) return false;
                    WindStore.setGrid(grid);
                    lastPublishedCacheKey = publishKey;
                    lastFetchedBounds = { ...covering.bounds, zoom: currentZoom, fetchedAt: covering.fetchedAt };
                    // warn, not info: this is the line that says the zoom-out
                    // painted from memory instead of waiting on a fetch, and
                    // info is silent in prod — so a device log could show a
                    // slow fetch without revealing that a field was already up
                    // in front of it (2026-08-22).
                    log.warn(
                        `[perf] wind published cached ${cacheKeyForRes(covering.res)}° grid instantly (covers viewport)`,
                    );
                }
                // Fine enough for this zoom → done. Coarser than the tier
                // we'd fetch → keep it on screen and refine behind it.
                if (covering.res <= desiredRes + 1e-6) return isCurrentWindRequest(request);
            }

            // Skip if bounds haven't changed significantly AND the cache is
            // fresh AND we still have a grid. The grid check matters because
            // setModel()/setField() clear the grid without moving the map —
            // without it, a model/field switch would be skipped as "no change".
            if (
                lastFetchedBounds &&
                !boundsChangedSignificantly(lastFetchedBounds, currentBounds) &&
                !isCacheStale(lastFetchedBounds) &&
                WindStore.getState().grid
            ) {
                return isCurrentWindRequest(request);
            }
            if (lastFetchedBounds && isCacheStale(lastFetchedBounds)) {
                const ageMin = Math.round((Date.now() - lastFetchedBounds.fetchedAt) / 60000);
                log.info(`[WindController] Wind grid is ${ageMin}m old — refetching`);
            }
        }

        // Viewport refinement keeps the old field animating while the
        // replacement loads.
        //
        // COVERAGE IS NO LONGER REQUIRED (2026-08-22). This used to also
        // demand boundsCover(), on the reasoning that a hard-edged rectangle
        // floating over a dark map read worse than an honest clear. That
        // reasoning was made when a clear lasted one fetch; measured on
        // Shane's device a zoom-out clear now lasts 3140 ms of black, because
        // the wide grid is the slowest fetch there is — "when i zoom out, it
        // is a little jerky, can we make it so that it flows nicely and does
        // not show any blank areas".
        //
        // Keeping a partial field is strictly more information than keeping
        // none, and the synoptic warm usually means SOME cached grid already
        // covers the wider view and publishes instantly above, so this branch
        // is the rare gap rather than the normal zoom-out path.
        //
        // OVERLAP, not coverage — and the difference is safety, not polish.
        // Zooming out, the retained field is still drawn where it belongs and
        // is merely incomplete. Panning CLEAN AWAY is different in kind: the
        // old grid would paint Brisbane's wind over Indonesia, which is not
        // incomplete but wrong, and wrong wind on a chart is a hazard. So a
        // disjoint view still clears honestly and lets the loading pill own
        // the wait, exactly as before. Stale is refused either way.
        const keepRenderedGrid =
            Boolean(WindStore.getState().grid) &&
            lastFetchedBounds !== null &&
            !isCacheStale(lastFetchedBounds) &&
            boundsOverlap(lastFetchedBounds, visibleBounds);
        if (!beginWindGridLoad(request, keepRenderedGrid)) return false;

        try {
            // ── Open-Meteo gridded path (non-GFS model, or gust field) ──
            // The model/field switcher routes here. One call returns sustained
            // wind AND gust for the chosen model; we apply the gust transform
            // client-side when the gust field is active.
            if (useOpenMeteoGridded) {
                const { fetchModelWindGrid } = await import('./OpenMeteoWindFetcher');
                if (!isCurrentWindRequest(request)) return false;
                const fetchT0 = performance.now();
                crumb('wind:fetch-start', `${model} ${desiredRes.toFixed(2)}°${heapTag()}`);
                const rawGrid = await withDeadline(
                    fetchModelWindGrid(model, { north, south, west, east }, CHART_HOURS, desiredRes),
                    30_000,
                    'om-model-grid',
                );
                // warn, not info: the network half of "wind is slow", split
                // from the GPU half logged by WindParticleLayer.setGrid.
                const fetchMs = Math.round(performance.now() - fetchT0);
                log.warn(
                    `[perf] wind fetch ${model} ${rawGrid ? `${rawGrid.width}×${rawGrid.height}×${rawGrid.totalHours}h` : 'FAILED'} ${fetchMs}ms`,
                );
                crumb('wind:fetch', `${fetchMs}ms${rawGrid ? '' : ',fail'}`);
                if (!isCurrentWindRequest(request)) return false;
                let grid = rawGrid;
                if (grid && field === 'gust') {
                    const { applyGustField } = await import('./windFieldTransforms');
                    if (!isCurrentWindRequest(request)) return false;
                    grid = applyGustField(grid);
                }
                if (!isCurrentWindRequest(request)) return false;
                if (grid && rawGrid) {
                    const fetchedAt = Date.now();
                    // Cache the RAW grid (pre-field-transform) so a later
                    // gust↔wind switch can republish from memory correctly.
                    storeCachedGrid({
                        grid: rawGrid,
                        bounds: { north, south, west, east },
                        res: desiredRes,
                        model,
                        fetchedAt,
                    });
                    lastPublishedCacheKey = publishKeyFor(desiredRes, fetchedAt, field);
                    lastFetchedBounds = { north, south, west, east, zoom: currentZoom, fetchedAt };
                    WindStore.setGrid(grid);
                    log.info(
                        `[WindController] Open-Meteo ${model} grid loaded: ${grid.width}×${grid.height}, ${grid.totalHours}h, field=${field}`,
                    );
                } else {
                    WindStore.setError(`No ${model.toUpperCase()} wind data for this area`);
                }
                return true;
            }

            // Primary: Supabase GFS GRIB2 edge function (reliable).
            // Route through the boat Pi when it's on the local network — the
            // Pi caches the binary GRIB keyed by rounded bounds so subsequent
            // fetches (pan, re-toggle, passage plan) are instant even when the
            // phone is on cellular.
            // One implementation, shared with isochroneEnhancer and the
            // passage planner. This copy called plain fetch() at the Pi's
            // self-signed HTTPS and so failed with -1202 on every device;
            // see services/weather/fetchWindGrid.ts.
            const { fetchWindGridBuffer } = await import('./fetchWindGrid');
            const res = await fetchWindGridBuffer({ north, south, east, west }, { timeoutMs: 30_000 });
            if (!isCurrentWindRequest(request)) return false;

            if (!isCurrentWindRequest(request)) return false;

            if (res.status >= 200 && res.status < 300) {
                const buffer = res.buf;
                if (buffer.byteLength > 200) {
                    const { decodeGrib2WindMultiHour } = await import('./decodeGrib2Wind');
                    if (!isCurrentWindRequest(request)) return false;
                    const grid = decodeGrib2WindMultiHour(buffer);
                    if (!isCurrentWindRequest(request)) return false;

                    const fetchedAt = Date.now();
                    lastFetchedBounds = {
                        north,
                        south,
                        west,
                        east,
                        zoom: currentZoom,
                        fetchedAt,
                    };
                    // A full-earth GRIB is the world floor — store the SAME
                    // object under the world key (zero extra bytes; a JS
                    // reference) so a model switch no longer throws the whole
                    // planet away, and a switch BACK republishes from memory.
                    if (isGlobalMode && !useOpenMeteoGridded) {
                        storeWorldFloor({
                            grid,
                            bounds: { north: 90, south: -90, west: -180, east: 180 },
                            res: 1.0,
                            model,
                            fetchedAt,
                        });
                        lastPublishedCacheKey = publishKeyFor(1.0, fetchedAt, field);
                    }
                    WindStore.setGrid(grid);
                    log.info(
                        `[WindController] GFS GRIB loaded: ${grid.width}×${grid.height}, ${grid.totalHours} forecast hours, refTime=${grid.refTime || 'n/a'}`,
                    );
                    return true;
                }
            }

            // If edge function failed, fall back to Open-Meteo
            if (!isCurrentWindRequest(request)) return false;
            log.warn('[WindController] Edge function failed, trying Open-Meteo fallback');
            const fallbackGrid = isGlobalMode
                ? await fetchGlobalWindField()
                : await fetchWindGrid(north, south, west, east, currentZoom);

            if (!isCurrentWindRequest(request)) return false;
            if (fallbackGrid) {
                lastFetchedBounds = { north, south, west, east, zoom: currentZoom, fetchedAt: Date.now() };
                WindStore.setGrid(fallbackGrid);
            } else {
                WindStore.setError('No wind data available');
            }
            return true;
        } catch (e) {
            if (!isCurrentWindRequest(request)) return false;
            log.error('[WindController] Fetch failed:', e);
            WindStore.setError(`Failed to fetch wind data: ${e instanceof Error ? e.message : 'Unknown error'}`);
            return true;
        }
    },

    /**
     * Offline pipeline: load pre-parsed .wind.bin from device storage.
     */
    async fetchOffline(generation: number = ++windRequestGeneration): Promise<boolean> {
        const { localGribPath, isGlobalMode, model, field } = WindStore.getState();
        const request: WindRequestContext = { generation, isGlobalMode, model, field };
        if (!beginWindGridLoad(request)) return false;

        if (!localGribPath) {
            if (isCurrentWindRequest(request)) {
                WindStore.setError(
                    'No downloaded wind data available. Use the GRIB downloader to get passage wind data.',
                );
            }
            return true;
        }

        try {
            const grid = await loadLocalWindFile(localGribPath);
            if (!isCurrentWindRequest(request)) return false;
            WindStore.setGrid(grid);
            return true;
        } catch (e) {
            if (!isCurrentWindRequest(request)) return false;
            log.error('[WindController] Offline load failed:', e);
            WindStore.setError(`Failed to load wind file: ${e instanceof Error ? e.message : 'Unknown error'}`);
            return true;
        }
    },

    /**
     * Register moveend listener for passage mode re-fetching.
     * Debounced 800ms to avoid hammering the API during continuous panning.
     */
    registerMoveListener(map: mapboxgl.Map) {
        clearMoveListener(map);

        moveEndHandler = () => {
            if (moveEndTimer) clearTimeout(moveEndTimer);
            moveEndTimer = setTimeout(() => {
                const { isGlobalMode, model, field } = WindStore.getState();
                // GFS-wind in global mode is full-earth — no pan refetch. Any
                // Open-Meteo gridded selection is viewport-bounded, so it must
                // refetch on pan even in global mode.
                const useOpenMeteoGridded = model !== 'gfs' || field === 'gust';
                if (isGlobalMode && !useOpenMeteoGridded) return;
                // Camera behaviour, so it lives with the camera listener:
                // a zoom-in past synoptic warms the punter-centred fine grid
                // so harbour zoom publishes from memory. Fire-and-forget.
                if (useOpenMeteoGridded && (map.getZoom?.() ?? 0) > FINE_PREFETCH_MIN_ZOOM) {
                    void prefetchLocalFineGrid(map, model);
                    // ...and the OTHER end of the range, so the first pinch-out
                    // to synoptic publishes from memory instead of blanking for
                    // a wide fetch (Shane 2026-08-22). Same trigger as the fine
                    // warm on purpose: it runs once the camera has SETTLED, so
                    // a background download can never compete with the local
                    // field the punter is waiting on. Wind boots by flying to
                    // its z9 frame, so this still lands moments after startup.
                    void prefetchSynopticGrid(model);
                    // ...and the tier the punter cannot fall off. Fast links
                    // only; dedupes and staleness-checks itself. moveend is
                    // the ONLY trigger on purpose: it fires when the camera
                    // has settled, so this download can never compete with a
                    // field the punter is actively waiting on — and toggling
                    // wind on always produces one, because MapHub's framing
                    // flight eases the camera to the layer's frame.
                    void prefetchWorldFloor(model);
                }
                this.fetchOnline(map);
            }, 800);
        };

        map.on('moveend', moveEndHandler);
    },

    /**
     * Switch modes and reload data.
     */
    async switchMode(map: mapboxgl.Map) {
        clearMoveListener(map);
        lastFetchedBounds = null;
        WindStore.toggleMode();
        await this.activate(map);
    },
};
