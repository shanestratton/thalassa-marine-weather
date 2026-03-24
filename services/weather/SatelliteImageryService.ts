/**
 * SatelliteImageryService — Real-time satellite imagery tiles.
 *
 * Uses RealEarth (University of Wisconsin SSEC/CIMSS) XYZ tile API.
 * Free, CORS-enabled, no API key required, updates every 10-15 minutes.
 *
 * Product coverage:
 *   - globalir: Global composite IR from ALL geostationary sats (GOES-16/18, Himawari, Meteosat)
 *   - G16-ABI-FD-BAND13: GOES-16 Clean IR (Americas/Atlantic)
 *   - G18-ABI-FD-BAND13: GOES-18 Clean IR (Pacific)
 *   - MSG-SEVIRI-FD-IR10.8: Meteosat (Europe/Africa/Indian Ocean)
 *
 * The "globalir" product is the default — it stitches all satellites together,
 * so it works for tropical cyclones in ANY basin worldwide.
 */

import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SatelliteImagery');

// ── Tile URLs ─────────────────────────────────────────────
// RealEarth XYZ API: https://realearth.ssec.wisc.edu/doc/api.php

const TILE_SOURCES = {
    /** Global composite IR — all geostationary satellites merged. Best default. */
    'global-ir': 'https://realearth.ssec.wisc.edu/api/image?products=globalir&x={x}&y={y}&z={z}',
    /** GOES-16 Band 13 Clean IR — Americas + Atlantic */
    'goes-east-ir': 'https://realearth.ssec.wisc.edu/api/image?products=G16-ABI-FD-BAND13&x={x}&y={y}&z={z}',
    /** GOES-18 Band 13 Clean IR — Pacific */
    'goes-west-ir': 'https://realearth.ssec.wisc.edu/api/image?products=G18-ABI-FD-BAND13&x={x}&y={y}&z={z}',
    /** Meteosat SEVIRI IR10.8 — Europe, Africa, Indian Ocean */
    'meteosat-ir': 'https://realearth.ssec.wisc.edu/api/image?products=MSG-SEVIRI-FD-IR10.8&x={x}&y={y}&z={z}',
} as const;

export type SatelliteLayer = keyof typeof TILE_SOURCES;

const SOURCE_ID = 'noaa-satellite-source';
const LAYER_ID = 'noaa-satellite-layer';

// ── Basin → best satellite source ─────────────────────────

/**
 * Pick the best satellite product for a given cyclone basin.
 * Falls back to global-ir which covers everything.
 */
export function bestProductForBasin(basin: string): SatelliteLayer {
    const b = basin.toUpperCase();
    // Atlantic, Eastern Pacific, Central Pacific → GOES-East
    if (['L', 'AL', 'E', 'EP', 'C', 'CP'].includes(b)) return 'goes-east-ir';
    // Western Pacific → GOES-West (better Pacific coverage)
    if (['W', 'WP'].includes(b)) return 'goes-west-ir';
    // Australian / South Pacific → GOES-West (Himawari area, but GOES-18 extends further)
    if (['P', 'AU', 'SP'].includes(b)) return 'global-ir'; // Global composite best here
    // Indian Ocean → Meteosat
    if (['S', 'SI', 'A', 'B', 'IO', 'NI', 'BB', 'AS'].includes(b)) return 'meteosat-ir';
    // Default: global composite
    return 'global-ir';
}

// ── Public API ────────────────────────────────────────────

/**
 * Add a satellite tile layer to the map.
 * Places it below symbol layers (labels stay on top).
 */
export function addSatelliteLayer(map: mapboxgl.Map, type: SatelliteLayer = 'global-ir'): void {
    // Clean up existing layer if present
    removeSatelliteLayer(map);

    const tileUrl = TILE_SOURCES[type];
    log.info(`[SAT] Adding ${type} satellite layer`);

    map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        attribution: '© SSEC/CIMSS/NOAA',
    });

    // Insert below the first symbol layer so labels float above
    const firstSymbolLayer = map.getStyle()?.layers?.find((l) => l.type === 'symbol');

    map.addLayer(
        {
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            paint: {
                'raster-opacity': 0.75,
                'raster-fade-duration': 300,
            },
        },
        firstSymbolLayer?.id,
    );
}

/**
 * Remove the satellite layer if present.
 */
export function removeSatelliteLayer(map: mapboxgl.Map): void {
    try {
        if (map.getLayer(LAYER_ID)) {
            map.removeLayer(LAYER_ID);
        }
        if (map.getSource(SOURCE_ID)) {
            map.removeSource(SOURCE_ID);
        }
    } catch (e) {
        log.warn('[SAT] Error removing satellite layer:', e);
    }
}

/**
 * Set the opacity of the satellite overlay (0 = invisible, 1 = fully opaque).
 */
export function setSatelliteOpacity(map: mapboxgl.Map, opacity: number): void {
    if (map.getLayer(LAYER_ID)) {
        map.setPaintProperty(LAYER_ID, 'raster-opacity', Math.min(1, Math.max(0, opacity)));
    }
}

/**
 * Check if the satellite layer is currently active.
 */
export function isSatelliteActive(map: mapboxgl.Map): boolean {
    return !!map.getLayer(LAYER_ID);
}

/**
 * Switch between satellite layer types.
 */
export function switchSatelliteType(map: mapboxgl.Map, type: SatelliteLayer): void {
    const currentOpacity =
        (map.getLayer(LAYER_ID) && (map.getPaintProperty(LAYER_ID, 'raster-opacity') as number)) || 0.75;
    removeSatelliteLayer(map);
    addSatelliteLayer(map, type);
    setSatelliteOpacity(map, currentOpacity);
}
