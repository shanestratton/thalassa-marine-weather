/**
 * useSeaIceRasterLayer — mounts the SeaIceRasterLayer for CMEMS
 * sea-ice concentration data.
 *
 * Sister hook to useChlRasterLayer / useSstRasterLayer. Same lifecycle
 * pattern (lazy fetch on first visibility, single layer on the map,
 * step-index swap when scrubber moves) — the only differences are the
 * data source URL and the layer class.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { SeaIceRasterLayer } from './SeaIceRasterLayer';
import { fetchSeaIceGrid } from '../../services/weather/api/seaiceGrid';
import type { WindGrid } from '../../services/weather/windField';

const log = createLogger('SeaIceRasterLayer');

const LAYER_ID = 'cmems-seaice-raster';
const FEATURE_ENABLED = String(import.meta.env.VITE_CMEMS_SEAICE_ENABLED ?? 'false').toLowerCase() === 'true';

export function useSeaIceRasterLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastStep: number = 0,
) {
    const layerRef = useRef<SeaIceRasterLayer | null>(null);
    const currentStepRef = useRef(-1);
    const inflightRef = useRef(false);
    const attemptedRef = useRef(false);
    const [grid, setGrid] = useState<WindGrid | null>(null);

    // Lazy-load the grid the first time sea-ice becomes visible.
    useEffect(() => {
        if (!FEATURE_ENABLED) return;
        if (!visible) {
            attemptedRef.current = false;
            return;
        }
        if (grid || inflightRef.current || attemptedRef.current) return;

        let cancelled = false;
        inflightRef.current = true;
        attemptedRef.current = true;
        fetchSeaIceGrid()
            .then((g) => {
                inflightRef.current = false;
                if (cancelled) return;
                if (!g) {
                    log.warn('Sea-ice grid unavailable — giving up until next toggle');
                    return;
                }
                log.info(`Sea-ice grid cached (${g.totalHours} days × ${g.width}×${g.height})`);
                currentStepRef.current = -1;
                setGrid(g);
            })
            .catch((err) => {
                inflightRef.current = false;
                log.warn('Failed to load sea-ice grid', err);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, grid]);

    // Mount / update / unmount the layer based on visibility + data.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (!FEATURE_ENABLED) {
            if (visible) log.info('gated off — VITE_CMEMS_SEAICE_ENABLED=false');
            return;
        }

        if (!visible) {
            if (layerRef.current && map.getLayer(LAYER_ID)) {
                try {
                    map.removeLayer(LAYER_ID);
                } catch {
                    /* best effort */
                }
            }
            layerRef.current = null;
            currentStepRef.current = -1;
            return;
        }

        if (!grid) return;
        if (!grid.landMask) {
            log.warn('Sea-ice grid has no land mask (v1 binary?) — skipping draw');
            return;
        }

        const wantsStep = Math.min(Math.max(0, Math.round(forecastStep)), grid.totalHours - 1);

        if (!layerRef.current) {
            try {
                const layer = new SeaIceRasterLayer(LAYER_ID);
                map.addLayer(layer);
                layerRef.current = layer;
                currentStepRef.current = -1;
                log.info(`Mounted sea-ice raster layer (id=${LAYER_ID})`);
            } catch (err) {
                log.warn('Failed to mount sea-ice layer', err);
                return;
            }
        }

        if (currentStepRef.current !== wantsStep) {
            try {
                // siconc fraction [0,1] is packed into u-channel by the
                // pipeline (v-channel is zero).
                const concentration = grid.u[wantsStep];
                layerRef.current.setData(
                    concentration,
                    grid.width,
                    grid.height,
                    {
                        north: grid.north,
                        south: grid.south,
                        east: grid.east,
                        west: grid.west,
                    },
                    grid.landMask,
                );
                currentStepRef.current = wantsStep;
                map.triggerRepaint();
                const dayLabel = grid.hourOffsets?.[wantsStep]
                    ? `T+${grid.hourOffsets[wantsStep]}h`
                    : `step ${wantsStep}`;
                log.info(`Sea-ice step swapped to ${dayLabel}`);
            } catch (err) {
                log.warn('Failed to set sea-ice data', err);
            }
        }
    }, [mapRef, mapReady, visible, forecastStep, grid]);

    // Unmount cleanup.
    useEffect(() => {
        return () => {
            const map = mapRef.current;
            if (!map) return;
            try {
                if (layerRef.current && map.getLayer(LAYER_ID)) {
                    map.removeLayer(LAYER_ID);
                }
            } catch {
                /* best effort */
            }
            layerRef.current = null;
        };
    }, [mapRef]);
}

/** Exposed so the legend / radial menu can check the flag state. */
export function isCmemsSeaIceEnabled(): boolean {
    return FEATURE_ENABLED;
}
