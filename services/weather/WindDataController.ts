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
import { fetchWindGrid, fetchGlobalWindField } from './windField';
import { loadLocalWindFile } from './GribWindParser';
import { WindStore } from '../../stores/WindStore';
import { piCache } from '../PiCacheService';
import { withDeadline } from '../../utils/deadline';
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
 * A request that is going to replace the currently-painted field must remove
 * that field before it starts. Keeping a last-known grid while loading sounds
 * friendly, but without a visible provenance/freshness treatment it makes an
 * offline or failed refresh look live. The particle overlay reads `grid`
 * directly, so null is the only truthful loading/error state.
 */
function beginWindGridLoad(request: WindRequestContext): boolean {
    if (!isCurrentWindRequest(request)) return false;
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
    const lonSpan = a.east - a.west;
    const latShift = Math.abs(a.north - b.north) + Math.abs(a.south - b.south);
    const lonShift = Math.abs(a.east - b.east) + Math.abs(a.west - b.west);
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

        if (isGlobalMode && !useOpenMeteoGridded) {
            north = 90;
            south = -90;
            west = -180;
            east = 180;
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

            // Add 30% padding
            const latPad = (currentBounds.north - currentBounds.south) * 0.3;
            const lonPad = (currentBounds.east - currentBounds.west) * 0.3;
            north = Math.min(currentBounds.north + latPad, 90);
            south = Math.max(currentBounds.south - latPad, -90);
            west = currentBounds.west - lonPad;
            east = currentBounds.east + lonPad;
        }

        if (!beginWindGridLoad(request)) return false;

        try {
            // ── Open-Meteo gridded path (non-GFS model, or gust field) ──
            // The model/field switcher routes here. One call returns sustained
            // wind AND gust for the chosen model; we apply the gust transform
            // client-side when the gust field is active.
            if (useOpenMeteoGridded) {
                const { fetchModelWindGrid } = await import('./OpenMeteoWindFetcher');
                if (!isCurrentWindRequest(request)) return false;
                // Adaptive resolution: fine when zoomed in, but coarsen for wide
                // viewports so a zoomed-out (or global) view doesn't explode into
                // thousands of Open-Meteo point batches. Cap ~24 cells per side.
                const maxSpan = Math.max(Math.abs(east - west), Math.abs(north - south));
                const res = Math.max(currentZoom > 6 ? 0.5 : 1.0, maxSpan / 24);
                const CHART_HOURS = 48;
                let grid = await withDeadline(
                    fetchModelWindGrid(model, { north, south, west, east }, CHART_HOURS, res),
                    30_000,
                    'om-model-grid',
                );
                if (!isCurrentWindRequest(request)) return false;
                if (grid && field === 'gust') {
                    const { applyGustField } = await import('./windFieldTransforms');
                    if (!isCurrentWindRequest(request)) return false;
                    grid = applyGustField(grid);
                }
                if (!isCurrentWindRequest(request)) return false;
                if (grid) {
                    lastFetchedBounds = { north, south, west, east, zoom: currentZoom, fetchedAt: Date.now() };
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
