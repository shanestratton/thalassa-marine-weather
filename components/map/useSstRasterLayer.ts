/**
 * useSstRasterLayer — mounts the scalar SstRasterLayer for CMEMS
 * sea-surface-temperature data.
 *
 * Sister hook to useOceanCurrentParticleLayer / useOceanWaveParticleLayer,
 * but significantly simpler because SST is a scalar field:
 *   – No particle advection, no spawn CDF, no antimeridian wrap reset,
 *     no per-frame CPU work at all. The heatmap is the whole story.
 *   – No continuous animation — the layer only needs to re-draw when
 *     the data changes (scrubber step) or the camera moves.
 *   – Still uses the same fetch → binary → v2 THCU grid shape; the
 *     pipeline packs temperature °C into the u-channel and we extract
 *     u[stepIdx] as the data plane.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { SstRasterLayer } from './SstRasterLayer';
import { fetchSstGrid } from '../../services/weather/api/sstGrid';
import type { WindGrid } from '../../services/weather/windField';

const log = createLogger('SstRasterLayer');

const LAYER_ID = 'cmems-sst-raster';
const FEATURE_ENABLED = String(import.meta.env.VITE_CMEMS_SST_ENABLED ?? 'false').toLowerCase() === 'true';

export function useSstRasterLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastStep: number = 0,
) {
    const layerRef = useRef<SstRasterLayer | null>(null);
    const currentStepRef = useRef(-1);
    const inflightRef = useRef(false);
    const attemptedRef = useRef(false);
    const [grid, setGrid] = useState<WindGrid | null>(null);

    // Lazy-load the grid the first time SST becomes visible.
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
        fetchSstGrid()
            .then((g) => {
                inflightRef.current = false;
                if (cancelled) return;
                if (!g) {
                    log.warn('SST grid unavailable — giving up until next toggle');
                    return;
                }
                log.info(`SST grid cached (${g.totalHours} days × ${g.width}×${g.height})`);
                currentStepRef.current = -1;
                setGrid(g);
            })
            .catch((err) => {
                inflightRef.current = false;
                log.warn('Failed to load SST grid', err);
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
            if (visible) log.info('gated off — VITE_CMEMS_SST_ENABLED=false');
            return;
        }

        // Teardown when hidden.
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
            log.warn('SST grid has no land mask (v1 binary?) — skipping draw');
            return;
        }

        const wantsStep = Math.min(Math.max(0, Math.round(forecastStep)), grid.totalHours - 1);

        if (!layerRef.current) {
            try {
                const layer = new SstRasterLayer(LAYER_ID);
                map.addLayer(layer);
                layerRef.current = layer;
                currentStepRef.current = -1;
                log.info(`Mounted SST raster layer (id=${LAYER_ID})`);
            } catch (err) {
                log.warn('Failed to mount SST layer', err);
                return;
            }
        }

        if (currentStepRef.current !== wantsStep) {
            try {
                // Temperature °C is packed into the u-channel by the
                // pipeline (v-channel is zero). Extract it directly.
                const temp = grid.u[wantsStep];
                layerRef.current.setData(
                    temp,
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
                log.info(`SST step swapped to ${dayLabel}`);
            } catch (err) {
                log.warn('Failed to set SST data', err);
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

/** Exposed so the legend / attribution chip can check the flag state. */
export function isCmemsSstEnabled(): boolean {
    return FEATURE_ENABLED;
}
