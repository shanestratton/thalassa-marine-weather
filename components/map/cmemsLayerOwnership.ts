import type mapboxgl from 'mapbox-gl';
import { toast } from '../Toast';

export type CmemsLayerDeactivation = 'absent' | 'hidden' | 'failed';

type RemovalAttempt = 'absent' | 'removed' | 'residue' | 'failed';

function attemptCmemsLayerRemoval(map: mapboxgl.Map, layerId: string): RemovalAttempt {
    let existing: unknown;
    try {
        existing = map.getLayer(layerId);
    } catch {
        return 'failed';
    }
    if (!existing) return 'absent';
    try {
        map.removeLayer(layerId);
    } catch {
        // A thrown mutation is never promoted to success, even if a later
        // lookup happens to say absent. The ownership transition was not
        // synchronously trustworthy.
        return 'failed';
    }
    try {
        return map.getLayer(layerId) ? 'residue' : 'removed';
    } catch {
        return 'failed';
    }
}

/** Mapbox layer lookup can itself throw while a style is changing. */
export function isCmemsLayerAbsent(map: mapboxgl.Map, layerId: string): boolean {
    try {
        return !map.getLayer(layerId);
    } catch {
        return false;
    }
}

/**
 * Remove an existing custom layer and prove its ID is no longer registered.
 * A thrown remove is not assumed to have failed or succeeded: the post-check is
 * authoritative. Callers must retain their ownership refs when this is false.
 */
export function removeCmemsLayerAndProveAbsent(map: mapboxgl.Map, layerId: string): boolean {
    const result = attemptCmemsLayerRemoval(map, layerId);
    return result === 'absent' || result === 'removed';
}

/**
 * User-off and teardown path. Absence is preferred; if Mapbox cannot remove the
 * ID during a style transition, visibility=none is an acceptable fail-closed
 * fallback only when it can be read back synchronously.
 */
export function deactivateCmemsLayerAndProveSafe(map: mapboxgl.Map, layerId: string): CmemsLayerDeactivation {
    const removal = attemptCmemsLayerRemoval(map, layerId);
    if (removal === 'absent' || removal === 'removed') return 'absent';
    // A thrown/uncertain removal must still fail replacement preparation, but
    // user-off can be made safe independently by proving the ID absent now or
    // by proving Mapbox accepted visibility=none.
    if (isCmemsLayerAbsent(map, layerId)) return 'absent';
    try {
        map.setLayoutProperty(layerId, 'visibility', 'none');
    } catch {
        return isCmemsLayerAbsent(map, layerId) ? 'absent' : 'failed';
    }
    if (isCmemsLayerAbsent(map, layerId)) return 'absent';
    try {
        return map.getLayoutProperty(layerId, 'visibility') === 'none' ? 'hidden' : 'failed';
    } catch {
        return 'failed';
    }
}

/**
 * Mapbox reports duplicate custom-layer IDs through its error event and may let
 * addLayer return normally. Strict identity is therefore the only mount proof:
 * the registered implementation must be the exact candidate we just added.
 */
export function addCmemsLayerAndProveOwnership(
    map: mapboxgl.Map,
    layerId: string,
    candidate: mapboxgl.CustomLayerInterface,
): boolean {
    if (!isCmemsLayerAbsent(map, layerId)) return false;
    try {
        map.addLayer(candidate);
    } catch {
        if (deactivateCmemsLayerAndProveSafe(map, layerId) === 'failed') {
            throw new Error(`Unsafe CMEMS rollback after addLayer failure: ${layerId}`);
        }
        return false;
    }
    try {
        if (map.getLayer(layerId) === candidate) return true;
    } catch {
        // Roll back below.
    }
    if (deactivateCmemsLayerAndProveSafe(map, layerId) === 'failed') {
        throw new Error(`Unsafe CMEMS rollback after ownership mismatch: ${layerId}`);
    }
    return false;
}

export function isCmemsLayerOwned(
    map: mapboxgl.Map,
    layerId: string,
    candidate: mapboxgl.CustomLayerInterface,
): boolean {
    try {
        return map.getLayer(layerId) === candidate;
    } catch {
        return false;
    }
}

/**
 * Keep retrying an unsafe user-off teardown at Mapbox's style lifecycle
 * boundaries. The persistent action runs the same proof immediately.
 */
export function monitorCmemsLayerDeactivation(
    map: mapboxgl.Map,
    layerId: string,
    label: string,
    onSafe: (result: Exclude<CmemsLayerDeactivation, 'failed'>) => void,
): () => void {
    let disposed = false;
    let toastId: number | undefined;
    const dispose = () => {
        if (disposed) return;
        disposed = true;
        map.off('styledata', retry);
        map.off('idle', retry);
        if (toastId !== undefined) {
            toast.dismiss(toastId);
            toastId = undefined;
        }
    };
    const retry = () => {
        if (disposed) return;
        const result = deactivateCmemsLayerAndProveSafe(map, layerId);
        if (result === 'failed') return;
        if (result === 'hidden') {
            onSafe(result);
            return;
        }
        dispose();
        onSafe(result);
    };
    toastId = toast.persistentError(
        `${label} could not be fully removed from the chart and may still be visible. Do not rely on this layer.`,
        {
            label: 'Retry',
            onClick: retry,
        },
    );
    map.on('styledata', retry);
    map.on('idle', retry);
    return dispose;
}
