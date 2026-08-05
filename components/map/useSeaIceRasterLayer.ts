/**
 * useSeaIceRasterLayer — mounts the SeaIceRasterLayer for CMEMS
 * sea-ice concentration data.
 *
 * Sister hook to useChlRasterLayer / useSstRasterLayer. Same lifecycle
 * pattern (lazy fetch on first visibility, single layer on the map,
 * step-index swap when scrubber moves) — the only differences are the
 * data source URL and the layer class.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';
import { SeaIceRasterLayer } from './SeaIceRasterLayer';
import { fetchSeaIceGrid, releaseSeaIceGrid } from '../../services/weather/api/seaiceGrid';
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

const log = createLogger('SeaIceRasterLayer');

const LAYER_ID = 'cmems-seaice-raster';
const FEATURE_ENABLED = isCmemsFeatureEnabled('seaice');

export function useSeaIceRasterLayer(
    mapRef: React.MutableRefObject<mapboxgl.Map | null>,
    mapReady: boolean,
    visible: boolean,
    forecastStep: number = 0,
) {
    const layerRef = useRef<SeaIceRasterLayer | null>(null);
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
        fetchSeaIceGrid,
        releaseSeaIceGrid,
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
            if (visible) log.info('gated off — VITE_CMEMS_SEAICE_ENABLED=false');
            return;
        }

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
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Sea ice', publishSafeDeactivation);
            } else {
                setRenderOutcome({
                    phase: 'stuck-visible',
                    attempt: refresh.attempt,
                    verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
                    sourceGeneration: generationRef.current ?? null,
                });
                return monitorCmemsLayerDeactivation(map, LAYER_ID, 'Sea ice', publishSafeDeactivation);
            }
            return;
        }

        if (generationRef.current !== grid.sourceGeneration) {
            generationRef.current = grid.sourceGeneration;
            currentStepRef.current = -1;
        }
        if (!grid.landMask) {
            log.warn('Verified sea-ice grid has no land mask — skipping draw');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Sea ice',
                attempt: refresh.attempt,
                verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        const wantsStep = Math.min(Math.max(0, Math.round(forecastStep)), grid.totalHours - 1);
        if (grid.sourceStep !== wantsStep || !grid.u[wantsStep]) {
            log.warn('Verified sea-ice frame does not match the requested scrubber step');
            return deactivateFailedCmemsRenderer({
                map,
                layerId: LAYER_ID,
                label: 'Sea ice',
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
                    label: 'Sea ice',
                    attempt: refresh.attempt,
                    verifiedStep: null,
                    sourceGeneration: generationRef.current ?? null,
                    clearOwnership: clearLayerOwnership,
                    publish: setRenderOutcome,
                });
            }
            try {
                const layer = new SeaIceRasterLayer(LAYER_ID);
                layerRef.current = layer;
                if (!addCmemsLayerAndProveOwnership(map, LAYER_ID, layer)) {
                    throw new Error('Mapbox did not register the sea-ice candidate');
                }
                currentStepRef.current = -1;
                log.info(`Mounted sea-ice raster layer (id=${LAYER_ID})`);
            } catch (err) {
                log.warn('Failed to mount sea-ice layer', err);
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Sea ice',
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
                label: 'Sea ice',
                attempt: refresh.attempt,
                verifiedStep: currentStepRef.current >= 0 ? currentStepRef.current : null,
                sourceGeneration: generationRef.current ?? null,
                clearOwnership: clearLayerOwnership,
                publish: setRenderOutcome,
            });
        }

        if (currentStepRef.current !== wantsStep) {
            try {
                // siconc fraction [0,1] is packed into u-channel by the
                // pipeline (v-channel is zero).
                const concentration = grid.u[wantsStep];
                ownedLayer.setData(
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
                return deactivateFailedCmemsRenderer({
                    map,
                    layerId: LAYER_ID,
                    label: 'Sea ice',
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

/** Exposed so the legend / radial menu can check the flag state. */
export function isCmemsSeaIceEnabled(): boolean {
    return FEATURE_ENABLED;
}
