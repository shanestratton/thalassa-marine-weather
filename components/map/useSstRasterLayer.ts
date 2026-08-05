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

import { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { SstRasterLayer } from './SstRasterLayer';
import { fetchSstGrid, releaseSstGrid } from '../../services/weather/api/sstGrid';
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

const log = createLogger('SstRasterLayer');

const LAYER_ID = 'cmems-sst-raster';
const FEATURE_ENABLED = isCmemsFeatureEnabled('sst');

export function useSstRasterLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastStep: number = 0,
) {
    const layerRef = useRef<SstRasterLayer | null>(null);
    const currentStepRef = useRef(-1);
    const generationRef = useRef<string | undefined>();
    const clearLayerOwnership = useCallback(() => {
        layerRef.current = null;
        currentStepRef.current = -1;
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
        forecastStep,
        fetchSstGrid,
        releaseSstGrid,
        prepareForFrame,
    );
    const grid = refresh.grid;
    const [renderOutcome, setRenderOutcome] = useState<CmemsRenderOutcome | null>(null);
    const layerState = cmemsRenderedLayerState(refresh, FEATURE_ENABLED, visible, mapReady, renderOutcome);

    // Mount / update / unmount the layer based on visibility + data.
    useEffect(() => {
        const map = mapRef.current;
        if (!map || !mapReady) return;
        if (!FEATURE_ENABLED) {
            if (visible) log.info('gated off — VITE_CMEMS_SST_ENABLED=false');
            return;
        }

        // Teardown when hidden or when a trust refresh rejects the grid.
        if (!visible || !grid) {
            const retainedStep = currentStepRef.current >= 0 ? currentStepRef.current : null;
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
                setRenderOutcome(null);
            } else if (deactivation === 'hidden') {
                publishSafeDeactivation('hidden');
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Sea temperature', publishSafeDeactivation);
            } else {
                setRenderOutcome({
                    phase: 'stuck-visible',
                    attempt: refresh.attempt,
                    verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
                    sourceGeneration: generationRef.current ?? null,
                });
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Sea temperature', publishSafeDeactivation);
            }
            return;
        }

        if (generationRef.current !== grid.sourceGeneration) {
            generationRef.current = grid.sourceGeneration;
            currentStepRef.current = -1;
        }
        if (!grid.landMask) {
            log.warn('Verified SST grid has no land mask — skipping draw');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Sea temperature',
                attempt: refresh.attempt,
                verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        const wantsStep = Math.min(Math.max(0, Math.round(forecastStep)), grid.totalHours - 1);
        if (grid.sourceStep !== wantsStep || !grid.u[wantsStep]) {
            log.warn('Verified SST frame does not match the requested scrubber step');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Sea temperature',
                attempt: refresh.attempt,
                verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
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
                    label: 'Sea temperature',
                    attempt: refresh.attempt,
                    verifiedStep: null,
                    sourceGeneration: generationRef.current ?? null,
                    clearOwnership: clearLayerOwnership,
                    publish: setRenderOutcome,
                });
            }
            try {
                const layer = new SstRasterLayer(LAYER_ID);
                layerRef.current = layer;
                if (!addCmemsLayerAndProveOwnership(map, LAYER_ID, layer)) {
                    throw new Error('Mapbox did not register the SST candidate');
                }
                currentStepRef.current = -1;
                log.info(`Mounted SST raster layer (id=${LAYER_ID})`);
            } catch (err) {
                log.warn('Failed to mount SST layer', err);
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Sea temperature',
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
                label: 'Sea temperature',
                attempt: refresh.attempt,
                verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        if (currentStepRef.current !== wantsStep) {
            try {
                // Temperature °C is packed into the u-channel by the
                // pipeline (v-channel is zero). Extract it directly.
                const temp = grid.u[wantsStep];
                ownedLayer.setData(
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
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Sea temperature',
                    attempt: refresh.attempt,
                    verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
                    sourceGeneration: generationRef.current ?? null,
                    clearOwnership: clearLayerOwnership,
                    publish: setRenderOutcome,
                });
            }
        }
        setRenderOutcome({
            phase: 'ready',
            attempt: refresh.attempt,
            verifiedStep: wantsStep,
            sourceGeneration: grid.sourceGeneration ?? null,
        });
    }, [clearLayerOwnership, mapRef, mapReady, visible, forecastStep, grid, refresh.attempt]);

    // Unmount cleanup.
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
export function isCmemsSstEnabled(): boolean {
    return FEATURE_ENABLED;
}
