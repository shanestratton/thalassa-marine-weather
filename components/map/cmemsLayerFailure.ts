import type mapboxgl from 'mapbox-gl';
import {
    deactivateCmemsLayerAndProveSafe,
    monitorCmemsLayerDeactivation,
    type CmemsLayerDeactivation,
} from './cmemsLayerOwnership';
import type { CmemsRenderOutcome } from './useCmemsGridRefresh';

interface FailedRendererDeactivationOptions {
    map: mapboxgl.Map;
    layerId: string;
    label: string;
    attempt: number;
    verifiedStep: number | null;
    sourceGeneration: string | null;
    clearOwnership: () => void;
    publish: (outcome: CmemsRenderOutcome) => void;
}

/**
 * A renderer upload failure is also a presentation failure. Remove the custom
 * layer synchronously where possible; otherwise prove it hidden and retain all
 * ownership refs until Mapbox eventually proves the ID absent.
 */
export function deactivateFailedCmemsRenderer({
    map,
    layerId,
    label,
    attempt,
    verifiedStep,
    sourceGeneration,
    clearOwnership,
    publish,
}: FailedRendererDeactivationOptions): void | (() => void) {
    const publishSafe = (result: Exclude<CmemsLayerDeactivation, 'failed'>) => {
        if (result === 'absent') {
            clearOwnership();
            publish({
                phase: 'error',
                attempt,
                verifiedStep: null,
                sourceGeneration: null,
            });
            return;
        }
        publish({
            phase: 'hidden',
            attempt,
            verifiedStep,
            sourceGeneration,
        });
    };

    const result = deactivateCmemsLayerAndProveSafe(map, layerId);
    if (result === 'absent') {
        publishSafe(result);
        return;
    }
    if (result === 'hidden') {
        publishSafe(result);
    } else {
        publish({
            phase: 'stuck-visible',
            attempt,
            verifiedStep,
            sourceGeneration,
        });
    }

    // Hidden is visually safe but still owns Mapbox/GPU resources. Keep the
    // lifecycle listeners active through hidden results and clear refs only
    // after strict absence is observed.
    return monitorCmemsLayerDeactivation(map, layerId, label, publishSafe);
}
