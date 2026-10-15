import type mapboxgl from 'mapbox-gl';

// Cache by source identity: a new style gets a fresh source and fresh writes.
const written = new WeakMap<object, string>();

/** Empty pictures allocate nothing, and unchanged pictures do not wake Mapbox workers. */
export function writeAisMapData(map: mapboxgl.Map, id: string, data: GeoJSON.GeoJSON): void {
    const empty = data.type === 'FeatureCollection' && data.features.length === 0;
    let source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
    const serialised = JSON.stringify(data);
    if (!source && !empty && (id === 'ais-dr-estimates' || id === 'ais-target-trail')) {
        map.addSource(id, { type: 'geojson', data });
        source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
        if (source) written.set(source, serialised);
    }
    if (!source) return;
    const previous = written.get(source);
    if (previous === serialised || (previous === undefined && empty)) {
        written.set(source, serialised);
        return;
    }
    source.setData(data);
    written.set(source, serialised);
}

/** Create presentation resources only when there are actual targets to draw. */
export function ensureAisPictureLayers(map: mapboxgl.Map, hasTargets: boolean): void {
    const before = map.getLayer('ais-targets-circle') ? 'ais-targets-circle' : undefined;
    if (hasTargets && map.getSource('ais-targets') && !map.getLayer('ais-stale-badge')) {
        map.addLayer({
            id: 'ais-stale-badge', type: 'symbol', source: 'ais-targets',
            layout: {
                'text-field': ['coalesce', ['get', 'staleBadge'], ''], 'text-size': 10,
                'text-offset': [0, -1.5], 'text-anchor': 'bottom', 'text-max-width': 9,
                'text-font': ['DIN Pro Bold', 'Arial Unicode MS Bold'], 'text-allow-overlap': false,
            },
            paint: { 'text-color': '#f8fafc', 'text-halo-color': '#334155', 'text-halo-width': 2 },
        });
    }
    if (map.getSource('ais-target-trail') && !map.getLayer('ais-target-trail')) {
        map.addLayer({
            id: 'ais-target-trail', type: 'line', source: 'ais-target-trail',
            paint: { 'line-color': '#38bdf8', 'line-width': 1.5, 'line-opacity': 0.3 },
        }, before);
    }
    if (!map.getSource('ais-dr-estimates')) return;
    const colour: mapboxgl.Expression = ['coalesce', ['get', 'typeColor'], '#94a3b8'];
    if (!map.getLayer('ais-dr-ring')) map.addLayer({
        id: 'ais-dr-ring', type: 'line', source: 'ais-dr-estimates', filter: ['==', ['get', 'kind'], 'ring'],
        paint: { 'line-color': colour, 'line-width': 1, 'line-opacity': 0.4 },
    }, before);
    if (!map.getLayer('ais-dr-link')) map.addLayer({
        id: 'ais-dr-link', type: 'line', source: 'ais-dr-estimates', filter: ['==', ['get', 'kind'], 'link'],
        paint: { 'line-color': colour, 'line-width': 1.5, 'line-opacity': 0.6, 'line-dasharray': [3, 3] },
    }, before);
    if (!map.getLayer('ais-dr-ghost')) map.addLayer({
        id: 'ais-dr-ghost', type: 'circle', source: 'ais-dr-estimates', filter: ['==', ['get', 'kind'], 'ghost'],
        paint: { 'circle-radius': 6, 'circle-opacity': 0, 'circle-stroke-width': 1.5,
            'circle-stroke-color': colour, 'circle-stroke-opacity': 0.8 },
    }, before);
}
