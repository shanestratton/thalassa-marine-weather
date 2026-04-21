/**
 * useOceanWaveParticleLayer — Custom WebGL particle layer for CMEMS
 * ocean-waves data, fetched as binary blobs from a daily GitHub
 * Release asset.
 *
 * Backed by WaveParticleLayer (NOT WindParticleLayer) — the wind
 * layer's tuning made narrow swell features
 * invisible. The dedicated waves layer:
 *   - Speed-weights particle spawn so the EAC / Gulf Stream / ACC
 *     get particle density proportional to flow strength.
 *   - Uses a native m/s SPEED_FACTOR (no amplification hack).
 *   - Renders with a RIP/SLACK colour ramp (0.1 → 1.5 m/s).
 *   - Requires the v2 land mask so particles don't spawn on land.
 *
 * Design notes:
 *   - Binary blobs are produced by scripts/cmems-waves-pipeline/pipeline.py
 *     and attached to release `cmems-waves-latest` (one .bin per hour).
 *   - The first-use fetch loads 13 hours × ~9 MB = ~117 MB upfront; the
 *     scrubber then swaps the layer's single-timestep data on each hour
 *     change (no further network traffic).
 *   - Gated by VITE_CMEMS_WAVES_ENABLED so the existing Xweather
 *     raster-waves layer remains the default fallback.
 */

import { useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { WaveParticleLayer } from './WaveParticleLayer';
import { fetchWavesGrid } from '../../services/weather/api/wavesGrid';
import type { WindGrid } from '../../services/weather/windField';

const log = createLogger('WaveParticleLayer');

const LAYER_ID = 'cmems-waves-particles';
const FEATURE_ENABLED = String(import.meta.env.VITE_CMEMS_WAVES_ENABLED ?? 'false').toLowerCase() === 'true';

// ── Live-debug state mirror ────────────────────────────────────────────
// Production builds strip `console.*` via esbuild.drop, so any log path
// we add is silently gone. Instead, mirror lifecycle events onto window
// so a human in DevTools can read back exactly what the hook did. Runs
// in all environments — tiny cost, pays for itself the first time prod
// misbehaves in a way that doesn't repro locally.
interface WavesDebugMirror {
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
    /** Ring buffer of the last 40 effect runs + outcomes with timestamps.
     *  Readable via window.__thalassaDebug.waves.events to diagnose
     *  which upstream dep is flipping. */
    events: Array<{ t: number; ev: string; visible?: boolean; grid?: boolean; mapReady?: boolean }>;
}
const getDebug = (): WavesDebugMirror => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const g = globalThis as any;
    if (!g.__thalassaDebug) g.__thalassaDebug = {};
    if (!g.__thalassaDebug.waves) {
        g.__thalassaDebug.waves = {
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
            events: [],
        } satisfies WavesDebugMirror;
    }
    return g.__thalassaDebug.waves as WavesDebugMirror;
};
const noteEvent = (
    ev: string,
    patch: Partial<WavesDebugMirror> = {},
    extra: { visible?: boolean; grid?: boolean; mapReady?: boolean } = {},
) => {
    const d = getDebug();
    Object.assign(d, patch, { lastEvent: ev, lastEventAt: Date.now() });
    d.events.push({ t: Date.now(), ev, ...extra });
    // Cap ring size — keep most recent 40 events.
    if (d.events.length > 40) d.events.splice(0, d.events.length - 40);
};

/**
 * Mount a CMEMS ocean-waves particle layer.
 *
 * @param mapRef       mapbox-gl map instance ref
 * @param mapReady     has the map loaded its initial style?
 * @param visible      is the user currently viewing waves?
 * @param forecastHour 0..N-1 hourly index (clamped to available range)
 */
