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
 *   - Uses a display-only advection factor for VHM0×direction vectors.
 *   - Renders significant wave height from calm to rough (0.5 → 4 m).
 *   - Requires the v2 land mask so particles don't spawn on land.
 *
 * Design notes:
 *   - Binary blobs are produced by scripts/cmems-waves-pipeline/pipeline.py
 *     and attached to release `cmems-waves-latest` (one .bin per hour).
 *   - The scrubber fetches only its selected immutable frame (~9 MB), with
 *     verification and a bounded browser cache instead of a 17-frame cube.
 *   - Gated by VITE_CMEMS_WAVES_ENABLED so the existing Xweather
 *     raster-waves layer remains the default fallback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { WaveParticleLayer } from './WaveParticleLayer';
import { fetchWavesGrid, releaseWavesGrid } from '../../services/weather/api/wavesGrid';
import { cmemsRenderedLayerState, type CmemsRenderOutcome, useCmemsGridRefresh } from './useCmemsGridRefresh';
import {
    addCmemsLayerAndProveOwnership,
    deactivateCmemsLayerAndProveSafe,
    isCmemsLayerAbsent,
    isCmemsLayerOwned,
    monitorCmemsLayerDeactivation,
    removeCmemsLayerAndProveAbsent,
} from './cmemsLayerOwnership';
import { isCmemsFeatureEnabled } from './cmemsFeatureAvailability';
import { deactivateFailedCmemsRenderer } from './cmemsLayerFailure';

const log = createLogger('WaveParticleLayer');

