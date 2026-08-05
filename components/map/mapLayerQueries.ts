import type mapboxgl from 'mapbox-gl';

/**
 * Mapbox emits an ErrorEvent (rather than throwing) when a requested layer ID
 * is absent. Filter every optional/runtime-mounted layer query first so normal
 * style swaps, low zooms and no-chart areas stay quiet and partial sets still
 * return their available features.
 */
export function existingMapLayerIds(map: Pick<mapboxgl.Map, 'getLayer'>, layerIds: readonly string[]): string[] {
    const existing: string[] = [];
    for (const id of layerIds) {
        try {
            if (map.getLayer(id)) existing.push(id);
        } catch {
            // A style may be replaced between two lookups. The caller can
            // safely skip that layer for this interaction and retry next tap.
        }
    }
    return existing;
}
