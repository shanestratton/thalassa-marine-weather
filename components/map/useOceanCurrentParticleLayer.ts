/**
 * useOceanCurrentParticleLayer — Mapbox GL JS native `raster-particle` layer
 * fed by CMEMS surface-currents data (uo/vo components) uploaded to Mapbox
 * Tiling Service by `scripts/cmems-currents-pipeline/pipeline.py`.
 *
 * Renders animated particle flow GPU-side — same approach as Mapbox's
 * reference GFS winds example, zero custom WebGL.
 *
 * Source of truth for the licence attribution is scripts/cmems-currents-pipeline/README.md;
 * the `SourceLegend` component surfaces the chip whenever this layer is visible.
 *
 * Feature flag: controlled by VITE_CMEMS_CURRENTS_ENABLED so the layer
 * stays behind a gate until the MTS tileset has been populated by the
 * daily pipeline.
 */

import { useEffect, useRef } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('CurrentParticleLayer');

// ── Layer/Source IDs ──
const SOURCE_ID = 'cmems-currents-source';
const PARTICLE_LAYER_ID = 'cmems-currents-particles';
const MAGNITUDE_LAYER_ID = 'cmems-currents-magnitude';

// Prefetch source: mounted as a tiny invisible layer so Mapbox starts
// downloading tiles for the next forecast hour in the background. When
// the user scrubs to that hour the swap is instant.
const PREFETCH_SOURCE_ID = 'cmems-currents-prefetch-source';
const PREFETCH_LAYER_ID = 'cmems-currents-prefetch';

// ── Config ──
// One tileset per forecast hour — pipeline.py publishes h00..h47.
const MAPBOX_USERNAME = import.meta.env.VITE_MAPBOX_USERNAME ?? 'thalassa';
const TILESET_PREFIX = 'thalassa-currents';
const MAX_FORECAST_HOUR = 47;

const FEATURE_ENABLED = String(import.meta.env.VITE_CMEMS_CURRENTS_ENABLED ?? 'false').toLowerCase() === 'true';

function tilesetUrlForHour(hour: number): string {
    const h = Math.min(Math.max(0, Math.round(hour)), MAX_FORECAST_HOUR);
    const hh = h.toString().padStart(2, '0');
    return `mapbox://${MAPBOX_USERNAME}.${TILESET_PREFIX}-h${hh}`;
}

/**
 * Mount a CMEMS ocean-currents particle layer.
 *
 * @param mapRef       - mapbox-gl map instance ref
 * @param mapReady     - has the map loaded its initial style?
 * @param visible      - is the user currently viewing currents?
 * @param forecastHour - 0..47, scrubbed via the SynopticScrubber
 */
export function useOceanCurrentParticleLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastHour: number = 0,
) {
    const currentHourRef = useRef<number>(-1);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (!FEATURE_ENABLED) {
            if (visible) {
                log.info('CMEMS currents gated off (VITE_CMEMS_CURRENTS_ENABLED=false)');
            }
            return;
        }

        const wantsHour = Math.min(Math.max(0, Math.round(forecastHour)), MAX_FORECAST_HOUR);

        // Error handler — if a specific forecast hour hasn't published yet
        // (MTS processing queue is slow), Mapbox fires a 'source' error.
        // Quietly tear down so the scrubber can still move; user sees blank.
        // `ErrorEvent` in mapbox-gl types doesn't expose sourceId on the
        // public interface, but the runtime does emit it — so we cast.
        const handleError = (e: unknown) => {
            const sourceId = (e as { sourceId?: string } | null)?.sourceId;
            if (sourceId !== SOURCE_ID) return;
            const status = (e as { error?: { status?: number } } | null)?.error?.status;
            log.warn(`CMEMS source error (h+${currentHourRef.current}, status=${status ?? '?'}) — removing`);
            removeLayers(map);
            currentHourRef.current = -1;
        };
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        map.on('error', handleError as any);

        // Swap source URL on forecast-hour change
        if (visible && currentHourRef.current !== wantsHour) {
            try {
                // Mapbox has no setUrl() for raster-array — tear down + re-add.
                removeLayers(map);
                addLayers(map, wantsHour);
                currentHourRef.current = wantsHour;
                log.info(`Mounted currents h+${wantsHour}`);
            } catch (err) {
                log.warn('Failed to mount currents layer', err);
            }
        }

        if (!visible && currentHourRef.current !== -1) {
            removeLayers(map);
            removePrefetch(map);
            currentHourRef.current = -1;
            log.info('Removed currents layer');
        }

        // Warm the next forecast hour in the background so scrubbing feels
        // instant. Only when visible + not at the tail of the forecast.
        if (visible && wantsHour < MAX_FORECAST_HOUR) {
            mountPrefetch(map, wantsHour + 1);
        } else {
            removePrefetch(map);
        }

        return () => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            map.off('error', handleError as any);
        };
    }, [mapRef, mapReady, visible, forecastHour]);

    // Unmount cleanup
    useEffect(() => {
        return () => {
            const map = mapRef.current;
            if (!map) return;
            removeLayers(map);
            removePrefetch(map);
        };
    }, [mapRef]);
}

