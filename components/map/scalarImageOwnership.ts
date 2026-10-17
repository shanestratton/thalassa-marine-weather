import type mapboxgl from 'mapbox-gl';
import { toast } from '../Toast';
import { deactivateCmemsLayerAndProveSafe } from './cmemsLayerOwnership';

export type ScalarImageDeactivation = 'absent' | 'hidden' | 'stuck-visible';
export interface ScalarImageRetirement {
    state(): ScalarImageDeactivation;
    retry(): void;
    done(): boolean;
    mapGone(): boolean;
}

/**
 * Retain a bounded uncertain image until absence is proven. Lifecycle retries
 * never touch a foreign source; the warning includes the caller's attribution
 * even if its React surface has unmounted. Map removal itself ends presentation.
 */
export function retireScalarImage(
    map: mapboxgl.Map,
    sourceId: string,
    layerId: string | readonly string[],
    candidate: ReturnType<mapboxgl.Map['getSource']>,
    label: string,
    credit: string,
    notify: (state: ScalarImageDeactivation) => void,
): ScalarImageRetirement {
    const layerIds = typeof layerId === 'string' ? [layerId] : [...layerId];
    let state: ScalarImageDeactivation = 'stuck-visible';
    let finished = false;
    let gone = false;
    let busy = false;
    let warning: number | undefined;
    const dismiss = () => {
        if (warning !== undefined) toast.dismiss(warning);
        warning = undefined;
    };
    const stop = () => {
        if (finished) return;
        finished = true;
        map.off('styledata', retry);
        map.off('idle', retry);
        map.off('remove', mapRemoved);
        dismiss();
    };
    const attempt = (): ScalarImageDeactivation => {
        try {
            const source = map.getSource(sourceId);
            const layers = layerIds.map((id) => map.getLayer(id));
            if (!source && layers.every((layer) => !layer)) return 'absent';
            if (
                !candidate ||
                source !== candidate ||
                layers.some((layer) => layer && (!('source' in layer) || layer.source !== sourceId))
            ) {
                return 'stuck-visible';
            }
            let hidden = false;
            for (const id of layerIds) {
                if (map.getSource(sourceId) !== candidate) return 'stuck-visible';
                const safe = deactivateCmemsLayerAndProveSafe(map, id);
                if (safe === 'failed') return 'stuck-visible';
                if (safe === 'hidden') hidden = true;
            }
            // A shared GeoJSON source must outlive every dependent layer. Remove
            // all of them before touching the source; hidden residue still owns it.
            if (hidden) return 'hidden';
            // The raster is absent, so a retained source cannot paint. Keep
            // resource ownership until source removal also reads back absent.
            try {
                map.removeSource(sourceId);
            } catch {
                /* Retry at the next lifecycle boundary. */
            }
            if (!map.getSource(sourceId) && layerIds.every((id) => !map.getLayer(id))) return 'absent';
            return 'hidden';
        } catch {
            return 'stuck-visible';
        }
    };
    const publish = (next: ScalarImageDeactivation) => {
        state = next;
        if (next === 'absent') stop();
        else if (next === 'hidden') dismiss();
        else if (warning === undefined) {
            warning = toast.persistentError(
                `${label} could not be removed or verified hidden and may still be visible. Do not rely on this layer. ${credit}`,
                { label: 'Retry', onClick: retry },
            );
        }
        notify(next);
    };
    function retry() {
        if (finished || busy) return;
        busy = true;
        try {
            publish(attempt());
        } finally {
            busy = false;
        }
    }
    function mapRemoved() {
        gone = true;
        publish('absent');
    }
    map.on('styledata', retry);
    map.on('idle', retry);
    map.on('remove', mapRemoved);
    return { state: () => state, retry, done: () => finished, mapGone: () => gone };
}
