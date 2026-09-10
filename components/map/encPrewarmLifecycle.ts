import type mapboxgl from 'mapbox-gl';

type PrewarmModule = { prewarmEncMerge: (map: mapboxgl.Map) => void };

/** Optional boot work belongs to the live map and current chart intent. */
export function deferEncPrewarm(
    map: mapboxgl.Map,
    canRun: () => boolean,
    load: () => Promise<PrewarmModule> = () => import('./useEncVectorLayer'),
): () => void {
    let cancelled = false;
    if (canRun()) {
        void load()
            .then(({ prewarmEncMerge }) => {
                if (!cancelled && canRun()) prewarmEncMerge(map);
            })
            .catch(() => undefined);
    }
    return () => {
        cancelled = true;
    };
}
