/**
 * IsochronePrecomputeCache — Fire-and-forget background isochrone computation.
 *
 * Called from useVoyageForm as soon as coordinates are resolved (CTA press).
 * When the user later opens the map, usePassagePlanner checks this cache
 * and uses the pre-computed result instead of recomputing from scratch.
 *
 * Module-level singleton — survives React component mount/unmount cycles.
 */

import type { IsochroneResult } from './IsochroneRouter';

interface PrecomputedRoute {
    depLat: number;
    depLon: number;
    arrLat: number;
    arrLon: number;
    result: IsochroneResult;
    computedAt: number; // Date.now()
}

let _cache: PrecomputedRoute | null = null;
let _computing = false;
let _abortGen = 0;

/**
 * Check if a pre-computed route matches the requested departure/arrival.
 * Returns the cached result if within 0.01° and fresher than 5 minutes.
 */
export function getPrecomputedRoute(
    depLat: number,
    depLon: number,
    arrLat: number,
    arrLon: number,
): IsochroneResult | null {
    if (!_cache) return null;
    const MAX_AGE_MS = 5 * 60_000; // 5 minutes
    if (Date.now() - _cache.computedAt > MAX_AGE_MS) {
        _cache = null;
        return null;
    }
    const close = (a: number, b: number) => Math.abs(a - b) < 0.01;
    if (
        close(_cache.depLat, depLat) &&
        close(_cache.depLon, depLon) &&
        close(_cache.arrLat, arrLat) &&
        close(_cache.arrLon, arrLon)
    ) {
        const result = _cache.result;
        _cache = null; // consume once
        return result;
    }
    _cache = null; // stale coords
    return null;
}

/**
 * Fire background isochrone computation. Non-blocking, fire-and-forget.
 */
export async function precomputeIsochrone(
    dep: { lat: number; lon: number },
    arr: { lat: number; lon: number },
    departureTime: string,
): Promise<void> {
    // Increment generation to abort any previous precomputation
    const gen = ++_abortGen;
    _computing = true;
    _cache = null;

    try {
        console.info(
            `[Precompute] Starting background isochrone: ${dep.lat.toFixed(2)},${dep.lon.toFixed(2)} → ${arr.lat.toFixed(2)},${arr.lon.toFixed(2)}`,
        );

        // 1. Load wind data
        const { WindStore } = await import('../stores/WindStore');
        const { createWindFieldFromGrid } = await import('./weather/WindFieldAdapter');
        const { SmartPolarStore } = await import('./SmartPolarStore');
        const { DEFAULT_CRUISING_POLAR } = await import('./defaultPolar');
        const { preloadBathymetry } = await import('./BathymetryCache');
        const { computeIsochrones } = await import('./IsochroneRouter');

        if (gen !== _abortGen) return; // aborted

        const windGrid = WindStore.getState().grid;
        if (!windGrid) {
            console.info('[Precompute] No wind data cached — skipping');
            return;
        }

        const windField = createWindFieldFromGrid(windGrid);
        const polar = SmartPolarStore.exportToPolarData() ?? DEFAULT_CRUISING_POLAR;

        // Use original coordinates directly (sea buoy gate finding removed)
        const R_NM = 3440.065;
        const dLat = ((arr.lat - dep.lat) * Math.PI) / 180;
        const dLon = ((arr.lon - dep.lon) * Math.PI) / 180;
        const φ1 = (dep.lat * Math.PI) / 180;
        const φ2 = (arr.lat * Math.PI) / 180;
        const a = Math.sin(dLat / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLon / 2) ** 2;
        const straightNM = R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        const isShortRoute = straightNM < 100;

        const depGate = dep;
        const arrGate = arr;

        if (gen !== _abortGen) return;

        // 3. Preload bathymetry
        const bathyGrid = await preloadBathymetry(depGate, arrGate);
        if (gen !== _abortGen) return;

        // 4. Run isochrone
        const minDepthM = isShortRoute ? 3.5 : null; // draft+1m for coastal
        const isoResult = await computeIsochrones(
            depGate,
            arrGate,
            departureTime,
            polar,
            windField,
            minDepthM != null ? { minDepthM } : {},
            bathyGrid,
        );

        if (gen !== _abortGen) return;

        if (isoResult && isoResult.routeCoordinates.length >= 2) {
            _cache = {
                depLat: depGate.lat,
                depLon: depGate.lon,
                arrLat: arrGate.lat,
                arrLon: arrGate.lon,
                result: isoResult,
                computedAt: Date.now(),
            };
            console.info(
                `[Precompute] ✓ Route cached: ${isoResult.totalDistanceNM} NM, ${isoResult.totalDurationHours}h`,
            );
        } else {
            console.info('[Precompute] No route found');
        }
    } catch (err) {
        console.warn('[Precompute] Background isochrone failed:', err);
    } finally {
        if (gen === _abortGen) _computing = false;
    }
}

/** Whether a precomputation is currently in progress. */
export function isPrecomputing(): boolean {
    return _computing;
}
