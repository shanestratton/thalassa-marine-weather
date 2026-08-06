/**
 * Base tiles for the Leaflet maps on the Log page (LiveMiniMap and
 * TrackMapViewer).
 *
 * Why this exists
 * ───────────────
 * Those two maps were on Esri World Imagery while the whole rest of the app
 * renders Mapbox `satellite-streets-v12`. That is the difference the skipper
 * noticed: not just older imagery, but non-retina raster on a phone that shows
 * a crisp @2x chart one tab away, and no place labels, so a logged track sat on
 * anonymous blue. Pointing these at the SAME template the OBS chart already
 * uses (see useMapInit's Hybrid base) makes the log look like the app rather
 * than like a different decade.
 *
 * `@2x` and `512` are the point of the exercise: 512 px retina tiles are what
 * make it look sharp on a phone. `satellite-streets` rather than plain
 * `satellite` keeps coastline and place names, which is what a log entry
 * actually needs to be readable.
 *
 * Esri stays as the fallback, deliberately
 * ────────────────────────────────────────
 * A build with no Mapbox token must still draw a map. The token is optional
 * config (see MapboxDirectionsService), so falling back keeps the log working
 * on any build rather than replacing imagery with a grey void — which would be
 * a worse regression than dated tiles.
 *
 * ATTRIBUTION IS A LICENCE CONDITION, not decoration. The credit has to follow
 * whichever source actually drew the tiles, so it is returned alongside the URL
 * rather than hardcoded at the call site — that is exactly how the two drifted
 * out of sync before.
 */

const MAPBOX_SATELLITE_STREETS =
    'https://api.mapbox.com/styles/v1/mapbox/satellite-streets-v12/tiles/512/{z}/{x}/{y}@2x';

const ESRI_WORLD_IMAGERY =
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

export interface LogBaseTiles {
    /** Leaflet URL template, before piCache.leafletTileTemplate() wrapping. */
    url: string;
    attribution: string;
    maxZoom: number;
    /** True when the modern Mapbox base is in use. */
    isMapbox: boolean;
}

/**
 * Resolve the base layer for a Log-page map.
 *
 * Pass the same token the chart uses (`import.meta.env.VITE_MAPBOX_ACCESS_TOKEN`).
 * An absent or blank token silently selects Esri.
 */
export function logBaseTiles(mapboxToken?: string): LogBaseTiles {
    const token = (mapboxToken ?? '').trim();
    if (token) {
        return {
            url: `${MAPBOX_SATELLITE_STREETS}?access_token=${token}`,
            attribution:
                '&copy; <a href="https://www.mapbox.com/about/maps/" target="_blank" rel="noopener noreferrer">Mapbox</a> ' +
                '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a>',
            // satellite-streets-v12 serves to 22; Leaflet will overzoom past
            // the deepest imagery rather than showing nothing.
            maxZoom: 20,
            isMapbox: true,
        };
    }
    return {
        url: ESRI_WORLD_IMAGERY,
        attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
        maxZoom: 19,
        isMapbox: false,
    };
}