// ── Prefetch helpers (warm next forecast hour) ──

const prefetchHourRef: { current: number } = { current: -1 };

function mountPrefetch(map: mapboxgl.Map, hour: number): void {
    if (prefetchHourRef.current === hour && map.getSource(PREFETCH_SOURCE_ID)) return;
    removePrefetch(map);
    try {
        map.addSource(PREFETCH_SOURCE_ID, {
            type: 'raster-array',
            url: tilesetUrlForHour(hour),
            tileSize: 512,
        } as unknown as mapboxgl.SourceSpecification);
        // Transparent raster layer → forces Mapbox to fetch tiles but
        // nothing draws. raster-particle sources only load tiles when a
        // layer references them, so we can't skip the layer entirely.
        map.addLayer({
            id: PREFETCH_LAYER_ID,
            type: 'raster',
            source: PREFETCH_SOURCE_ID,
            'source-layer': 'currents',
            paint: { 'raster-opacity': 0 },
        });
        prefetchHourRef.current = hour;
        log.info(`Prefetching currents h+${hour}`);
    } catch (err) {
        log.warn('prefetch mount failed', err);
    }
}

function removePrefetch(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(PREFETCH_LAYER_ID)) map.removeLayer(PREFETCH_LAYER_ID);
    } catch {
        /* best effort */
    }
    try {
        if (map.getSource(PREFETCH_SOURCE_ID)) map.removeSource(PREFETCH_SOURCE_ID);
    } catch {
        /* best effort */
    }
    prefetchHourRef.current = -1;
}

// ── Layer management helpers ──

function addLayers(map: mapboxgl.Map, hour: number): void {
    if (!map.getSource(SOURCE_ID)) {
        // `raster-array` is the source type that ships u/v bands as MRT.
        // Types not yet in @types/mapbox-gl as of 3.18, hence the cast.
        map.addSource(SOURCE_ID, {
            type: 'raster-array',
            url: tilesetUrlForHour(hour),
            tileSize: 512,
        } as unknown as mapboxgl.SourceSpecification);
    }

    // Magnitude underlay — colorscale of |u,v|. Subtle: the particles tell
    // the direction story; this is just a "is it fast here?" backdrop.
    if (!map.getLayer(MAGNITUDE_LAYER_ID)) {
        map.addLayer({
            id: MAGNITUDE_LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            'source-layer': 'currents',
            paint: {
                'raster-opacity': 0.35,
                // Color by magnitude — sqrt(u^2 + v^2). Expression form requires mapbox-gl >=3.3.
                'raster-color': [
                    'interpolate',
                    ['linear'],
                    ['raster-value'],
                    0.0,
                    'rgba(30, 58, 95, 0.0)',
                    0.25,
                    'rgba(6, 182, 212, 0.35)',
                    0.5,
                    'rgba(234, 179, 8, 0.5)',
                    1.0,
                    'rgba(249, 115, 22, 0.7)',
                    2.0,
                    'rgba(239, 68, 68, 0.85)',
                ],
                'raster-color-mix': [1, 1, 0, 0], // |uo| + |vo| approx for underlay
                'raster-color-range': [0, 2],
            },
        });
    }

    if (!map.getLayer(PARTICLE_LAYER_ID)) {
        map.addLayer({
            id: PARTICLE_LAYER_ID,
            type: 'raster-particle' as unknown as 'raster',
            source: SOURCE_ID,
            'source-layer': 'currents',
            paint: {
                'raster-particle-count': 2048, // mobile-friendly default; desktop can push to 4096
                'raster-particle-max-speed': 2, // m/s — tune once we see real data
                'raster-particle-speed-factor': 0.4,
                'raster-particle-fade-opacity-factor': 0.95,
                'raster-particle-reset-rate-factor': 0.6,
                'raster-particle-color': [
                    'interpolate',
                    ['linear'],
                    ['raster-particle-speed'],
                    0.0,
                    '#cffafe', // near-stationary — pale cyan
                    0.25,
                    '#22d3ee',
                    0.5,
                    '#eab308',
                    1.0,
                    '#f97316',
                    2.0,
                    '#ef4444', // rip — red
                ],
            },
        });
    }
}

function removeLayers(map: mapboxgl.Map): void {
    for (const id of [PARTICLE_LAYER_ID, MAGNITUDE_LAYER_ID]) {
        try {
            if (map.getLayer(id)) map.removeLayer(id);
        } catch {
            /* best effort */
        }
    }
    try {
        if (map.getSource(SOURCE_ID)) map.removeSource(SOURCE_ID);
    } catch {
        /* best effort */
    }
}

/** Exposed so the legend component can check whether to show attribution. */
export function isCmemsCurrentsEnabled(): boolean {
    return FEATURE_ENABLED;
}
