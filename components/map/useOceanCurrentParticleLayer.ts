/**
 * useOceanCurrentParticleLayer — Custom WebGL particle layer for CMEMS
 * ocean-currents data, fetched as binary blobs from a daily GitHub
 * Release asset.
 *
 * Backed by CurrentParticleLayer (NOT WindParticleLayer) — the wind
 * layer's tuning made narrow western-boundary currents like the EAC
 * invisible. The dedicated currents layer:
 *   - Speed-weights particle spawn so the EAC / Gulf Stream / ACC
 *     get particle density proportional to flow strength.
 *   - Uses a native m/s SPEED_FACTOR (no amplification hack).
 *   - Renders with a RIP/SLACK colour ramp (0.1 → 1.5 m/s).
 *   - Requires the v2 land mask so particles don't spawn on land.
 *
 * Design notes:
 *   - Binary blobs are produced by scripts/cmems-currents-pipeline/pipeline.py
 *     and attached to release `cmems-currents-latest` (one .bin per hour).
 *   - The scrubber fetches only its selected immutable frame (~9 MB), with
 *     verification and a bounded browser cache instead of a 13-frame cube.
 *   - Gated by VITE_CMEMS_CURRENTS_ENABLED so the existing Xweather
 *     raster-currents layer remains the default fallback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { CurrentParticleLayer } from './CurrentParticleLayer';
import { fetchCurrentsGrid, releaseCurrentsGrid } from '../../services/weather/api/currentsGrid';
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

const log = createLogger('CurrentParticleLayer');

const LAYER_ID = 'cmems-currents-particles';
const FEATURE_ENABLED = isCmemsFeatureEnabled('currents');

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
    /** Ring buffer of the last 40 effect runs + outcomes with timestamps.
     *  Readable via window.__thalassaDebug.currents.events to diagnose
     *  which upstream dep is flipping. */
    events: Array<{ t: number; ev: string; visible?: boolean; grid?: boolean; mapReady?: boolean }>;
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
            events: [],
        } satisfies CurrentsDebugMirror;
    }
    return g.__thalassaDebug.currents as CurrentsDebugMirror;
};
const noteEvent = (
    ev: string,
    patch: Partial<CurrentsDebugMirror> = {},
    extra: { visible?: boolean; grid?: boolean; mapReady?: boolean } = {},
) => {
    const d = getDebug();
    Object.assign(d, patch, { lastEvent: ev, lastEventAt: Date.now() });
    d.events.push({ t: Date.now(), ev, ...extra });
    // Cap ring size — keep most recent 40 events.
    if (d.events.length > 40) d.events.splice(0, d.events.length - 40);
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
    const layerRef = useRef<CurrentParticleLayer | null>(null);
    const currentHourRef = useRef(-1);
    const generationRef = useRef<string | undefined>();
    const clearLayerOwnership = useCallback(() => {
        layerRef.current = null;
        currentHourRef.current = -1;
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
        fetchCurrentsGrid,
        releaseCurrentsGrid,
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
            if (visible) log.info('gated off — VITE_CMEMS_CURRENTS_ENABLED=false');
            return;
        }

        noteEvent('mount-effect-enter', { visible, hasGrid: !!grid }, eventMeta);

        // Tear down when hidden or when a trust refresh rejects the grid.
        if (!visible || !grid) {
            const retainedStep = currentHourRef.current >= 0 ? currentHourRef.current : null;
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
                // A hidden ID is safe for user-off, but not reusable. Retain
                // every ref so a later frame must remove and prove absence.
                noteEvent('layer-teardown-hidden', {}, eventMeta);
                publishSafeDeactivation('hidden');
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Currents', publishSafeDeactivation);
            } else {
                noteEvent('layer-teardown-failed', {}, eventMeta);
                setRenderOutcome({
                    phase: 'stuck-visible',
                    attempt: refresh.attempt,
                    verifiedStep: currentHourRef.current >= 0 ? currentHourRef.current : null,
                    sourceGeneration: generationRef.current ?? null,
                });
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Currents', publishSafeDeactivation);
            }
            return;
        }

        if (generationRef.current !== grid.sourceGeneration) {
            generationRef.current = grid.sourceGeneration;
            currentHourRef.current = -1;
        }
        const wantsHour = Math.min(Math.max(0, Math.round(forecastHour)), grid.totalHours - 1);
        if (grid.sourceStep !== wantsHour || !grid.u[wantsHour] || !grid.v[wantsHour]) {
            log.warn('Verified currents frame does not match the requested scrubber step');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Currents',
                attempt: refresh.attempt,
                verifiedStep: currentHourRef.current >= 0 ? currentHourRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }
        if (!grid.landMask) {
            log.warn('Verified currents grid has no land mask — skipping draw');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Currents',
                attempt: refresh.attempt,
                verifiedStep: currentHourRef.current >= 0 ? currentHourRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        if (!layerRef.current) {
            // Constructors allocate the particle trails. Prove the ID absent
            // before creating a candidate so a duplicate cannot double memory.
            if (!isCmemsLayerAbsent(map, LAYER_ID)) {
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Currents',
                    attempt: refresh.attempt,
                    verifiedStep: null,
                    sourceGeneration: generationRef.current ?? null,
                    clearOwnership: clearLayerOwnership,
                    publish: setRenderOutcome,
                });
            }
            try {
                const layer = new CurrentParticleLayer(LAYER_ID);
                layerRef.current = layer;
                if (!addCmemsLayerAndProveOwnership(map, LAYER_ID, layer)) {
                    throw new Error('Mapbox did not register the currents candidate');
                }
                currentHourRef.current = -1;
                getDebug().mountCount += 1;
                noteEvent('layer-mounted', { layerMounted: true }, eventMeta);
                log.info(`Mounted currents particle layer (id=${LAYER_ID})`);
            } catch (err) {
                noteEvent('layer-mount-failed', {}, eventMeta);
                log.warn('Failed to mount particle layer', err);
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Currents',
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
                label: 'Currents',
                attempt: refresh.attempt,
                verifiedStep: currentHourRef.current >= 0 ? currentHourRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        if (currentHourRef.current !== wantsHour) {
            try {
                // CurrentParticleLayer is tuned for native m/s — no
                // amplification or scratch-buffer copy needed. The land
                // mask is required (rejection-sampled spawn AND advection
                // kill). The schema-v2 loader requires it; this final guard
                // keeps the renderer fail-closed too.
                ownedLayer.setCurrents(
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
                currentHourRef.current = wantsHour;
                getDebug().setDataCount += 1;
                noteEvent('set-data', { currentHour: wantsHour }, eventMeta);
                map.triggerRepaint();
                log.info(`Currents hour swapped to h+${wantsHour}`);
            } catch (err) {
                noteEvent('set-data-failed', {}, eventMeta);
                log.warn('Failed to set currents data', err);
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Currents',
                    attempt: refresh.attempt,
                    verifiedStep: currentHourRef.current >= 0 ? currentHourRef.current : null,
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
export function isCmemsCurrentsEnabled(): boolean {
    return FEATURE_ENABLED;
}