const LAYER_ID = 'cmems-waves-particles';
const FEATURE_ENABLED = isCmemsFeatureEnabled('waves');

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
    const generationRef = useRef<string | undefined>();
    const clearLayerOwnership = useCallback(() => {
        layerRef.current = null;
        waveHourRef.current = -1;
        generationRef.current = undefined;
    }, []);
    const prepareForFrame = useCallback(() => {
        const map = mapRef.current;
        if (!map || !mapReady || !removeCmemsLayerAndProveAbsent(map, LAYER_ID)) return false;
        clearLayerOwnership();
        return true;
    }, [clearLayerOwnership, mapReady, mapRef]);
    const refresh = useCmemsGridRefresh(
        FEATURE_ENABLED && mapReady,
        visible,
        forecastHour,
        fetchWavesGrid,
        releaseWavesGrid,
        prepareForFrame,
    );
    const grid = refresh.grid;
    const [renderOutcome, setRenderOutcome] = useState<CmemsRenderOutcome | null>(null);
    const layerState = cmemsRenderedLayerState(refresh, FEATURE_ENABLED, visible, mapReady, renderOutcome);

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

        // Tear down when hidden or when a trust refresh rejects the grid.
        if (!visible || !grid) {
            const retainedStep = waveHourRef.current >= 0 ? waveHourRef.current : null;
            const retainedGeneration = generationRef.current ?? null;
            const publishSafeDeactivation = (safe: 'absent' | 'hidden') => {
                if (safe === 'absent') {
                    clearLayerOwnership();
                    setRenderOutcome(null);
                    return;
                }
                setRenderOutcome({
                    phase: 'hidden',
                    attempt: refresh.attempt,
                    verifiedStep: retainedStep,
                    sourceGeneration: retainedGeneration,
                });
            };
            const deactivation = deactivateCmemsLayerAndProveSafe(map, LAYER_ID);
            if (deactivation === 'absent') {
                clearLayerOwnership();
                getDebug().teardownCount += 1;
                noteEvent('layer-torn-down', { layerMounted: false }, eventMeta);
                setRenderOutcome(null);
            } else if (deactivation === 'hidden') {
                noteEvent('layer-teardown-hidden', {}, eventMeta);
                publishSafeDeactivation('hidden');
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Waves', publishSafeDeactivation);
            } else {
                noteEvent('layer-teardown-failed', {}, eventMeta);
                setRenderOutcome({
                    phase: 'stuck-visible',
                    attempt: refresh.attempt,
                    verifiedStep: waveHourRef.current >= 0 ? waveHourRef.current : null,
                    sourceGeneration: generationRef.current ?? null,
                });
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Waves', publishSafeDeactivation);
            }
            return;
        }

        if (generationRef.current !== grid.sourceGeneration) {
            generationRef.current = grid.sourceGeneration;
            waveHourRef.current = -1;
        }
        const wantsHour = Math.min(Math.max(0, Math.round(forecastHour)), grid.totalHours - 1);
        if (grid.sourceStep !== wantsHour || !grid.u[wantsHour] || !grid.v[wantsHour]) {
            log.warn('Verified waves frame does not match the requested scrubber step');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Waves',
                attempt: refresh.attempt,
                verifiedStep: waveHourRef.current >= 0 ? waveHourRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }
        if (!grid.landMask) {
            log.warn('Verified waves grid has no land mask — skipping draw');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Waves',
                attempt: refresh.attempt,
                verifiedStep: waveHourRef.current >= 0 ? waveHourRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        if (!layerRef.current) {
            if (!isCmemsLayerAbsent(map, LAYER_ID)) {
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Waves',
                    attempt: refresh.attempt,
                    verifiedStep: null,
                    sourceGeneration: generationRef.current ?? null,
                    clearOwnership: clearLayerOwnership,
                    publish: setRenderOutcome,
                });
            }
            try {
                const layer = new WaveParticleLayer(LAYER_ID);
                layerRef.current = layer;
                if (!addCmemsLayerAndProveOwnership(map, LAYER_ID, layer)) {
                    throw new Error('Mapbox did not register the waves candidate');
                }
                waveHourRef.current = -1;
                getDebug().mountCount += 1;
                noteEvent('layer-mounted', { layerMounted: true }, eventMeta);
                log.info(`Mounted waves particle layer (id=${LAYER_ID})`);
            } catch (err) {
                noteEvent('layer-mount-failed', {}, eventMeta);
                log.warn('Failed to mount particle layer', err);
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Waves',
                    attempt: refresh.attempt,
                    verifiedStep: null,
                    sourceGeneration: generationRef.current ?? null,
                    clearOwnership: clearLayerOwnership,
                    publish: setRenderOutcome,
                });
            }
        }

        const ownedLayer = layerRef.current;
        if (!ownedLayer || !isCmemsLayerOwned(map, LAYER_ID, ownedLayer)) {
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Waves',
                attempt: refresh.attempt,
                verifiedStep: waveHourRef.current >= 0 ? waveHourRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        if (waveHourRef.current !== wantsHour) {
            try {
                // WaveParticleLayer consumes significant-wave-height vectors
                // in metres; no scratch-buffer copy is needed. The land
                // mask is required (rejection-sampled spawn AND advection
                // kill). The schema-v2 loader requires it; this final guard
                // keeps the renderer fail-closed too.
                ownedLayer.setWaves(
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
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Waves',
                    attempt: refresh.attempt,
                    verifiedStep: waveHourRef.current >= 0 ? waveHourRef.current : null,
                    sourceGeneration: generationRef.current ?? null,
                    clearOwnership: clearLayerOwnership,
                    publish: setRenderOutcome,
                });
            }
        }
        setRenderOutcome({
            phase: 'ready',
            attempt: refresh.attempt,
            verifiedStep: wantsHour,
            sourceGeneration: grid.sourceGeneration ?? null,
        });
    }, [clearLayerOwnership, mapRef, mapReady, visible, forecastHour, grid, refresh.attempt]);

    // Unmount cleanup
    useEffect(() => {
        if (!mapReady) return;
        const map = mapRef.current;
        return () => {
            if (!map) return;
            const deactivation = deactivateCmemsLayerAndProveSafe(map, LAYER_ID);
            if (deactivation === 'absent') clearLayerOwnership();
        };
    }, [clearLayerOwnership, mapRef, mapReady]);

    return layerState;
}

/** Exposed so the legend / attribution chip can check the flag state. */
export function isCmemsWavesEnabled(): boolean {
    return FEATURE_ENABLED;
}
