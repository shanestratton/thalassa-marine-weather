import type { Map as MapboxMap } from 'mapbox-gl';

/**
 * Mapbox's Musgrave tiles are valid HTTP 200 images but uniformly navy,
 * including at high zoom. Its vector labels still render, hiding the gap.
 * MapTiler satellite-v2 has verified island and reef photography here.
 * Limit the repair to this area; keep Mapbox imagery everywhere else.
 * Bounds limit requested tiles (they are not a pixel-level clipping mask).
 */
export const MUSGRAVE_IMAGERY = {
    bounds: [152.37, -23.93, 152.44, -23.87] as [number, number, number, number],
    minzoom: 10,
    maxzoom: 18,
    tileSize: 512,
    tiles: ['https://api.maptiler.com/tiles/satellite-v2/{z}/{x}/{y}.jpg?key=3misfI2jeOYbJqgl5a6e'],
    attribution:
        '<a href="https://www.maptiler.com/copyright/" target="_blank" rel="noopener noreferrer">© MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">© OpenStreetMap contributors</a>',
    // First vector layer after the raster in satellite-streets-v12.
    // Keep names, paths, the boat and passage overlays above photography.
    beforeId: 'tunnel-minor-case',
};

type CoverageMap = Pick<MapboxMap, 'getLayer' | 'getSource' | 'addSource' | 'addLayer'>;
const installing = new WeakSet<CoverageMap>();

/** Install against the loaded style, not a React style selection that may
 * still be downloading. Dark-v11 has no such vector layer, so it stays alone.
 * Style changes remove these additions; the next styledata event restores
 * them only after the satellite style and its insertion target actually exist.
 */
export function installMusgraveImagery(map: CoverageMap): void {
    if (installing.has(map) || !map.getLayer(MUSGRAVE_IMAGERY.beforeId)) return;
    installing.add(map);
    try {
        if (!map.getSource('musgrave-satellite')) {
            map.addSource('musgrave-satellite', {
                type: 'raster',
                tiles: MUSGRAVE_IMAGERY.tiles,
                bounds: MUSGRAVE_IMAGERY.bounds,
                tileSize: MUSGRAVE_IMAGERY.tileSize,
                minzoom: MUSGRAVE_IMAGERY.minzoom,
                maxzoom: MUSGRAVE_IMAGERY.maxzoom,
                attribution: MUSGRAVE_IMAGERY.attribution,
            });
        }
        if (!map.getLayer('musgrave-satellite-layer')) {
            map.addLayer(
                {
                    id: 'musgrave-satellite-layer',
                    source: 'musgrave-satellite',
                    type: 'raster',
                    minzoom: MUSGRAVE_IMAGERY.minzoom,
                    paint: { 'raster-opacity': 1, 'raster-fade-duration': 250 },
                },
                MUSGRAVE_IMAGERY.beforeId,
            );
        }
    } finally {
        installing.delete(map);
    }
}