export function useOceanWaveParticleLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastHour: number = 0,
) {
    const layerRef = useRef<WaveParticleLayer | null>(null);
    const waveHourRef = useRef(-1);
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

    // Lazy-load the grid the first time waves becomes visible. Reset the
    // latch when visibility goes false→true so the user can retry manually.
    useEffect(() => {
        noteEvent('fetch-effect-enter', { visible }, { visible, grid: !!grid });
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
        fetchWavesGrid()
            .then((g) => {
                inflightRef.current = false;
                if (cancelled) {
                    noteEvent('fetch-cancelled');
                    return;
                }
                if (!g) {
                    noteEvent('fetch-null-grid');
                    getDebug().fetchErrors += 1;
                    log.warn('Waves grid unavailable — giving up until next toggle');
                    return;
                }
                log.info(`Waves grid cached (${g.totalHours}h × ${g.width}×${g.height})`);
                waveHourRef.current = -1;
                noteEvent('fetch-success', { hasGrid: true, gridDims: `${g.totalHours}h × ${g.width}×${g.height}` });
                setGrid(g);
            })
            .catch((err) => {
                inflightRef.current = false;
                getDebug().fetchErrors += 1;
                noteEvent('fetch-error');
                log.warn('Failed to load waves grid', err);
            });
        return () => {
            cancelled = true;
        };
    }, [visible, grid]);

    // Mount / update / unmount the custom layer based on visibility.
    useEffect(() => {
        const map = mapRef.current;
        const eventMeta = { visible, grid: !!grid, mapReady };
        if (!map || !mapReady) {
            noteEvent('mount-skip-no-map', {}, eventMeta);
            return;
        }

        if (!FEATURE_ENABLED) {
            if (visible) log.info('gated off — VITE_CMEMS_WAVES_ENABLED=false');
            return;
        }

        noteEvent('mount-effect-enter', { visible, hasGrid: !!grid }, eventMeta);

        // Tear down when hidden.
        if (!visible) {
            if (layerRef.current && map.getLayer(LAYER_ID)) {
                try {
                    map.removeLayer(LAYER_ID);
                    getDebug().teardownCount += 1;
                    noteEvent('layer-torn-down', { layerMounted: false }, eventMeta);
                } catch {
                    noteEvent('layer-teardown-threw', {}, eventMeta);
                }
            } else {
                noteEvent('teardown-noop', {}, eventMeta);
            }
            layerRef.current = null;
            waveHourRef.current = -1;
            return;
        }

        // Grid not loaded yet — the fetch effect will trigger a re-run.
        if (!grid) return;

        const wantsHour = Math.min(Math.max(0, Math.round(forecastHour)), grid.totalHours - 1);

        if (!layerRef.current) {
            try {
                const layer = new WaveParticleLayer(LAYER_ID);
                map.addLayer(layer);
                layerRef.current = layer;
                waveHourRef.current = -1;
                getDebug().mountCount += 1;
                noteEvent('layer-mounted', { layerMounted: true }, eventMeta);
                log.info(`Mounted waves particle layer (id=${LAYER_ID})`);
            } catch (err) {
                noteEvent('layer-mount-failed', {}, eventMeta);
                log.warn('Failed to mount particle layer', err);
                return;
            }
        }

        if (waveHourRef.current !== wantsHour) {
            try {
                // WaveParticleLayer is tuned for native m/s — no
                // amplification or scratch-buffer copy needed. The land
                // mask is required (rejection-sampled spawn AND advection
                // kill) so waves from a v1 binary (no mask) won't draw
                // anything useful — that's intentional, the v1 fallback is
                // only there to avoid hard-failing during the first deploy
                // before the pipeline has run.
                if (!grid.landMask) {
                    log.warn('Waves grid has no land mask (v1 binary?) — skipping draw');
                    return;
                }
                layerRef.current.setWaves(
                    grid.u[wantsHour],
                    grid.v[wantsHour],
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
                waveHourRef.current = wantsHour;
                getDebug().setDataCount += 1;
                noteEvent('set-data', { currentHour: wantsHour }, eventMeta);
                map.triggerRepaint();
                log.info(`Waves hour swapped to h+${wantsHour}`);
            } catch (err) {
                noteEvent('set-data-failed', {}, eventMeta);
                log.warn('Failed to set waves data', err);
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
export function isCmemsWavesEnabled(): boolean {
    return FEATURE_ENABLED;
}
