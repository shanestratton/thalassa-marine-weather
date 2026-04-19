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

// ── Live-debug state mirror ────────────────────────────────────────────
// Production builds strip `console.*` via esbuild.drop, so any log path
// we add is silently gone. Instead, mirror lifecycle events onto window
// so a human in DevTools can read back exactly what the hook did. Runs
// in all environments — tiny cost, pays for itself the first time prod
// misbehaves in a way that doesn't repro locally.
interface CurrentsDebugMirror {
    featureEnabled: boolean;
    visible: boolean;
    hasGrid: boolean;
    gridDims: string | null;
    currentHour: number;
    layerMounted: boolean;
    mountCount: number;
    teardownCount: number;
    setDataCount: number;
    fetchCount: number;
    fetchErrors: number;
    lastEvent: string;
    lastEventAt: number;
}
const getDebug = (): CurrentsDebugMirror => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (!g.__thalassaDebug) g.__thalassaDebug = {};
    if (!g.__thalassaDebug.currents) {
        g.__thalassaDebug.currents = {
            featureEnabled: FEATURE_ENABLED,
            visible: false,
            hasGrid: false,
            gridDims: null,
            currentHour: -1,
            layerMounted: false,
            mountCount: 0,
            teardownCount: 0,
            setDataCount: 0,
            fetchCount: 0,
            fetchErrors: 0,
            lastEvent: 'init',
            lastEventAt: Date.now(),
        } satisfies CurrentsDebugMirror;
    }
    return g.__thalassaDebug.currents as CurrentsDebugMirror;
};
const noteEvent = (ev: string, patch: Partial<CurrentsDebugMirror> = {}) => {
    const d = getDebug();
    Object.assign(d, patch, { lastEvent: ev, lastEventAt: Date.now() });
};

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
    const currentHourRef = useRef(-1);
    // Refs (not state) for the fetch *lifecycle* — state churn inside the
    // effect callback was re-firing the effect on every failure, producing
    // a 403 retry storm in prod. `attempted` becomes the one-shot latch;
    // the user can retry by toggling the layer off then back on.
    const inflightRef = useRef(false);
    const attemptedRef = useRef(false);
    // Grid itself DOES go in state so the mount-effect below re-fires the
    // moment it loads — otherwise the effect's static dep list means the
    // layer only mounts after some unrelated re-render (scrub, toggle),
    // producing a "flashes on interaction then vanishes" bug.
    const [grid, setGrid] = useState<WindGrid | null>(null);

    // Lazy-load the grid the first time currents becomes visible. Reset the
    // latch when visibility goes false→true so the user can retry manually.
    useEffect(() => {
        noteEvent('fetch-effect-enter', { visible });
        if (!FEATURE_ENABLED) return;
        if (!visible) {
            // Hidden again — allow a fresh attempt next time we turn on.
            attemptedRef.current = false;
            return;
        }
        if (grid || inflightRef.current || attemptedRef.current) return;

        let cancelled = false;
        inflightRef.current = true;
        attemptedRef.current = true;
        const d = getDebug();
        d.fetchCount += 1;
        noteEvent('fetch-start');
        fetchCurrentsGrid()
            .then((g) => {
                inflightRef.current = false;
                if (cancelled) {
                    noteEvent('fetch-cancelled');
                    return;
                }
                if (!g) {
                    noteEvent('fetch-null-grid');
                    getDebug().fetchErrors += 1;
                    log.warn('Currents grid unavailable — giving up until next toggle');
                    return;
                }
                log.info(`Currents grid cached (${g.totalHours}h × ${g.width}×${g.height})`);
                currentHourRef.current = -1;
                noteEvent('fetch-success', { hasGrid: true, gridDims: `${g.totalHours}h × ${g.width}×${g.height}` });
                setGrid(g);
            })
            .catch((err) => {
                inflightRef.current = false;
                getDebug().fetchErrors += 1;
                noteEvent('fetch-error');
                log.warn('Failed to load currents grid', err);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, grid]);

    // Mount / update / unmount the custom layer based on visibility.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) {
            noteEvent('mount-effect-skip-no-map');
            return;
        }

        if (!FEATURE_ENABLED) {
            if (visible) log.info('gated off — VITE_CMEMS_CURRENTS_ENABLED=false');
            return;
        }

        noteEvent('mount-effect-enter', { visible, hasGrid: !!grid });

        // Tear down when hidden.
        if (!visible) {
            if (layerRef.current && map.getLayer(LAYER_ID)) {
                try {
                    map.removeLayer(LAYER_ID);
                    getDebug().teardownCount += 1;
                    noteEvent('layer-torn-down', { layerMounted: false });
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
                getDebug().mountCount += 1;
                noteEvent('layer-mounted', { layerMounted: true });
                log.info(`Mounted currents particle layer (id=${LAYER_ID})`);
            } catch (err) {
                noteEvent('layer-mount-failed');
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
                getDebug().setDataCount += 1;
                noteEvent('set-data', { currentHour: wantsHour });
                map.triggerRepaint();
                log.info(`Currents hour swapped to h+${wantsHour}`);
            } catch (err) {
                noteEvent('set-data-failed');
                log.warn('Failed to set currents data', err);
            }
        }
    }, [mapRef, mapReady, visible, forecastHour, grid]);

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
        };
    }, [mapRef]);
}

/** Exposed so the legend / attribution chip can check the flag state. */
export function isCmemsCurrentsEnabled(): boolean {
    return FEATURE_ENABLED;
}
