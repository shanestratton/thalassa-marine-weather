import type mapboxgl from 'mapbox-gl';
import type { FeatureCollection, Geometry } from 'geojson';
export const ANNOTATION_SOURCE = 'user-chart-annotations';
export const DRAFT_SOURCE = 'user-chart-draft';
export const RULER_SOURCE = 'user-boat-ruler';
export type DrawingData = FeatureCollection<Geometry>;
export const emptyDrawingData = (): DrawingData => ({ type: 'FeatureCollection', features: [] });
export function putDrawingData(map: mapboxgl.Map, id: string, data: DrawingData, color: string) {
    const source = map.getSource(id) as mapboxgl.GeoJSONSource | undefined;
    if (source) source.setData(data);
    else map.addSource(id, { type: 'geojson', data });
    if (!map.getLayer(id + '-fill'))
        map.addLayer({
            id: id + '-fill',
            type: 'fill',
            source: id,
            filter: ['==', ['geometry-type'], 'Polygon'],
            paint: { 'fill-color': color, 'fill-opacity': 0.12 },
        });
    if (!map.getLayer(id + '-line'))
        map.addLayer({
            id: id + '-line',
            type: 'line',
            source: id,
            filter: ['!=', ['geometry-type'], 'Point'],
            paint: { 'line-color': color, 'line-width': 2 },
        });
    if (!map.getLayer(id + '-point'))
        map.addLayer({
            id: id + '-point',
            type: 'circle',
            source: id,
            filter: ['==', ['geometry-type'], 'Point'],
            paint: {
                'circle-color': color,
                'circle-radius': 4,
                'circle-stroke-color': '#0f172a',
                'circle-stroke-width': 1,
            },
        });
}
export function removeDrawingData(map: mapboxgl.Map, id: string) {
    try {
        for (const suffix of ['-fill', '-line', '-point']) if (map.getLayer(id + suffix)) map.removeLayer(id + suffix);
        if (map.getSource(id)) map.removeSource(id);
    } catch {
        /* removed style */
    }
}
