/**
 * SatelliteImageryService — Real-time satellite imagery tiles.
 *
 * Multi-source enhanced IR satellite tiles for global storm monitoring:
 *
 * 1. **IEM (Iowa Environmental Mesonet)** — GOES-East & GOES-West
 *    Academic-grade WMS from Iowa State University. Serves colour-enhanced
 *    Band 13 (Clean Longwave IR) with cloud-top temperature colouring.
 *    Free, reliable, no API key. WMS 1.1.1, EPSG:3857.
 *    - GOES-East Full Disk: Atlantic, Americas, E Pacific (~15°W to ~135°W)
 *    - GOES-West Full Disk: Pacific, W Americas (~100°W to ~175°E)
 *
 * 2. **RealEarth (UW SSEC/CIMSS)** — Himawari-9
 *    XYZ tile API, Himawari-9 Band 13 GRAD (enhanced colour table).
 *    Full disk: W Pacific, Australia, Indian Ocean (~60°E to ~160°W)
 *    Free, CORS-enabled, no API key.
 *
 * Together these 3 satellites provide near-global enhanced IR coverage.
 */

import mapboxgl from 'mapbox-gl';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SatelliteImagery');

// ── Tile URLs ─────────────────────────────────────────────
// IEM WMS: https://mesonet.agron.iastate.edu/ogc/
// RealEarth XYZ: https://realearth.ssec.wisc.edu/doc/api.php

// Supabase Edge Function URL for proxied satellite tiles
const SUPABASE_URL = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';

const TILE_SOURCES = {
    /** GOES-East Full Disk enhanced IR — Atlantic, Americas, E Pacific (IEM WMS) */
    'goes-east-ir':
        'https://mesonet.agron.iastate.edu/cgi-bin/wms/goes_east.cgi?' +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=fulldisk_ch13' +
        '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE',

    /** GOES-West Full Disk enhanced IR — Pacific, W Americas, Australia (IEM WMS) */
    'goes-west-ir':
        'https://mesonet.agron.iastate.edu/cgi-bin/wms/goes_west.cgi?' +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=fulldisk_ch13' +
        '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE',

    /** Himawari-9 Band 13 Clean IR (enhanced color palette)
     *  Proxied via satellite-tile edge function → NASA GIBS
     *  Color-enhanced tiles (blues/greens/yellows), no rate limiting */
    'himawari-ir': `${SUPABASE_URL}/functions/v1/satellite-tile?sat=himawari&x={x}&y={y}&z={z}`,

    /** GMGSI Global Longwave IR — seamless composite of all geostationary sats
     *  (GOES-18 + GOES-19 + Himawari-9 + Meteosat-9 + Meteosat-10)
     *  nowCOAST GeoServer WMS — grayscale, hourly, full global coverage */
    'gmgsi-ir':
        'https://nowcoast.noaa.gov/geoserver/satellite/wms?' +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=global_longwave_imagery_mosaic' +
        '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE',

    /** Default: GOES-East as global fallback (best Americas/Atlantic coverage) */
    'global-ir':
        'https://mesonet.agron.iastate.edu/cgi-bin/wms/goes_east.cgi?' +
        'SERVICE=WMS&VERSION=1.1.1&REQUEST=GetMap&LAYERS=fulldisk_ch13' +
        '&SRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=TRUE',
} as Record<string, string>;

export type SatelliteLayer = 'goes-east-ir' | 'goes-west-ir' | 'himawari-ir' | 'gmgsi-ir' | 'global-ir';

const SOURCE_ID = 'noaa-satellite-source';
const LAYER_ID = 'noaa-satellite-layer';

// ── Basin → best satellite source ─────────────────────────

/**
 * Pick the best satellite product for a given cyclone basin.
 *
 * Basin codes (ATCF):
 *   L/AL = Atlantic, E/EP = Eastern Pacific, C/CP = Central Pacific
 *   W/WP = Western Pacific, P/AU/SP = Australian / South Pacific
 *   S/SI = South Indian Ocean, A/B/IO/NI = North Indian Ocean
 */
