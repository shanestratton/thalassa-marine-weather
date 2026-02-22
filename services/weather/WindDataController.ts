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

import type mapboxgl from 'mapbox-gl';
import { fetchWindGrid, fetchGlobalWindField, type WindGrid } from './windField';
import { loadLocalWindFile } from './GribWindParser';
import { WindStore } from '../../stores/WindStore';

// ── Bounds Cache (avoid redundant re-fetches) ──

interface CachedBounds {
    north: number;
    south: number;
    west: number;
    east: number;
    zoom: number;
}

let lastFetchedBounds: CachedBounds | null = null;

function boundsChangedSignificantly(a: CachedBounds, b: CachedBounds): boolean {
    // Re-fetch if view shifted by more than 20% or zoom changed by >1
    const latSpan = a.north - a.south;
    const lonSpan = a.east - a.west;
    const latShift = Math.abs(a.north - b.north) + Math.abs(a.south - b.south);
    const lonShift = Math.abs(a.east - b.east) + Math.abs(a.west - b.west);
    const zoomDiff = Math.abs(a.zoom - b.zoom);

    return (latShift / latSpan > 0.4) || (lonShift / lonSpan > 0.4) || (zoomDiff > 1);
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
        const { isGlobalMode } = WindStore.getState();

        if (isGlobalMode) {
            // Global mode: fetch full-earth GRIB once, no re-fetching on pan
            clearMoveListener(map);
            await this.fetchOnline(map);
        } else {
            // Passage mode: fetch for visible viewport, re-fetch on pan
            await this.fetchOnline(map);
            this.registerMoveListener(map);
        }
    },

    /**
     * Deactivate: remove map listeners, clear state.
     */
    deactivate(map: mapboxgl.Map) {
        clearMoveListener(map);
        lastFetchedBounds = null;
    },

    /**
     * Online pipeline: fetch wind grid for visible map bounds.
     * In global mode, always fetches the full Earth grid.
     * In passage mode, fetches for the visible viewport.
     */
    async fetchOnline(map: mapboxgl.Map) {
        const { isGlobalMode } = WindStore.getState();
        const bounds = map.getBounds();
        if (!bounds) return;

        const currentZoom = map.getZoom();

        // Global mode: always fetch the full Earth grid regardless of zoom
        if (isGlobalMode) {
            WindStore.setLoading(true);
            console.log(`[WindController] Global mode (zoom ${currentZoom.toFixed(1)})`);

            try {
                const grid = await fetchGlobalWindField();

                if (!grid) {
                    WindStore.setError('No global wind data available');
                    return;
                }

                lastFetchedBounds = {
                    north: 85, south: -85, west: -180, east: 180, zoom: currentZoom,
                };
                WindStore.setGrid(grid);
                console.log(`[WindController] Global grid: ${grid.width}×${grid.height}, ${grid.totalHours}h`);
            } catch (e) {
                console.error('[WindController] Global fetch failed:', e);
                WindStore.setError(`Failed to fetch global wind data: ${e instanceof Error ? e.message : 'Unknown error'}`);
            }
            return;
        }

        // Passage mode: fetch for visible bounds only
        const currentBounds: CachedBounds = {
            north: Math.min(bounds.getNorth(), 85),
            south: Math.max(bounds.getSouth(), -85),
            west: bounds.getWest(),
            east: bounds.getEast(),
            zoom: currentZoom,
        };

        // Skip if bounds haven't changed significantly
        if (lastFetchedBounds && !boundsChangedSignificantly(lastFetchedBounds, currentBounds)) {
            return;
        }

        WindStore.setLoading(true);
        console.log(`[WindController] Fetching online: ${currentBounds.south.toFixed(1)}°–${currentBounds.north.toFixed(1)}°, zoom ${currentBounds.zoom.toFixed(1)}`);

        try {
            const grid = await fetchWindGrid(
                currentBounds.north,
                currentBounds.south,
                currentBounds.west,
                currentBounds.east,
                currentBounds.zoom
            );

            if (!grid) {
                WindStore.setError('No wind data available for this area');
                return;
            }

            lastFetchedBounds = currentBounds;
            WindStore.setGrid(grid);
            console.log(`[WindController] Online grid: ${grid.width}×${grid.height}, ${grid.totalHours}h`);
        } catch (e) {
            console.error('[WindController] Online fetch failed:', e);
            WindStore.setError(`Failed to fetch wind data: ${e instanceof Error ? e.message : 'Unknown error'}`);
        }
    },

    /**
     * Offline pipeline: load pre-parsed .wind.bin from device storage.
     */
    async fetchOffline() {
        const { localGribPath } = WindStore.getState();

        if (!localGribPath) {
            WindStore.setError('No downloaded wind data available. Use the GRIB downloader to get passage wind data.');
            return;
        }

        WindStore.setLoading(true);
        console.log(`[WindController] Loading offline: ${localGribPath}`);

        try {
            const grid = await loadLocalWindFile(localGribPath);
            WindStore.setGrid(grid);
            console.log(`[WindController] Offline grid: ${grid.width}×${grid.height}, bounds: ${grid.south}°–${grid.north}° / ${grid.west}°–${grid.east}°`);
        } catch (e) {
            console.error('[WindController] Offline load failed:', e);
            WindStore.setError(`Failed to load wind file: ${e instanceof Error ? e.message : 'Unknown error'}`);
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
                const { isGlobalMode } = WindStore.getState();
                if (isGlobalMode) return; // Don't re-fetch in global mode
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
