import type mapboxgl from 'mapbox-gl';
const prior = new WeakMap<mapboxgl.Map, Map<string, 'visible' | 'none'>>();
/** Hide basemap furniture only. The chart, routes, AIS and hazards remain owned by their layers. */
export function applyEncOnlyBase(map: mapboxgl.Map, enabled: boolean): boolean {
    let saved = prior.get(map),
        changed = false;
    if (!saved && !enabled) return false;
    if (!saved) prior.set(map, (saved = new Map()));
    const layers = map.getStyle()?.layers ?? [];
    const set = (id: string, visibility: 'visible' | 'none') => {
        if (map.getLayer(id) && (map.getLayoutProperty(id, 'visibility') ?? 'visible') !== visibility) {
            map.setLayoutProperty(id, 'visibility', visibility);
            changed = true;
        }
    };
    if (enabled) {
        if (!map.getLayer('enc-only-background')) {
            map.addLayer(
                { id: 'enc-only-background', type: 'background', paint: { 'background-color': '#b8c4cd' } },
                layers[0]?.id,
            );
            changed = true;
        }
        set('enc-only-background', 'visible');
        if (map.getPaintProperty('enc-only-background', 'background-color') !== '#b8c4cd') {
            map.setPaintProperty('enc-only-background', 'background-color', '#b8c4cd');
            changed = true;
        }
        for (const layer of layers) {
            if (layer.id === 'enc-only-background') continue;
            if (
                layer.type !== 'background' &&
                !(
                    'source' in layer &&
                    typeof layer.source === 'string' &&
                    ['composite', 'openmaptiles'].includes(layer.source)
                )
            )
                continue;
            if (!saved.has(layer.id))
                saved.set(
                    layer.id,
                    (map.getLayoutProperty(layer.id, 'visibility') as 'visible' | 'none' | undefined) ?? 'visible',
                );
            set(layer.id, 'none');
        }
    } else {
        for (const [id, visibility] of saved) set(id, visibility);
        set('enc-only-background', 'none');
        prior.delete(map);
    }
    return changed;
}