export function bestProductForBasin(basin: string): SatelliteLayer {
    const b = basin.toUpperCase();
    // Atlantic, Eastern Pacific, Central Pacific → GOES-East (IEM)
    if (['L', 'AL', 'E', 'EP', 'C', 'CP'].includes(b)) return 'goes-east-ir';
    // Western Pacific → Himawari-9 (RealEarth)
    if (['W', 'WP'].includes(b)) return 'himawari-ir';
    // Australian / South Pacific → Himawari-9 (covers SW Pacific well)
    if (['P', 'AU', 'SP'].includes(b)) return 'himawari-ir';
    // Indian Ocean → Himawari-9 (covers ~60°E westward edge)
    if (['S', 'SI', 'A', 'B', 'IO', 'NI', 'BB', 'AS'].includes(b)) return 'himawari-ir';
    // Default: GOES-East (best general coverage)
    return 'global-ir';
}

// ── Public API ────────────────────────────────────────────

/**
 * Add a satellite tile layer to the map.
 * Places it below symbol layers (labels stay on top).
 */
export function addSatelliteLayer(map: mapboxgl.Map, type: SatelliteLayer = 'global-ir', beforeId?: string): void {
    // Clean up existing layer if present
    removeSatelliteLayer(map);

    const tileUrl = TILE_SOURCES[type];
    const isWMS = tileUrl.includes('{bbox-epsg-3857}');
    log.info(`[SAT] Adding ${type} satellite layer (${isWMS ? 'WMS' : 'XYZ'})`);

    // Attribution based on source
    const attribution = isWMS
        ? '© <a href="https://mesonet.agron.iastate.edu/">IEM/Iowa State</a> · NOAA GOES'
        : '© SSEC/CIMSS · Himawari-9';

    map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [tileUrl],
        tileSize: 256,
        attribution,
    });

    // THE ANCHOR IS THE CALLER'S, NOT OURS (Shane 2026-08-23: "the cloud
    // layer is not there" on a first open, present on the next).
    //
    // This used to anchor on the style's first SYMBOL layer, which is not a
    // stable landmark here: useMapInit adds the opaque satellite raster with
    // `beforeId = encBottom`, and an undefined encBottom APPENDS IT TO THE
    // TOP. At the zoom the storm view opens at, over open ocean, no
    // `enc-vec-*` layer exists yet — so the imagery can sit above the first
    // symbol layer, and this raster went under it. Painting perfectly,
    // visible to nobody. Once ENC mounts and MapHub's ordering pass demotes
    // the imagery, the same code lands above it and the cloud appears.
    //
    // The caller knows where the imagery is (components/map/imageryOrder.ts);
    // a service must not guess. No import from components/ — hence the
    // parameter. Undefined keeps the old append-to-top behaviour for any
    // caller that has no opinion.
    map.addLayer(
        {
            id: LAYER_ID,
            type: 'raster',
            source: SOURCE_ID,
            paint: {
                'raster-opacity': 0.75,
                'raster-fade-duration': 0,
                'raster-resampling': 'nearest',
            },
        },
        beforeId,
    );

    // Says WHERE it landed. The anchor above is a reasoned fix for an
    // intermittent, first-open-only symptom that has never been observed at
    // runtime — so it ships with the measurement that confirms or kills it.
    // If LAYER_ID sits below satellite-base on a bad open and above it on a
    // good one, the anchor was the cause.
    const after = map.getStyle()?.layers?.map((l) => l.id) ?? [];
    log.info(
        `[SAT] ${type} at layer ${after.indexOf(LAYER_ID)}/${after.length}` +
            ` (satellite-base=${after.indexOf('satellite-base-layer')},` +
            ` hybrid-base=${after.indexOf('hybrid-base-layer')},` +
            ` encBottom=${after.findIndex((id) => id.startsWith('enc-vec-'))})`,
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
