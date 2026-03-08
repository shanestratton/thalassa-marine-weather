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
     * Online pipeline: fetch wind grid via Supabase GFS GRIB2 edge function.
     * In global mode, always fetches the full Earth grid.
     * In passage mode, fetches for the visible viewport.
     */
    async fetchOnline(map: mapboxgl.Map) {
        const { isGlobalMode } = WindStore.getState();
        const bounds = map.getBounds();
        if (!bounds) return;

        const currentZoom = map.getZoom();

        // Determine bounds for the request
        let north: number, south: number, west: number, east: number;

        if (isGlobalMode) {
            north = 90; south = -90; west = -180; east = 180;
        } else {
            // Passage mode: visible viewport with padding
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

            // Add 30% padding
            const latPad = (currentBounds.north - currentBounds.south) * 0.3;
            const lonPad = (currentBounds.east - currentBounds.west) * 0.3;
            north = Math.min(currentBounds.north + latPad, 90);
            south = Math.max(currentBounds.south - latPad, -90);
            west = currentBounds.west - lonPad;
            east = currentBounds.east + lonPad;
        }

        WindStore.setLoading(true);

        try {
            // Primary: Supabase GFS GRIB2 edge function (reliable)
            const supabaseUrl = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_URL)
                || 'https://pcisdplnodrphauixcau.supabase.co';
            const supabaseKey = (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_KEY) || '';
            const edgeUrl = `${supabaseUrl}/functions/v1/fetch-wind-grid`;

            const res = await fetch(edgeUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(supabaseKey ? {
                        'apikey': supabaseKey,
                        'Authorization': `Bearer ${supabaseKey}`,
                    } : {}),
                },
                body: JSON.stringify({ north, south, east, west }),
            });

            if (res.ok) {
                const buffer = await res.arrayBuffer();
                if (buffer.byteLength > 200) {
                    const { decodeGrib2WindMultiHour } = await import('./decodeGrib2Wind');
                    const grid = decodeGrib2WindMultiHour(buffer);

                    lastFetchedBounds = {
                        north, south, west, east, zoom: currentZoom,
                    };
                    WindStore.setGrid(grid);
                    console.info(`[WindController] GFS GRIB loaded: ${grid.width}×${grid.height}, ${grid.totalHours} forecast hours`);
                    return;
                }
            }

            // If edge function failed, fall back to Open-Meteo
            console.warn('[WindController] Edge function failed, trying Open-Meteo fallback');
            const fallbackGrid = isGlobalMode
                ? await fetchGlobalWindField()
                : await fetchWindGrid(north, south, west, east, currentZoom);

            if (fallbackGrid) {
                lastFetchedBounds = { north, south, west, east, zoom: currentZoom };
                WindStore.setGrid(fallbackGrid);
            } else {
                WindStore.setError('No wind data available');
            }
        } catch (e) {
            console.error('[WindController] Fetch failed:', e);
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

        try {
            const grid = await loadLocalWindFile(localGribPath);
            WindStore.setGrid(grid);
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
