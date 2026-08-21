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
import { piCache } from '../PiCacheService';
import { withDeadline } from '../../utils/deadline';
import { continuousEastForLongitudeRange } from './windLongitude';
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

function storeCachedGrid(entry: CachedWindGrid): void {
    windGridCache.set(cacheKeyForRes(entry.res), entry);
    // The synoptic warm is fetched once at boot, so by definition it is always
    // the OLDEST entry — a plain oldest-first eviction would throw it away
    // after a few zoom levels of exploring, which is precisely when the punter
    // is most likely to pinch out and want it. Exempt it: it is the smallest
    // grid in the cache (~24×24) and bestCoveringGrid already refuses stale
    // entries, so keeping it cannot serve old wind, only save a fetch.
    const synopticKey = cacheKeyForRes(SYNOPTIC_GRID_RES_DEG);
    while (windGridCache.size > MAX_CACHED_GRIDS) {
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [key, cached] of windGridCache) {
            if (key === synopticKey && windGridCache.size > 1) continue;
            if (cached.fetchedAt < oldestAt) {
                oldestAt = cached.fetchedAt;
                oldestKey = key;
            }
        }
        if (!oldestKey) break;
        windGridCache.delete(oldestKey);
    }
}

/** Does `outer` fully cover this (unpadded) viewport? Date-Line safe. */
function boundsCover(
    outer: { north: number; south: number; west: number; east: number },
    viewport: { north: number; south: number; west: number; east: number },
): boolean {
    const oEast = continuousEastForLongitudeRange(outer.west, outer.east);
    const oCenter = (outer.west + oEast) / 2;
    const vEast = continuousEastForLongitudeRange(viewport.west, viewport.east);
    const shift = Math.round((oCenter - (viewport.west + vEast) / 2) / 360) * 360;
    const vWest = viewport.west + shift;
    return (
        viewport.north <= outer.north && viewport.south >= outer.south && vWest >= outer.west && vEast + shift <= oEast
    );
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
        if (!best || entry.res < best.res) best = entry;
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
    if (bestCoveringGrid(model, bounds)) return;
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
            log.info(
                `[WindController] Synoptic grid warmed: ${grid.width}×${grid.height} @ ${SYNOPTIC_GRID_RES_DEG.toFixed(2)}°`,
            );
        }
    } catch (e) {
        log.warn('[WindController] Synoptic grid prefetch failed', e);
    } finally {
        synopticGridInflight = false;
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
            const covering = useOpenMeteoGridded ? bestCoveringGrid(model, currentBounds) : null;
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
                    log.info(
                        `[WindController] Cached ${cacheKeyForRes(covering.res)}° grid published instantly (covers viewport)`,
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
        // replacement loads — but ONLY while that field actually covers the
        // new viewport. Zooming out past its bounds used to leave its
        // hard-edged rectangle floating over a dark map for the whole wide
        // fetch; an honest clear (+ the loading pill) reads better there.
        const keepRenderedGrid =
            Boolean(WindStore.getState().grid) &&
            lastFetchedBounds !== null &&
            !isCacheStale(lastFetchedBounds) &&
            boundsCover(lastFetchedBounds, visibleBounds);
        if (!beginWindGridLoad(request, keepRenderedGrid)) return false;

        try {
            // ── Open-Meteo gridded path (non-GFS model, or gust field) ──
            // The model/field switcher routes here. One call returns sustained
            // wind AND gust for the chosen model; we apply the gust transform
            // client-side when the gust field is active.
            if (useOpenMeteoGridded) {
                const { fetchModelWindGrid } = await import('./OpenMeteoWindFetcher');
                if (!isCurrentWindRequest(request)) return false;
                const rawGrid = await withDeadline(
                    fetchModelWindGrid(model, { north, south, west, east }, CHART_HOURS, desiredRes),
                    30_000,
                    'om-model-grid',
                );
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
            const supabaseUrl =
                (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
                'https://pcisdplnodrphauixcau.supabase.co';
            const supabaseKey =
                (typeof import.meta !== 'undefined' &&
                    (import.meta.env?.VITE_SUPABASE_ANON_KEY || import.meta.env?.VITE_SUPABASE_KEY)) ||
                '';
            const directUrl = `${supabaseUrl}/functions/v1/fetch-wind-grid`;
            const usePi = piCache.isAvailable();
            const edgeUrl = usePi ? `${piCache.baseUrl}/api/grib/wind-grid` : directUrl;

            // JS-level deadline — AbortSignal is a no-op under CapacitorHttp (see utils/deadline.ts)
            const res = await withDeadline(
                fetch(edgeUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(usePi || !supabaseKey
                            ? {}
                            : {
                                  apikey: supabaseKey,
                                  Authorization: `Bearer ${supabaseKey}`,
                              }),
                    },
                    body: JSON.stringify({ north, south, east, west }),
                }),
                30_000,
                'fetch-wind-grid',
            );
            if (!isCurrentWindRequest(request)) return false;

            if (res.ok) {
                const buffer = await res.arrayBuffer();
                if (!isCurrentWindRequest(request)) return false;
                if (buffer.byteLength > 200) {
                    const { decodeGrib2WindMultiHour } = await import('./decodeGrib2Wind');
                    if (!isCurrentWindRequest(request)) return false;
                    const grid = decodeGrib2WindMultiHour(buffer);
                    if (!isCurrentWindRequest(request)) return false;

                    lastFetchedBounds = {
                        north,
                        south,
                        west,
                        east,
                        zoom: currentZoom,
                        fetchedAt: Date.now(),
                    };
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
