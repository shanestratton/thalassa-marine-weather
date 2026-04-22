/**
 * useMldRasterLayer — mounts the MldRasterLayer for CMEMS
 * mixed-layer-depth data.
 *
 * Sister hook to useChlRasterLayer / useSeaIceRasterLayer / useSstRasterLayer.
 * Same lifecycle pattern (lazy fetch on first visibility, single layer
 * on the map, step-index swap when scrubber moves) — the only
 * differences are the data source URL and the layer class.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { MldRasterLayer } from './MldRasterLayer';
import { fetchMldGrid } from '../../services/weather/api/mldGrid';
import type { WindGrid } from '../../services/weather/windField';

const log = createLogger('MldRasterLayer');

const LAYER_ID = 'cmems-mld-raster';
const FEATURE_ENABLED = String(import.meta.env.VITE_CMEMS_MLD_ENABLED ?? 'false').toLowerCase() === 'true';

export function useMldRasterLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastStep: number = 0,
) {
    const layerRef = useRef<MldRasterLayer | null>(null);
    const currentStepRef = useRef(-1);
    const inflightRef = useRef(false);
    const attemptedRef = useRef(false);
    const [grid, setGrid] = useState<WindGrid | null>(null);

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
        fetchMldGrid()
            .then((g) => {
                inflightRef.current = false;
                if (cancelled) return;
                if (!g) {
                    log.warn('MLD grid unavailable — giving up until next toggle');
                    return;
                }
                log.info(`MLD grid cached (${g.totalHours} days × ${g.width}×${g.height})`);
                currentStepRef.current = -1;
                setGrid(g);
            })
            .catch((err) => {
                inflightRef.current = false;
                log.warn('Failed to load MLD grid', err);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, grid]);

    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (!FEATURE_ENABLED) {
            if (visible) log.info('gated off — VITE_CMEMS_MLD_ENABLED=false');
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
            log.warn('MLD grid has no land mask (v1 binary?) — skipping draw');
            return;
        }

        const wantsStep = Math.min(Math.max(0, Math.round(forecastStep)), grid.totalHours - 1);

        if (!layerRef.current) {
            try {
                const layer = new MldRasterLayer(LAYER_ID);
                map.addLayer(layer);
                layerRef.current = layer;
                currentStepRef.current = -1;
                log.info(`Mounted MLD raster layer (id=${LAYER_ID})`);
            } catch (err) {
                log.warn('Failed to mount MLD layer', err);
                return;
            }
        }

        if (currentStepRef.current !== wantsStep) {
            try {
                // Pre-normalised log10(MLD) ∈ [0,1] is packed into the
                // u-channel by the pipeline (v-channel is zero).
                const mldNormalised = grid.u[wantsStep];
                layerRef.current.setData(
                    mldNormalised,
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
                log.info(`MLD step swapped to ${dayLabel}`);
            } catch (err) {
                log.warn('Failed to set MLD data', err);
            }
        }
    }, [mapRef, mapReady, visible, forecastStep, grid]);

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
export function isCmemsMldEnabled(): boolean {
    return FEATURE_ENABLED;
}
