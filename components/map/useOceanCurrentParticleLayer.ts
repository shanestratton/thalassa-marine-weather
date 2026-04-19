/**
 * useOceanCurrentParticleLayer — Custom WebGL particle layer for CMEMS
 * ocean-currents data, fetched as binary blobs from a daily GitHub
 * Release asset. Reuses the existing WindParticleLayer engine so the
 * render pipeline, camera projection and GPU memory management match
 * the battle-tested wind layer — only the data source differs.
 *
 * Design notes:
 *   - Binary blobs are produced by scripts/cmems-currents-pipeline/pipeline.py
 *     and attached to release `cmems-currents-latest` (one .bin per hour).
 *   - The first-use fetch loads 13 hours × ~2 MB = ~25 MB upfront; the
 *     scrubber then swaps the layer's single-timestep data on each hour
 *     change (no further network traffic).
 *   - Gated by VITE_CMEMS_CURRENTS_ENABLED so the existing Xweather
 *     raster-currents layer remains the default fallback.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { WindParticleLayer } from './WindParticleLayer';
import { fetchCurrentsGrid } from '../../services/weather/api/currentsGrid';
import type { WindGrid } from '../../services/weather/windField';

const log = createLogger('CurrentParticleLayer');

const LAYER_ID = 'cmems-currents-particles';
const FEATURE_ENABLED = String(import.meta.env.VITE_CMEMS_CURRENTS_ENABLED ?? 'false').toLowerCase() === 'true';

/**
 * Mount a CMEMS ocean-currents particle layer.
 *
 * @param mapRef       mapbox-gl map instance ref
 * @param mapReady     has the map loaded its initial style?
 * @param visible      is the user currently viewing currents?
 * @param forecastHour 0..N-1 hourly index (clamped to available range)
 */
export function useOceanCurrentParticleLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastHour: number = 0,
) {
    const layerRef = useRef<WindParticleLayer | null>(null);
    const gridRef = useRef<WindGrid | null>(null);
    const currentHourRef = useRef(-1);
    const [loading, setLoading] = useState(false);

    // Lazy-load the grid the first time currents becomes visible.
    useEffect(() => {
        if (!FEATURE_ENABLED || !visible || gridRef.current || loading) return;
        let cancelled = false;
        setLoading(true);
        fetchCurrentsGrid()
            .then((grid) => {
                if (cancelled || !grid) {
                    setLoading(false);
                    return;
                }
                gridRef.current = grid;
                log.info(`Currents grid cached (${grid.totalHours}h × ${grid.width}×${grid.height})`);
                setLoading(false);
                // Force re-render of the effect below so the layer picks up the new grid
                currentHourRef.current = -1;
            })
            .catch((err) => {
                log.warn('Failed to load currents grid', err);
                setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, loading]);

    // Mount / update / unmount the custom layer based on visibility.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;

        if (!FEATURE_ENABLED) {
            if (visible) log.info('gated off — VITE_CMEMS_CURRENTS_ENABLED=false');
            return;
        }

        const grid = gridRef.current;

        // Tear down when hidden.
        if (!visible) {
            if (layerRef.current && map.getLayer(LAYER_ID)) {
                try {
                    map.removeLayer(LAYER_ID);
                } catch {
                    /* best effort */
                }
            }
            layerRef.current = null;
            currentHourRef.current = -1;
            return;
        }

        // Grid not loaded yet — the fetch effect will trigger a re-run.
        if (!grid) return;

        const wantsHour = Math.min(Math.max(0, Math.round(forecastHour)), grid.totalHours - 1);

        if (!layerRef.current) {
            try {
                const layer = new WindParticleLayer(LAYER_ID);
                map.addLayer(layer);
                layerRef.current = layer;
                currentHourRef.current = -1;
                log.info(`Mounted currents particle layer (id=${LAYER_ID})`);
            } catch (err) {
                log.warn('Failed to mount particle layer', err);
                return;
            }
        }

        if (currentHourRef.current !== wantsHour) {
            try {
                layerRef.current.setWindData(grid.u[wantsHour], grid.v[wantsHour], grid.width, grid.height, {
                    north: grid.north,
                    south: grid.south,
                    east: grid.east,
                    west: grid.west,
                });
                currentHourRef.current = wantsHour;
                map.triggerRepaint();
                log.info(`Currents hour swapped to h+${wantsHour}`);
            } catch (err) {
                log.warn('Failed to set currents data', err);
            }
        }
    }, [mapRef, mapReady, visible, forecastHour]);

    // Unmount cleanup
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
            gridRef.current = null;
        };
    }, [mapRef]);
}

/** Exposed so the legend / attribution chip can check the flag state. */
export function isCmemsCurrentsEnabled(): boolean {
    return FEATURE_ENABLED;
}
